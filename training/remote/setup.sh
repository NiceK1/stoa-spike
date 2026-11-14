#!/bin/bash
# One-time setup on the GPU instance: tools, Python env, CubiCasa5k annotations and the Stoa raster drawings.
set -u
mkdir -p /data/logs && cd /data
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq python3-venv unzip aria2 tmux >/dev/null 2>&1

(aria2c -x8 -s8 -q --allow-overwrite=true -o cubicasa5k.zip "https://zenodo.org/records/2613548/files/cubicasa5k.zip?download=1" \
  && unzip -q -o cubicasa5k.zip -d /data/cubi && echo CUBI_DONE) > /data/logs/cubi.log 2>&1 &

(aria2c -x8 -s8 -q --allow-overwrite=true -o stoa.zip "https://fwjydgxpttajiqpfmqtj.supabase.co/storage/v1/object/public/stoa-junction-2026/junction-dataset.zip" \
  && unzip -q -o stoa.zip '*/questions.jsonl' '*/README.md' '*/data/cubicasa5k/*' -d /data/stoa && echo STOA_DONE) > /data/logs/stoa.log 2>&1 &

(python3 -m venv /data/venv && /data/venv/bin/pip install -q --upgrade pip \
  && /data/venv/bin/pip install -q ultralytics onnx onnxruntime onnxslim lxml tqdm shapely && echo ENV_DONE) > /data/logs/env.log 2>&1 &
wait
echo SETUP_FINISHED
