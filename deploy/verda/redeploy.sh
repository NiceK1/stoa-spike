#!/usr/bin/env bash
# Brings the demo set up by setup.sh to the head of main and restarts it.
#
#   deploy/verda/redeploy.sh <ssh destination> [--models] [--warm]
#
# --models also takes the detector weights and the interpreter again from where they are produced on the instance:
# DETECTORS_SRC (default /data/export) and INTERPRETER_SRC (default /data/gemma/gguf/fg270m-real-q8_0.gguf).
# --warm asks one question about every image plan of the demo, so that the detectors' results are cached.
# Also read from the environment: SSH_OPTS (options for ssh), BRANCH.
set -euo pipefail

if [ "${1:-}" != --on-host ]; then
  [ $# -ge 1 ] || { echo "usage: $0 <ssh destination> [--models] [--warm]" >&2; exit 2; }
  dest=$1
  shift
  forwarded=
  for name in BRANCH DETECTORS_SRC INTERPRETER_SRC; do
    [ -z "${!name:-}" ] || forwarded+=" $name=$(printf %q "${!name}")"
  done
  # The script is saved on the instance before it runs, so that no command in it can swallow the rest from stdin.
  # shellcheck disable=SC2086
  tr -d '\r' < "$0" | ssh ${SSH_OPTS:-} "$dest" "f=\$(mktemp) && cat >\"\$f\" && $forwarded bash \"\$f\" --on-host $*; rc=\$?; rm -f \"\$f\"; exit \$rc"
  exit
fi
shift

models=no
warm=no
for option in "$@"; do
  case $option in
    --models) models=yes ;;
    --warm) warm=yes ;;
    *) echo "unknown option: $option" >&2; exit 2 ;;
  esac
done

root=/srv/blueline
user=blueline
port=18787
repo=$root/repo
store=$root/models
branch=${BRANCH:-main}

as_user() { runuser -u "$user" -- env HOME="$root" PATH="$root/node/bin:/usr/bin:/bin" GIT_LFS_SKIP_SMUDGE=1 nice -n 10 "$@"; }

echo "== code"
as_user git -C "$repo" fetch --quiet --depth 1 origin "$branch"
# Also puts back the Git LFS pointers of the detector weights, which are replaced by the real files below.
as_user git -C "$repo" reset --quiet --hard FETCH_HEAD
as_user git -C "$repo" log -1 --format='%h %s (%cd)' --date=iso-local
weights=$(as_user git -C "$repo" ls-files 'models/*.onnx')

if [ $models = yes ]; then
  echo "== models"
  for path in $weights; do
    source_file=${DETECTORS_SRC:-/data/export}/$(basename "$path")
    expected=$(as_user git -C "$repo" show "HEAD:$path" | sed -n 's/^oid sha256://p')
    [ "$(sha256sum "$source_file" | cut -d' ' -f1)" = "$expected" ] || { echo "$source_file is not the file main points to" >&2; exit 1; }
    install -o "$user" -g "$user" -m 644 "$source_file" "$store/$(basename "$path")"
  done
  interpreter=${INTERPRETER_SRC:-/data/gemma/gguf/fg270m-real-q8_0.gguf}
  # A training run rewrites this file when it ends: take it only when it is whole and at rest.
  stamp() { stat -c '%s %Y' "$interpreter"; }
  before=$(stamp)
  sleep 3
  install -o "$user" -g "$user" -m 644 "$interpreter" "$store/interpreter/incoming.gguf"
  if [ "$(head -c 4 "$store/interpreter/incoming.gguf")" != GGUF ] || [ "$(stamp)" != "$before" ]; then
    rm -f "$store/interpreter/incoming.gguf"
    echo "$interpreter is being written or is not a GGUF file: the interpreter was left as it is" >&2
  else
    mv "$store/interpreter/incoming.gguf" "$store/interpreter/interpreter-q8_0.gguf"
  fi
fi

for path in $weights; do
  as_user ln -f "$store/$(basename "$path")" "$repo/$path"
done
as_user mkdir -p "$repo/models/interpreter"
as_user ln -f "$store/interpreter/interpreter-q8_0.gguf" "$repo/models/interpreter/interpreter-q8_0.gguf"
(cd "$store" && sha256sum -- *.onnx interpreter/*.gguf)

echo "== build"
cd "$repo/app"
lock=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$lock" != "$(cat "$root/.lock-installed" 2>/dev/null)" ]; then
  as_user npm ci --no-audit --no-fund || {
    echo "npm ci refused the lock file: installing with npm install instead" >&2
    as_user npm install --no-audit --no-fund
  }
  echo "$lock" > "$root/.lock-installed"
fi
as_user npm run --silent build

echo "== restart"
systemctl restart blueline
healthy=no
for _ in $(seq 60); do
  if curl -fsS "http://127.0.0.1:$port/api/health" 2>/dev/null; then healthy=yes; break; fi
  sleep 1
done
echo
if [ $healthy = no ]; then
  echo "the server did not answer /api/health within a minute" >&2
  journalctl -u blueline -n 30 --no-pager >&2
  exit 1
fi

if [ $warm = yes ]; then
  echo "== warming the detectors' cache"
  # The first question about an image plan runs both detectors on it, which takes seconds under the CPU cap.
  # The result is cached, so one question per plan now spares every visitor that wait.
  curl -fsS "http://127.0.0.1:$port/api/dataset" | python3 -I -c '
import json, sys
for source in json.load(sys.stdin)["sources"]:
    for file in source["files"]:
        if file["path"].lower().endswith((".png", ".jpg", ".jpeg")):
            print(file["path"])' > "$root/.warm-list"
  done=0
  while IFS= read -r path; do
    curl -fsS -o /dev/null -X POST "http://127.0.0.1:$port/api/ask" -H 'content-type: application/json' \
      -d "{\"path\": \"$path\", \"question\": \"How many doors are there?\"}" || echo "no answer for $path" >&2
    done=$((done + 1))
    [ $((done % 20)) -ne 0 ] || echo "$done of $(wc -l < "$root/.warm-list") image plans"
  done < "$root/.warm-list"
  rm -f "$root/.warm-list"
fi
