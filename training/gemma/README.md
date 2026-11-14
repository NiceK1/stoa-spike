# Local question interpreter (fine-tuned Gemma)

Fine-tunes a small Gemma to turn a question plus the drawing's menu into one JSON call, converts it to GGUF and runs it on CPU from Node with `node-llama-cpp`. Verified end to end on 14 Nov 2026 with **stand-in data** (`make_standin_pairs.py`, `standin_schema.json`); the real pairs and schema drop in without code changes.

## Files

| File | Purpose |
|---|---|
| `interp_format.py` | Pair file format and the one place the prompt and assistant turn are rendered |
| `train_interpreter.py` | Full fine-tune, loss on the assistant turn only |
| `eval_interpreter.py` | Exact match of the whole call, free and schema-constrained; dumps one prompt's token ids for the Node parity check |
| `convert_to_gguf.sh` | GGUF q8_0 and q4_k_m |
| `run_smoke.sh` | The feasibility run as executed |
| `make_standin_pairs.py`, `standin_schema.json` | Stand-in data and schema, to be replaced |

## Interface for the real run

**Pairs:** JSONL, one object per line.

```json
{"developer": "<instruction + this drawing's menu, exactly as the app renders it>", "question": "Wie viele Fenster gibt es?", "call": {"operation": "count_kind", "kinds": ["window"], "labels": [], "apartment": null, "show": false}, "lang": "de", "family": "reworded"}
```

- `developer` is the finished text, menu included. Generate it with the same TypeScript function the app uses at inference, so there is a single renderer.
- `call` is an object. The assistant turn is `call` serialised compactly with keys in the order of `properties` in the schema file (`call_to_json`).
- `lang` and `family` are optional and only group the scores.

**Schema:** one JSON-schema file (`--schema`). It fixes the key order in training and is passed unchanged to `llama.createGrammarForJsonSchema(schema)` in Node. Stay inside what node-llama-cpp accepts: `type` (a list of types is allowed), `enum`, `const`, `oneOf`, `properties`, `items`. A grammar built per drawing can also restrict `labels` to that drawing's menu with an `enum`.

**Prompt:** FunctionGemma's chat template renders

```
<bos><start_of_turn>developer\n{developer}<end_of_turn>\n<start_of_turn>user\n{question}<end_of_turn>\n<start_of_turn>model\n
```

and the model answers `{json}<end_of_turn>`.

## Commands

Instance (`/data/gemma`, own venv, never `/data/venv`):

```bash
python3 -m venv /data/gemma/venv
/data/gemma/venv/bin/pip install torch transformers datasets accelerate trl peft sentencepiece protobuf huggingface_hub gguf lm-format-enforcer cmake
cd /data/gemma && git clone --depth 1 https://github.com/ggml-org/llama.cpp
(cd llama.cpp && PATH=/data/gemma/venv/bin:$PATH cmake -B build -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF && PATH=/data/gemma/venv/bin:$PATH cmake --build build --target llama-quantize -j 8)
venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('unsloth/functiongemma-270m-it', local_dir='models/unsloth__functiongemma-270m-it', token=False)"

venv/bin/python make_standin_pairs.py --out-dir data            # stand-in only
nice -n 15 venv/bin/python train_interpreter.py --model models/unsloth__functiongemma-270m-it \
  --train data/standin_train.jsonl --schema standin_schema.json --out out/fg270m-standin \
  --epochs 2 --batch-size 16 --max-gpu-gb 12
nice -n 15 venv/bin/python eval_interpreter.py --model out/fg270m-standin --heldout data/standin_heldout.jsonl \
  --schema standin_schema.json --predictions-out out/pred_tuned.jsonl --parity-out out/parity.json \
  --constrained-limit 50 --max-gpu-gb 6
./convert_to_gguf.sh out/fg270m-standin models/unsloth__functiongemma-270m-it gguf/fg270m-standin
```

PC (`bench.mjs` lives in the scratchpad `gemma-node` project, `npm install node-llama-cpp`):

```bash
scp -i ~/.ssh/verda_stoa root@<instance>:/data/gemma/gguf/fg270m-standin-q8_0.gguf root@<instance>:/data/gemma/data/standin_heldout.jsonl root@<instance>:/data/gemma/out/parity.json .
node bench.mjs fg270m-standin-q8_0.gguf standin_heldout.jsonl standin_schema.json parity.json 50 8
```

Node inference in short:

```js
const llama = await getLlama({gpu: false});
const model = await llama.loadModel({modelPath});
const context = await model.createContext({contextSize: 1024, threads: 8});
const completion = new LlamaCompletion({contextSequence: context.getSequence()});
const grammar = await llama.createGrammarForJsonSchema(schema);
const prompt = `<start_of_turn>developer\n${developer}<end_of_turn>\n<start_of_turn>user\n${question}<end_of_turn>\n<start_of_turn>model\n`;
const text = await completion.generateCompletion(model.tokenize(prompt, true), {grammar, maxTokens: 80, temperature: 0});
```

## Traps found

