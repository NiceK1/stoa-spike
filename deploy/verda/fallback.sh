#!/usr/bin/env bash
# Lets the deployed demo use outside models where our own are not yet as good: copies the API keys from a local env
# file to a root-only file on the instance and sets which model reads drawings and which interprets questions.
#
#   deploy/verda/fallback.sh <ssh destination> on <env file with the keys>
#   deploy/verda/fallback.sh <ssh destination> off          our own models only again; the keys are removed
#
# Read from the environment (defaults in brackets): VISION_PROVIDER [gemini-api], VISION_MODEL [gemini-4-hydrogen],
# PLANNER_PROVIDER [anthropic-api], PLANNER_MODEL [claude-haiku-5-5], RASTER_DETECTOR_TARGETS [symbols], SSH_OPTS.
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
Environment=RASTER_DETECTOR_TARGETS=${RASTER_DETECTOR_TARGETS:-symbols}
# The service is otherwise confined to localhost; the outside models need the network.
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

remote "systemctl daemon-reload && systemctl restart blueline && for i in \$(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:$port/api/health && break; sleep 1; done; echo"
