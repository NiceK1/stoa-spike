#!/bin/bash
# Train, score on the held-out split and export in one unattended chain, so the weights exist even if nobody is watching.
# Usage: run_all.sh <run name> <start weights> <imgsz> <epochs> <batch> <dataset dir> <export name, or - for none> [train key=value ...]
# Environment (all optional):
#   STOA_OUT            where runs/, eval/, logs/ and export/ go (default /data)
#   STOA_PART=dev       score the dev drawings of a sweep dataset instead of the test split
#   STOA_FLOOR          lowest confidence kept in the saved detections (default 0.05)
#   STOA_TRAIN_SECONDS  stop training after this long and score the best weights reached
set -u
name=$1; weights=$2; imgsz=$3; epochs=$4; batch=$5; data=$6; export_name=$7; shift 7
out=${STOA_OUT:-/data}; part=${STOA_PART:-test}
report_dir="$out/eval/$name"
[ "$out" = /data ] && [ "$part" = test ] && report_dir="/data/eval/$name-$imgsz-iou0.6"
cd /data
mkdir -p "$out/logs"
export STOA_DATA=$data STOA_OUT=$out
limit=()
[ -n "${STOA_TRAIN_SECONDS:-}" ] && limit=(timeout -s INT -k 120 "$STOA_TRAIN_SECONDS")
"${limit[@]}" /data/venv/bin/python train.py "$name" "$weights" "$imgsz" "$epochs" "$batch" data="$data/data.yaml" project="$out/runs" "$@" > "$out/logs/$name.log" 2>&1
echo "TRAIN_EXIT $?" >> "$out/logs/$name.log"
/data/venv/bin/python eval_counts.py "$out/runs/$name/weights/best.pt" "$imgsz" 0.6 "$name" part="$part" floor="${STOA_FLOOR:-0.05}" out="$report_dir" > "$out/logs/eval_$name.log" 2>&1
if [ "$export_name" != - ]; then
  /data/venv/bin/python export_onnx.py "$out/runs/$name/weights/best.pt" "$imgsz" "$export_name" "$report_dir/report.json" > "$out/logs/export_$name.log" 2>&1
fi
echo PIPELINE_DONE >> "$out/logs/export_$name.log"
