#!/bin/bash
# Queue job (worker.py "script"): RF-DETR medium at 1280 on the symbols dataset, scored like the YOLO runs.
# Usage: run_rfdetr.sh [run name]. Writes /data/sweep/results/rfdetr.json.
# Environment (optional):
#   RFDETR_EPOCHS         epochs (default 30; one epoch measured 4.2 min alone on the A100)
#   RFDETR_TRAIN_SECONDS  training is interrupted after this long and the best checkpoint so far is scored (default 3.3 h)
set -u
py=/data/round3/venv-rfdetr/bin/python
logs=/data/sweep/logs
out=/data/round3/rfdetr/out
epochs=${RFDETR_EPOCHS:-30}
cd /data/round3/rfdetr
[ -f data/train/_annotations.coco.json ] || /data/venv/bin/python /data/sweep/rfdetr_data.py > $logs/rfdetr_data.log 2>&1
rm -rf "$out" /data/sweep/results/rfdetr.json
mkdir -p "$out"
started=$(date +%s)
# Batch 4 with gradients accumulated over 4 steps: the 16 drawings per update of the YOLO runs.
timeout -s INT -k 120 "${RFDETR_TRAIN_SECONDS:-11880}" $py /data/sweep/rfdetr_run.py train "$epochs" 4 4 > $logs/rfdetr.log 2>&1
code=$?
echo "TRAIN_EXIT $code" >> $logs/rfdetr.log
echo "$started $(date +%s) $code $epochs" > "$out/train_time.txt"
$py /data/sweep/rfdetr_run.py eval > $logs/eval_rfdetr.log 2>&1
$py /data/sweep/rfdetr_run.py export > $logs/export_rfdetr.log 2>&1
echo PIPELINE_DONE >> $logs/export_rfdetr.log
