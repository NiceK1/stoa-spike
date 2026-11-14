# An open vision model on our own GPUs

Gemma 4 (Apache 2.0, image input) served by vLLM with an OpenAI-compatible API. The app reaches it with
`VISION_PROVIDER=openai-compatible` (see "A vision model we host ourselves" in `app/README.md`).
The weights download from Hugging Face without a token (checked 14 Nov 2026 for `google/gemma-4-12B-it`,
`google/gemma-4-31B-it`, `google/gemma-4-31B-it-qat-w4a16-ct`, `google/gemma-4-26B-A4B-it`, `google/gemma-4-E4B-it`).

Everything lives under `/data/vlm` on the GPU machine: its own `uv`, its own Python, its own virtual environment,
the weights and the logs. Nothing else on the machine is touched.

## 1. Environment (once per machine, about 2 minutes)

`/data/vlm/setup.sh`:

```bash
#!/bin/bash
set -e
mkdir -p /data/vlm/bin /data/vlm/hf /data/vlm/logs
cd /data/vlm
export UV_INSTALL_DIR=/data/vlm/bin UV_NO_MODIFY_PATH=1 UV_CACHE_DIR=/data/vlm/uv-cache UV_PYTHON_INSTALL_DIR=/data/vlm/python
[ -x /data/vlm/bin/uv ] || curl -LsSf https://astral.sh/uv/install.sh | sh
# A uv-managed Python brings its own headers (Python.h), which torch.compile needs at server start;
# the system Python has none without the python3-dev package.
/data/vlm/bin/uv venv /data/vlm/venv --python 3.12 --managed-python --clear
/data/vlm/bin/uv pip install --python /data/vlm/venv/bin/python -U vllm --torch-backend=auto
echo SETUP_DONE
```

This installed vLLM 0.33.0 with torch 2.14.0+cu132 (NVIDIA driver 580). About 9 GB on disk.

Two things that cost a restart each, both already handled above and in `serve.sh`:

- With the system Python the server dies at start with `fatal error: Python.h: No such file or directory`
  (torch.compile builds a small C module). The uv-managed Python fixes it.
- Started by absolute path, the server dies with `No such file or directory: 'ninja'`. The environment's `bin`
  has to be on `PATH`.

## 2. Weights

```bash
export HF_HOME=/data/vlm/hf
/data/vlm/venv/bin/hf download google/gemma-4-31B-it-qat-w4a16-ct   # 20 GB, 4-bit weights, one 24 GB+ card
/data/vlm/venv/bin/hf download google/gemma-4-12B-it                # 23 GB, one 40 GB+ card
/data/vlm/venv/bin/hf download google/gemma-4-31B-it                # 59 GB, one 80 GB card or two 48 GB cards
```

On a machine with little disk and much memory the cache can sit in memory instead (`HF_HOME=/dev/shm/vlm-hf`);
it is gone after a reboot. Downloads ran at 100 to 250 MB/s.

## 3. Serve

`/data/vlm/serve.sh MODEL SERVED_NAME PORT GPUS IMAGE_TOKENS [extra vllm flags]`:

```bash
#!/bin/bash
set -e
MODEL=$1; NAME=$2; PORT=$3; GPUS=$4; TOKENS=$5; shift 5
export HF_HOME=${HF_HOME:-/data/vlm/hf}
export CUDA_VISIBLE_DEVICES=$GPUS
# torch.compile calls gcc and ninja at start; ninja lives in the environment.
export PATH=/data/vlm/venv/bin:$PATH
exec vllm serve "$MODEL" \
  --served-model-name "$NAME" \
  --host 127.0.0.1 --port "$PORT" \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.92 \
  --limit-mm-per-prompt '{"image": 2}' \
  --mm-processor-kwargs "{\"max_soft_tokens\": $TOKENS}" \
  "$@"
```

`IMAGE_TOKENS` is Gemma 4's image token budget: 70, 140, 280 (the model's default), 560 or 1120. It is fixed when
the server starts, so the served name carries it and the app's answer cache keeps the settings apart.
The server listens on localhost only.

The servers that were measured:

```bash
cd /data/vlm
# 12B, default image budget, one 48 GB card
nohup ./serve.sh google/gemma-4-12B-it gemma-4-12b-it 8100 0 280 > logs/serve-12b-280.log 2>&1 &
# 12B, largest image budget
nohup ./serve.sh google/gemma-4-12B-it gemma-4-12b-it-1120 8101 1 1120 > logs/serve-12b-1120.log 2>&1 &
# 31B in full precision across two 48 GB cards (on one 80 GB card: drop --tensor-parallel-size and give one GPU)
nohup ./serve.sh google/gemma-4-31B-it gemma-4-31b-it-1120 8102 4,5 1120 --tensor-parallel-size 2 > logs/serve-31b-1120.log 2>&1 &
# 31B with Google's 4-bit quantisation-aware weights, one card
nohup ./serve.sh google/gemma-4-31B-it-qat-w4a16-ct gemma-4-31b-it-qat-1120 8103 6 1120 > logs/serve-31b-qat-1120.log 2>&1 &
```

A server is ready when its log says `Application startup complete` (weights load in 10 to 20 s, the first start
compiles for about 3 minutes; later starts reuse the compile cache in `~/.cache/vllm`).

Stop a server: `pgrep -f "[v]llm serve" | xargs -r kill` (the brackets keep the command from matching itself).

## 4. Reach it from a development machine

```bash
ssh -N -L 8103:127.0.0.1:8103 <user>@<gpu machine>
curl -s http://127.0.0.1:8103/v1/models
```

Then, in `app/`:

```bash
VISION_PROVIDER=openai-compatible VISION_BASE_URL=http://127.0.0.1:8103 VISION_MODEL=gemma-4-31b-it-qat-1120 \
STOA_DATASET=../dataset-full npx tsx server/src/eval.ts --source cubicasa5k --sample ../raster-test100.txt \
  --no-detector --interpreter templates --concurrency 4
```

`http://127.0.0.1:<port>/metrics` gives request counts, latency sums and token totals for the latency figures.
