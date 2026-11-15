# What we built with Gemma

Blueline answers quantity questions about construction drawings and marks every counted item on the drawing, so a
person can check the answer. Before anything is counted, the question has to be understood: what to count or
measure, where, and whether the user wants it shown. In the app's default mode that is done by a Gemma we fine-tuned
ourselves, FunctionGemma 270M, running on the CPU inside the web server. No question and no drawing leaves the
machine, and understanding a question costs nothing.

Live demo: https://blueline.65-108-32-187.sslip.io. The mode shown in the ask window is "Blueline only" by default,
and the Source lines under every answer name the "Blueline interpreter (tuned Gemma)" with how it read the question.

The model is published on Hugging Face: https://huggingface.co/NiceK1/blueline-interpreter-functiongemma-270m (one 292 MB GGUF file, under the Gemma Terms of Use,
for non-commercial use).

## Why a 270M model is the right size

The job is narrow. The model gets the question and a short menu of what this drawing contains (its room labels,
apartments, storeys, element classes) and returns one structured call out of a handful of operations; geometry
scripts and our detectors then compute the answer, so the numbers stay exact. That is function calling over a fixed
menu, which FunctionGemma is made for, not open-ended reasoning.

Without a model, a keyword parser reads the dataset's own wording but only 103 of 250 reworded questions. A small
hosted model fixes that, at about $0.0003 and 2.8 seconds per question, and every question goes to someone else's
API. The tuned Gemma does it in 0.9 seconds on a laptop CPU from a 292 MB file.

## How it was built

1. **Training pairs from the app itself.** 53,632 question-to-call pairs: 5,835 dataset questions, 30,927 questions
   constructed from each drawing's own labels, apartments and storeys, and 16,870 rewordings of those by a language
   model (casual, show-me requests, terse keywords, other languages, typos). The target call is known by
   construction, and a reworded question keeps the call of its original. The prompt is rendered by the same code
   that serves the model in the app, so training and serving cannot drift apart: a developer turn with the
   instruction, a one-line schema hint and the drawing's menu, and a user turn with the question.
2. **Held-out test.** 1,257 pairs from 40 plans and 7 building models that are not in training, written with
   question templates and rewording styles that were kept for the test only.
3. **Full fine-tune on one A100 on Verda.** No adapter; three epochs in about 90 minutes. Prompts run to 1,428
   tokens for large building models, so batches are grouped by length (a batch of 24 peaks at 55 GB).
4. **Onto the CPU.** Converted to GGUF (8-bit, 292 MB) and run with `node-llama-cpp` in the Node process. A parity
   script checks that Node produces exactly the token ids used in training; it caught a conversion that had silently
   dropped the special turn tokens.
5. **Constrained output.** A grammar built from the request's JSON schema constrains decoding, so a call is always
   valid, and the schema lists only this drawing's labels, apartments and storeys, so the model cannot name a room
   that the drawing does not have.
6. **A fallback that shows itself.** If the weights are missing or a call is unusable, the keyword parser reads the
   question, and the Source lines say so.

## Results

The call, compared field by field on the first 200 held-out pairs:

| Interpreter | Calls right in every field the operation reads | Dataset wording (36) | Constructed questions (62) | Held-out rewordings (102) |
|---|---|---|---|---|
| Claude Haiku 5.5, hosted | 188 (94.0%) | 33 | 58 | 97 |
| Tuned Gemma, three epochs | 183 (91.5%) | 36 | 56 | 91 |
| Tuned Gemma, 0.85 epoch | 174 (87.0%) | 35 | 57 | 82 |
| FunctionGemma before fine-tuning | 0 | | | |

On all 1,257 held-out pairs the tuned model gets 1,093 right (87.0%).

What matters to a user is the answer. End results of the app on the same questions, by who interpreted them:

| Sample | Questions | Claude Haiku 5.5 | Tuned Gemma |
|---|---|---|---|
| Reworded questions: Swiss apartment floors, raster floor plans, IFC models | 232 | 225 | 224 |
| Dataset wording, six samples in English, German, French, Italian, Finnish and other languages | 324 | 314 | 312 |
| All | 556 | 539 | 536 |

| | Tuned Gemma on the CPU | Claude Haiku 5.5 through the API |
|---|---|---|
| Time per question | 0.9 s (laptop, 8 threads) | 2.8 s |
| Cost per question | $0 | $0.0003 |
| What leaves the machine | nothing | the question and the drawing's menu |

## Where it is weak

Languages it was not trained on (a Romanian and a Dutch question in the samples above were misread), show-me
requests that avoid the words show, mark and where, and item names it has never seen, which it sometimes copies
wrongly. Those are the gaps to Haiku on the held-out rewordings.

## What else we tried with Gemma

We tested Gemma 4 31B as the reader of the drawings themselves (room types and counts from the image), through the
Gemini API on 100 held-out floor plans: 537 of 916 questions right (58.6%, 12 failed calls), against 773 for our own
detectors. We also served it on our A100 with vLLM behind an OpenAI-compatible provider that the app can use, to see
whether an open model could replace the hosted reader; with that accuracy we stopped there. A small Gemma that is
tuned for one narrow job is where the open model wins in this project.

## In the code

- `app/server/src/models/gemma.ts`: the provider (prompt rendering, grammar, CPU threads).
- `app/scripts/interp-pairs.ts`, `interp-eval.ts`, `gemma-parity.ts`: pairs, held-out scoring, token parity.
- `training/gemma/`: training, evaluation and conversion scripts, with the traps we hit.
- `app/README.md`, "A local interpreter", and [results.md](results.md) for all numbers.
