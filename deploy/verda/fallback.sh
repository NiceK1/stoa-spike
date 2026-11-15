#!/usr/bin/env bash
# Makes the outside engines available on the deployed demo: copies the API keys from a local env file to a root-only
# file on the instance and opens the service's network. The default mode stays Blueline only, which calls none of
# them; they are used when a visitor picks Best accuracy or Custom (app/README.md, Modes).
#
#   deploy/verda/fallback.sh <ssh destination> on <env file with the keys>
#   deploy/verda/fallback.sh <ssh destination> off          the Blueline engines only again; the keys are removed
#
# Which engines can run follows from the keys: ANTHROPIC_API_KEY gives Claude Haiku 5.5 and Claude Sonnet 5.5,
# GEMINI_API_KEY gives Gemini 4 Hydrogen; a key that is not in the env file leaves its engines out.
# The provider variables are for scripts run on the instance without --mode, and keep the claude CLI out of the
# line-up (defaults in brackets): VISION_PROVIDER [gemini-api], VISION_MODEL [gemini-4-hydrogen],
# PLANNER_PROVIDER [anthropic-api], PLANNER_MODEL [claude-haiku-5-5]. SSH_OPTS passes options to ssh.
# The keys never enter the repository or the service's files: systemd reads them as root and passes them to the process.
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: $0 <ssh destination> on <env file> | off" >&2; exit 2; }
dest=$1
mode=$2
remote() { ssh ${SSH_OPTS:-} "$dest" "$@"; }
dropin=/etc/systemd/system/blueline.service.d/fallback.conf
keys=/etc/blueline/keys.env
port=18787

case $mode in
on)
  [ $# -ge 3 ] && [ -f "$3" ] || { echo "the env file with the keys is missing" >&2; exit 2; }
  grep -E '^(GEMINI_API_KEY|ANTHROPIC_API_KEY)=' "$3" | tr -d '\r' \
    | remote "umask 077 && install -d -m 700 /etc/blueline && cat > $keys && chmod 600 $keys && echo \"keys stored: \$(cut -d= -f1 $keys | tr '\n' ' ')\""
  remote "install -d -m 755 $(dirname $dropin) && cat > $dropin" <<EOF
[Service]
EnvironmentFile=$keys
Environment=VISION_PROVIDER=${VISION_PROVIDER:-gemini-api}
Environment=VISION_MODEL=${VISION_MODEL:-gemini-4-hydrogen}
Environment=PLANNER_PROVIDER=${PLANNER_PROVIDER:-anthropic-api}
Environment=PLANNER_MODEL=${PLANNER_MODEL:-claude-haiku-5-5}
# The service is otherwise confined to localhost; the outside engines need the network.
IPAddressDeny=
IPAddressAllow=any
EOF
  ;;
off)
  remote "rm -f $dropin $keys"
  ;;
*)
  echo "unknown mode: $mode" >&2; exit 2 ;;
esac

# After the restart: the default mode, then what each mode resolves to on the instance.
remote "systemctl daemon-reload && systemctl restart blueline && for i in \$(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:$port/api/health && break; sleep 1; done; echo; curl -fsS -m 5 http://127.0.0.1:$port/api/modes | grep -o '\"summary\":\"[^\"]*\"' || echo 'no /api/modes on the instance: run redeploy.sh first'"
