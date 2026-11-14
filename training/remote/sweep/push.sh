#!/bin/bash
# Copies results, detections, logs and best weights to the instance that outlives this one, every two minutes.
# Usage: push.sh <user@host of the long-lived instance> <ssh key>
set -u
target=$1; key=$2
cd /data/sweep
while true; do
  /data/venv/bin/python status.py --write 8 > /dev/null 2>&1
  rsync -a --prune-empty-dirs -e "ssh -i $key -o StrictHostKeyChecking=no -o ConnectTimeout=20" \
    --include='results/***' --include='eval/***' --include='logs/***' --include='status8.*' \
    --include='runs/' --include='runs/*/' --include='runs/*/weights/' --include='runs/*/weights/best.pt' \
    --include='runs/*/args.yaml' --include='runs/*/results.csv' --exclude='*' \
    /data/sweep/ "$target:/data/sweep/" >> /data/sweep/logs/push.log 2>&1
  echo "$(date -u +%H:%M:%S) pushed, exit $?" >> /data/sweep/logs/push.log
  sleep 120
done
