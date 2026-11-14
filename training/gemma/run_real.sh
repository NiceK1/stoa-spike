#!/bin/bash
# The real run: waits until the detector job has left the GPU, then untuned score, fine-tune, tuned score, GGUF.
# usage: [SKIP_UNTUNED=1] run_real.sh [epochs=2] [batch=24]
# Batch 32 runs out of the 80 GB on the longest IFC menus (1,400 tokens); batch 24 peaks near 57 GB.
cd /data/gemma
PY="venv/bin/python"
BASE=models/unsloth__functiongemma-270m-it
OUT=out/fg270m-real
EPOCHS=${1:-2}
BATCH=${2:-24}
while /data/venv/bin/python /data/sweep/status.py | grep -q "^ACTIVE [1-9]"; do sleep 20; done
echo "== gpu free $(date +%T)"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
echo "== untuned eval $(date +%T)"
[ -n "$SKIP_UNTUNED" ] || $PY eval_interpreter.py --model $BASE --heldout data/test.jsonl --limit 200 --max-new-tokens 120 --predictions-out out/real_pred_untuned.jsonl \
  --constrained-limit 0 2>&1 | grep -vE "Warning|max_new_tokens|Loading weights"
echo "== train $(date +%T)"
$PY train_interpreter.py --model $BASE --train data/train.jsonl --out $OUT --epochs $EPOCHS --batch-size $BATCH --max-length 1536 \
  2>&1 | grep -vE "Warning|Loading weights"
echo "== tuned eval $(date +%T)"
$PY eval_interpreter.py --model $OUT --heldout data/test.jsonl --predictions-out out/real_pred_tuned.jsonl --parity-out out/real_parity.json \
  --constrained-limit 0 --batch-size 64 2>&1 | grep -vE "Warning|max_new_tokens|Loading weights"
echo "== convert $(date +%T)"
./convert_to_gguf.sh $OUT $BASE gguf/fg270m-real 2>&1 | tail -3
echo "REAL_DONE $(date +%T)"