- **Gated weights.** `google/functiongemma-270m-it` needs a token (401). `unsloth/functiongemma-270m-it` and `google/gemma-4-E2B-it` download without one.
- **262k vocabulary.** Logits cost about 1 MB per token position. Batch 32 with the stock loss ran out of memory at 23 GB; `train_interpreter.py` therefore projects only the assistant positions and still peaks at 10.4 GB at batch 16. Always pass `--max-gpu-gb` on the shared GPU so the run fails instead of starving the detector job.
- **Special tokens lost in conversion.** transformers 5 saves a tuned model without `tokenizer.model` and with a slimmed `tokenizer_config.json`. Converted from that directory, `<start_of_turn>` is not a special token in the GGUF and llama.cpp splits it into seven pieces (261 tokens instead of 243), silently. `convert_to_gguf.sh` copies the base model's tokenizer files back first.
- **Double BOS.** `LlamaCompletion` prepends BOS itself. The Node prompt must not start with `<bos>`, otherwise BOS is evaluated twice.
- **lm-format-enforcer 0.11** imports a name transformers 5 moved (shimmed in `eval_interpreter.py`) and is slow on this vocabulary (0.4 s per row), so it only scores `--constrained-limit` rows. The Node grammar is the fast constrained path.
- Run the parity check after every conversion: `bench.mjs` compares the evaluated token ids with `parity.json` from Python.

## Measured (stand-in data, 2,400 training pairs, 300 held-out)

| | Result |
|---|---|
| Untuned FunctionGemma, free decoding | 0/300 exact, 0 valid JSON |
| Tuned, free decoding (Python, float32) | 256/300 exact (150/150 seen frames, 106/150 unseen frames), 300 valid JSON |
| Tuned, constrained vs free on the first 50 rows (Python) | 43/50 vs 43/50 |
| Tuned q8_0 in Node, grammar, first 50 rows | 43/50, same seven rows missed as Python |
| Tuned q4_k_m in Node, grammar, first 50 rows (measured before the BOS fix) | 41/50 |
| Training | loss 0.737 to 0.00014; 21.0 examples/s at batch 16 with two other jobs on the GPU; 10.4 GB peak |
| GGUF size | q8_0 292 MB, q4_k_m 253 MB |
| Node CPU, i7-11800H, 8 threads, q8_0 | load 0.65 s model + 0.21 s context; p50 542 ms, p95 757 ms per question (224-253 prompt tokens, about 25 output tokens) |

| Untuned `gemma-4-E2B-it` Q4_K_M in Node (latency only, 4 questions) | 3.1 GB file, load 4.4 s; p50 2.1 s, p95 2.5 s per question |

At the measured rate, 60,000 pairs for 2 epochs take about 95 minutes; that rate was measured while the GPU was shared three ways.

Not done: the E2B LoRA run (training speed, memory, tuned accuracy). For that tier note that Gemma 4 uses different turn tokens (`<|turn>` ... `<turn|>`) and node-llama-cpp's built-in "Gemma 4" chat wrapper inserts `<|think|>` after the system turn, so the prompt must again be built by hand and checked against Python token ids.

## The real run (14 November 2026)

Pairs come from the app itself, so that the prompt has one renderer: `app/scripts/interp-pairs.ts` writes
`train.jsonl` and `test.jsonl` with the request builders of `planner.ts`, the hint functions of `router.ts` and the
prompt renderer of `server/src/models/gemma.ts`. The developer turn is the first line of the type's instruction, a
one-line schema hint and the drawing's menu; the user turn is the question with the keyword parser's reading. The call
keeps its keys in schema order, so no schema file is passed (`--schema` is optional now). Test rows also carry the
whole request, for `app/scripts/interp-eval.ts`, which scores any `PLANNER_PROVIDER` on them.

```bash
# PC, from app/: pairs (337 hosted calls for the rewordings, cached afterwards)
STOA_DATASET=../dataset-full PLANNER_MODEL=claude-haiku-5-5 npx tsx scripts/interp-pairs.ts --out <dir>
# instance: waits for the GPU, trains, scores, converts
SKIP_UNTUNED=1 ./run_real.sh 0.85 24
# PC, from app/: token parity after the conversion, then the same held-out rows in Node
npx tsx scripts/gemma-parity.ts ../models/interpreter/interpreter-q8_0.gguf <dir>/test.jsonl real_parity.json
PLANNER_PROVIDER=gemma-local npx tsx scripts/interp-eval.ts --pairs <dir>/test.jsonl --limit 200
```

| | |
|---|---|
| Training pairs | 53,632: dataset wording 5,835, constructed 30,927, reworded 16,870; DXF 29,817, IFC 17,726, raster 6,089 |
| Held-out pairs | 1,257 from 40 plans and 4+3 models outside training, test-only templates and the `heldout` rewording styles |
| Prompt length | median 498 tokens, longest 1,428 (IFC menus); the call is 30 to 65 tokens |
| Training | 0.85 epoch at batch 24, 24.9 minutes on the free A100 (30.5 examples/s), peak 55 GB, loss 0.41 to 0.0017 |
| Untuned, 200 held-out rows | 0 exact, 0 valid JSON |
| Tuned, free decoding, 1,257 rows | 1,075 exact (85.5%): dataset wording 199/201, constructed 359/397, reworded 517/659 |
| Token parity Python against Node | identical (953 tokens) |

More traps:

- **Memory grows with the prompt.** Batch 32 ran out of 80 GB on a batch of 1,400-token IFC prompts 20% into the
  first attempt; batch 24 peaks at 55 GB. `train_interpreter.py` now batches by length.
- **Speed is the transformer body, not the vocabulary.** A step of 24 x 700 tokens takes 0.34 s without the output
  layer and 0.37 s with it; a full epoch of these pairs is about 29 minutes.
- **Log lines arrive late** through the `grep` in `run_real.sh`; the trainer's lines are only flushed at the end.
