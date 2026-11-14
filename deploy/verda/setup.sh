#!/usr/bin/env bash
# Sets up the Blueline demo on a Verda Ubuntu instance, with local models only. Safe to run again.
#
#   deploy/verda/setup.sh <ssh destination> [site host name]
#
# Without a site name, an instance given by its IPv4 address is served as <a-b-c-d>.sslip.io.
# Read from the environment: SSH_OPTS (options for ssh), REPO_URL (default: this clone's origin), BRANCH,
# DATASET_SRC (the unzipped dataset on the instance, default: searched under /data/stoa), DATASET_ZIP (its archive,
# default /data/stoa.zip, for sources that were not unzipped), REBUILD_DATASET=1, NPM_VERSION, PRIVATE_PATHS (folders the demo's user is locked out of, default /data), and what redeploy.sh reads.
set -euo pipefail

if [ "${1:-}" != --on-host ]; then
  [ $# -ge 1 ] || { echo "usage: $0 <ssh destination> [site host name]" >&2; exit 2; }
  here=$(cd "$(dirname "$0")" && pwd)
  dest=$1
  host=${dest#*@}
  site=${2:-}
  if [ -z "$site" ]; then
    case $host in *[!0-9.]*) site=$host ;; *) site=${host//./-}.sslip.io ;; esac
  fi
  # The instance clones over https, whatever protocol this clone uses.
  REPO_URL=${REPO_URL:-$(git -C "$here" config --get remote.origin.url | sed -E 's#^git@([^:]+):#https://\1/#')}
  forwarded=
  for name in REPO_URL BRANCH DATASET_SRC DATASET_ZIP REBUILD_DATASET PRIVATE_PATHS NPM_VERSION; do
    [ -z "${!name:-}" ] || forwarded+=" $name=$(printf %q "${!name}")"
  done
  # The script is saved on the instance before it runs, so that no command in it can swallow the rest from stdin.
  # shellcheck disable=SC2086
  tr -d '\r' < "$0" | ssh ${SSH_OPTS:-} "$dest" "f=\$(mktemp) && cat >\"\$f\" && $forwarded bash \"\$f\" --on-host $(printf %q "$site"); rc=\$?; rm -f \"\$f\"; exit \$rc"
  exec bash "$here/redeploy.sh" "$dest" --models --warm
fi

site=$2
root=/srv/blueline
user=blueline
port=18787
repo=$root/repo
cache=$repo/app/.cache
branch=${BRANCH:-main}
# NEEDRESTART_SUSPEND: installing a package must not restart services other people run on this instance.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
apt="apt-get -o DPkg::Lock::Timeout=120 -q"

as_user() { runuser -u "$user" -- env HOME="$root" PATH="$root/node/bin:/usr/bin:/bin" GIT_LFS_SKIP_SMUDGE=1 nice -n 10 "$@"; }

echo "== packages"
packages=()
command -v git >/dev/null || packages+=(git)
command -v curl >/dev/null || packages+=(curl)
command -v xz >/dev/null || packages+=(xz-utils)
command -v setfacl >/dev/null || packages+=(acl)
command -v gpg >/dev/null || packages+=(gnupg)
if [ ${#packages[@]} -gt 0 ]; then
  $apt update
  $apt install -y --no-install-recommends "${packages[@]}"
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  $apt update
  $apt install -y --no-install-recommends caddy
fi

echo "== user and folders"
id "$user" >/dev/null 2>&1 || useradd --system --home-dir "$root" --no-create-home --shell /usr/sbin/nologin "$user"
install -d -o "$user" -g "$user" -m 755 "$root" "$root/models" "$root/models/interpreter"
for path in ${PRIVATE_PATHS:-/data}; do
  if [ -d "$path" ]; then setfacl -m "u:$user:---" "$path"; fi
done

echo "== Node 22"
if ! "$root/node/bin/node" --version 2>/dev/null | grep -q '^v22\.'; then
  sums=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)
  tarball=$(awk '/linux-x64\.tar\.xz$/ { print $2 }' <<<"$sums")
  curl -fsSL -o "/tmp/$tarball" "https://nodejs.org/dist/latest-v22.x/$tarball"
  (cd /tmp && grep " $tarball\$" <<<"$sums" | sha256sum --check --quiet -)
  rm -rf "$root/node" && mkdir "$root/node"
  tar -xJf "/tmp/$tarball" -C "$root/node" --strip-components=1 --no-same-owner
  rm -f "/tmp/$tarball"
fi
# package-lock.json is written by npm 11.6. The npm 10.9 that Node 22 brings and npm 11.21 both call it out of sync
# (two @emnapi packages missing) and refuse `npm ci`.
npm_version=${NPM_VERSION:-11.6.2}
if [ "$(PATH="$root/node/bin:$PATH" npm --version)" != "$npm_version" ]; then
  PATH="$root/node/bin:$PATH" npm install --global --silent --no-audit --no-fund "npm@$npm_version"
fi
echo "node $("$root/node/bin/node" --version), npm $(PATH="$root/node/bin:$PATH" npm --version)"

echo "== repository"
if [ ! -d "$repo/.git" ]; then
  as_user git clone --quiet --depth 1 --branch "$branch" "$REPO_URL" "$repo"
fi
install -d -o "$user" -g "$user" -m 750 "$cache"

echo "== dataset subset"
if [ ! -f "$root/dataset/questions.jsonl" ] || [ "${REBUILD_DATASET:-}" = 1 ]; then
  source_dir=${DATASET_SRC:-$(dirname "$(find /data/stoa -maxdepth 3 -name questions.jsonl -print -quit 2>/dev/null)")}
  [ -f "$source_dir/questions.jsonl" ] || { echo "no dataset found: set DATASET_SRC to the folder that holds questions.jsonl" >&2; exit 1; }
  build=$root/.bundle
  rm -rf "$build" && install -d -o nobody -g nogroup "$build" "$build/source" "$build/source/data"
  ln -s "$source_dir/questions.jsonl" "$source_dir/README.md" "$build/source/"
  # The sources build_bundle.py draws from. One that was never unzipped on the instance comes out of the archive.
  for name in cubicasa5k swiss_dwellings ifc_models; do
    if [ ! -d "$source_dir/data/$name" ]; then
      command -v unzip >/dev/null || $apt install -y --no-install-recommends unzip
      runuser -u nobody -- nice -n 10 unzip -q "${DATASET_ZIP:-/data/stoa.zip}" "*/data/$name/*" -d "$build/unzipped"
    fi
    ln -s "$(find "$source_dir/data" "$build/unzipped" -type d -path "*/data/$name" -print -quit 2>/dev/null)" "$build/source/data/$name"
  done
  # The same selection as the Hugging Face bundle. It asks git for the app's files, and this clone belongs to
  # another user than the one it runs as.
  runuser -u nobody -- env HOME="$build" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$repo" \
    nice -n 10 python3 -I "$repo/deploy/hf-space/build_bundle.py" "$build/source" "$build/out" | tee "$root/subset.txt"
  rm -rf "$root/dataset"
  mv "$build/out/dataset" "$root/dataset"
  chown -R "$user:$user" "$root/dataset" "$root/subset.txt"
  rm -rf "$build"
fi
cat "$root/subset.txt"

echo "== services"
mount_unit=$(systemd-escape --path --suffix=mount "$cache")
cat > "/etc/systemd/system/$mount_unit" <<EOF
[Unit]
Description=Blueline cache and uploads, capped in size

[Mount]
What=tmpfs
Where=$cache
Type=tmpfs
Options=size=2g,mode=0750,uid=$(id -u "$user"),gid=$(id -g "$user"),nosuid,nodev,noexec

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/blueline.service <<EOF
[Unit]
Description=Blueline take-off demo, local models only
After=network.target
RequiresMountsFor=$cache

[Service]
User=$user
Group=$user
WorkingDirectory=$repo/app
Environment=HOST=127.0.0.1 PORT=$port STOA_DATASET=$root/dataset
Environment=VISION_PROVIDER=none DETECTOR=onnx RASTER_DETECTOR_TARGETS=all RASTER_SYMBOL_VOTE=off
Environment=PLANNER_PROVIDER=gemma-local PLANNER_THREADS=6
ExecStart=$root/node/bin/node --import tsx server/src/server.ts
Restart=always
RestartSec=3

# Training runs on this instance: the demo yields to it.
Nice=10
CPUWeight=20
CPUQuota=600%
MemoryHigh=10G
MemoryMax=12G
TasksMax=512

# Anyone can reach this process. It writes to its cache only, sees neither other people's data nor home
# folders, and can talk to this machine only, so it cannot call a model elsewhere.
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$cache
ProtectHome=yes
InaccessiblePaths=$(for path in ${PRIVATE_PATHS:-/data}; do printf -- '-%s ' "$path"; done)
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressAllow=localhost
IPAddressDeny=any
SystemCallArchitectures=native
UMask=0027

[Install]
WantedBy=multi-user.target
EOF

install -d -m 755 "$root/bin"
cat > "$root/bin/clean-cache" <<'EOF'
#!/bin/sh
# Uploads older than a day go; when the cache is nearly full, its oldest files go first.
cache=$1
if [ -d "$cache/uploads" ]; then
  find "$cache/uploads" -mindepth 1 -type f -mmin +1440 -delete
  find "$cache/uploads" -mindepth 1 -type d -empty -mmin +5 -delete
fi
used() { df --output=pcent "$cache" | tail -1 | tr -dc 0-9; }
if [ "$(used)" -ge 80 ]; then
  find "$cache" -type f -printf '%T@ %p\n' | sort -n | cut -d' ' -f2- | while IFS= read -r file; do
    [ "$(used)" -ge 60 ] || break
    rm -f -- "$file"
  done
fi
EOF
chmod 755 "$root/bin/clean-cache"

cat > /etc/systemd/system/blueline-clean.service <<EOF
[Unit]
Description=Blueline cache clean-up
RequiresMountsFor=$cache

[Service]
Type=oneshot
User=$user
Group=$user
Nice=10
ExecStart=$root/bin/clean-cache $cache
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$cache
ProtectHome=yes
InaccessiblePaths=$(for path in ${PRIVATE_PATHS:-/data}; do printf -- '-%s ' "$path"; done)
PrivateTmp=yes
EOF

cat > /etc/systemd/system/blueline-clean.timer <<EOF
[Unit]
Description=Blueline cache clean-up, every quarter of an hour

[Timer]
OnCalendar=*:0/15
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
EOF

# Caddy gets the certificate by itself and redirects http to https.
cat > /etc/caddy/Caddyfile <<EOF
$site {
	encode zstd gzip
	request_body {
		max_size 30MB
	}
	reverse_proxy 127.0.0.1:$port
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "the Caddyfile does not validate" >&2; exit 1; }

systemctl daemon-reload
systemctl enable --quiet --now "$mount_unit" blueline-clean.timer caddy
systemctl enable --quiet blueline
systemctl reload caddy
echo "== set up; the site will be https://$site"
