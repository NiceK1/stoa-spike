#!/bin/bash
# Copies results, detections, logs, exports and weights to the instance that outlives this one, every two minutes.
# Besides best.pt it carries last.pt, the checkpoint Ultralytics rewrites every epoch, so that a run cut off here
# (spot eviction, teardown) can be finished there.
# Usage: push.sh <user@host of the long-lived instance> <ssh key>
set -u
target=$1; key=$2
remote="ssh -i $key -o StrictHostKeyChecking=no -o ConnectTimeout=20"
cd /data/sweep
while true; do
  /data/venv/bin/python status.py --write 8 > /dev/null 2>&1
  # Weights travel from a copy taken once the file has been still for 10 s: a checkpoint read while it is being
  # written would replace a whole one on the other side.
  for f in runs/*/weights/last.pt runs/*/weights/best.pt; do
    [ -f "$f" ] || continue
    if [ $(( $(date +%s) - $(stat -c %Y "$f") )) -ge 10 ] && [ "$f" -nt ".push/$f" ]; then
      mkdir -p ".push/$(dirname "$f")" && cp -p "$f" ".push/$f.tmp" && mv ".push/$f.tmp" ".push/$f"
    fi
  done
  # The other instance keeps worker and push logs of its own under the same names.
  rsync -a --prune-empty-dirs -e "$remote" \
    --exclude='logs/worker*.log' --exclude='logs/push.log' \
    --include='results/***' --include='eval/***' --include='logs/***' --include='export/***' --include='status8.*' \
    --include='runs/' --include='runs/*/' --include='runs/*/args.yaml' --include='runs/*/results.csv' --exclude='*' \
    /data/sweep/ "$target:/data/sweep/" >> /data/sweep/logs/push.log 2>&1
  files=$?
  weights=0
  if [ -d .push/runs ]; then
    rsync -rt --omit-dir-times -e "$remote" --exclude='*.tmp' .push/runs/ "$target:/data/sweep/runs/" >> /data/sweep/logs/push.log 2>&1
    weights=$?
  fi
  echo "$(date -u +%H:%M:%S) pushed, exit $files (files) $weights (weights)" >> /data/sweep/logs/push.log
  sleep 120
done
