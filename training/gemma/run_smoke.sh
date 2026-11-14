#!/bin/bash
# Feasibility run on the shared A100: untuned score, fine-tune, tuned score. Low priority, capped GPU memory.
cd /data/gemma
PY="nice -n 15 venv/bin/python"
BASE=models/unsloth__functiongemma-270m-it
OUT=out/fg270m-standin
DATA="--heldout data/standin_heldout.jsonl --schema standin_schema.json"
det() { tail -c 400 /data/sweep/logs/y26l.log | tr "\r" "\n" | tail -1 | grep -oE "^.{0,12}[0-9]+/60|[0-9.]+(it/s|s/it)" | tr "\n" " "; }

echo "detector before: $(det)"
echo "== untuned eval $(date +%T)"
$PY eval_interpreter.py --model $BASE $DATA --predictions-out out/pred_untuned.jsonl --parity-out out/parity.json \
  --constrained-limit 0 --max-gpu-gb 6 2>&1 | grep -vE "Warning|max_new_tokens|Loading weights"
echo "== train $(date +%T)"
( while true; do echo "detector during: $(date +%T) $(det) gpu $(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader | tr '\n' ';')"; sleep 8; done ) & WATCH=$!
$PY train_interpreter.py --model $BASE --train data/standin_train.jsonl --schema standin_schema.json --out $OUT \
  --epochs 2 --batch-size 16 --max-gpu-gb 12 2>&1 | grep -vE "Warning|Loading weights"
kill $WATCH
echo "== tuned eval $(date +%T)"
$PY eval_interpreter.py --model $OUT $DATA --predictions-out out/pred_tuned.jsonl \
  --constrained-limit 50 --max-gpu-gb 6 2>&1 | grep -vE "Warning|max_new_tokens|Loading weights"
echo "detector after: $(det)"
echo "SMOKE_DONE $(date +%T)"
