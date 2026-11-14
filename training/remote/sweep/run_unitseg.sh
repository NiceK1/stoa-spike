#!/bin/bash
# Queue job (worker.py "script"): train the unit mask model, gate base's detections with its masks, export it.
# Usage: run_unitseg.sh [run name]. Writes /data/sweep/results/<run>.json.
set -u
name=${1:-unitseg}
py=/data/venv/bin/python
logs=/data/sweep/logs
cd /data
[ -f /data/sweep/data/yolo_unitseg/data.yaml ] || $py sweep/unitseg.py build > $logs/build_unitseg.log 2>&1
# The detector took 41 GB at batch 16; with under 50 GB free (another process on the GPU) the run starts at 8.
free=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -1)
batch=16
[ "$free" -lt 50000 ] && batch=8
while true; do
  rm -rf "/data/sweep/runs/$name"
  $py train.py "$name" yolo11l-seg.pt 1280 60 $batch data=/data/sweep/data/yolo_unitseg/data.yaml project=/data/sweep/runs \
    fliplr=0.5 flipud=0.5 > "$logs/$name.log" 2>&1
  code=$?
  echo "TRAIN_EXIT $code" >> "$logs/$name.log"
  [ $code -ne 0 ] && [ $batch -gt 4 ] && grep -qi "out of memory" "$logs/$name.log" || break
  batch=$((batch / 2))
done
$py sweep/unitseg.py eval "$name" $code $batch > "$logs/eval_$name.log" 2>&1
$py sweep/unitseg.py export "$name" > "$logs/export_$name.log" 2>&1
echo PIPELINE_DONE >> "$logs/export_$name.log"
