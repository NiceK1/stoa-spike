# Take-off check (web app)

Ask a quantity question about a construction drawing. The answer comes back with the drawing and every
counted or measured item marked and numbered, so a person can verify it.

## Run

```
cd app
npm install
npm run build        # builds the web client into web/dist
npm run server       # http://127.0.0.1:8787
```

For development, `npm run dev` restarts the server on changes and `npm run web` serves the client on port 5173.
A drawing and a question can be linked directly: `http://127.0.0.1:8787/?path=data/cubicasa5k/<name>.png&q=<question>`.
The server's front page is the landing page (`deploy/hf-space/landing.html`, the same one the Hugging Face demo opens with);
the app itself is at `/app.html`, and a link that names a drawing as above opens the app directly.

## How a question is answered

`server/src/router.ts` picks the pipeline from the file. In the dataset, files with the same name and a different
extension are the same drawing, and `<model>_plan-<level>.pdf` was rendered from `<model>.ifc`, so a question about a
PDF is answered from its vector twin when one is there.

| Drawing | Pipeline | Evidence shown | Model calls to compute the answer |
|---|---|---|---|
| IFC model, or a PDF rendered from one | stored quantities, else geometry, read with web-ifc | storey plan with the measured rooms or elements highlighted | none |
| IFC model, question about its facts (types, materials, properties) | facts extracted from the model, answered by a language model | storey plan when a rule matched | one text call |
| Layered DXF, or a PDF/PNG with a DXF of the same name | room outlines, labels and symbols from the CAD layers | plan with the counted shapes numbered | none |
| PDF sheet with a text layer (schedules, notes) | text rows with positions, answered by a language model | the rows used, boxed on the page | one text call |
| Raster floor plan, a count of a known kind | each of the 13 known kinds (window, door, toilet bowl, sink, shower, bathtub; sauna, kitchen, bedroom, WC room, bathroom, balcony; storey) is counted by our trained detector routed to its class | numbered boxes on the image | none |
| Raster floor plan, anything else | the external vision model, as the fallback: items of other kinds, a count limited to a part of the drawing, a free reading, and any count on a drawing the detectors do not recognise | numbered marks on the image, or the drawing | one vision call per question; one per drawing for the known kinds on an unrecognised drawing, shared by all its questions |

Before a pipeline computes anything, the question is read by the interpreter model, which costs one small text call
per question (next section). Vector answers are exact and labelled so; model answers are labelled as estimates.
Models sit behind two interfaces, `VisionModel` (`server/src/models/vision.ts`) and `Detector`
(`server/src/models/detector.ts`), so a provider can be replaced without touching the pipelines.

### Local first, the external vision model as the fallback

Nothing our own models can do is sent to an external vision model. On a raster drawing the interpreter's call decides
the tier (`server/src/solvers/raster.ts`):

| The interpreter's call | Who answers | Why |
|---|---|---|
| `count_known` on the whole drawing, the drawing in the detectors' style | our detectors, no model call | |
| `count_known` on a drawing where the detectors find fewer than 3 items with 60% confidence (an elevation, a historic scan) | external vision model, one inventory of the drawing | the detectors' count would be a confident zero |
| `count_known` limited to a part of the drawing ("the kitchen sink", "in enlarged plan 6A") | external vision model, from the full question | the detectors count on the whole drawing only |
| `count_other` (stairs, wardrobes, fireplaces) | external vision model | the detectors do not know the kind |
| `read` (a text, a dimension, a schedule entry) | external vision model | the detectors count items and cannot read |

The method line of every raster answer names the tier in plain words: `window symbols counted by our detectors
(floorplan-symbols-yolo11l-1280), no external model`, against `staircases read by the external vision model
claude-cli:claude-sonnet-5-5 because our detectors do not know this kind of item`. When several kinds are asked, each
part says its own tier.

With no external model configured (`VISION_PROVIDER=none`) a question of the fallback tier is not an error: the answer
has no value, and its note says why, for example `No answer: this question needs an external vision model, because our
detectors count on the whole drawing only, not in a part of it, and the app is running with our local models only
(VISION_PROVIDER=none).` The same holds for a question about a building model's facts, which a language model writes
the answer to. When one of several kinds cannot be counted, the others are still counted and marked, and the note says
which one is missing.

## How questions are understood

**The model interprets, the scripts compute.** Every question goes to an interpreter: a language model that gets the
question, a short menu of what this drawing supports, and the reading of the keyword parser as a hint ("a keyword
parser reads this as: count all doors on the whole floor"; the model is told that this parser ignores qualifiers).
It returns one structured call: the operation, its classes and parameters, whether the user asked to be shown things,
and the answer type. Code then computes the answer and the marks, so the numbers stay exact
(`server/src/planner.ts`, called from `server/src/router.ts`).

| Drawing | Menu the interpreter sees | The call it returns |
|---|---|---|
| Layered DXF | this plan's room labels with the number of rooms carrying each, its apartments, its room numbers, the number of each symbol (median 0.5k characters, at most 1.2k over the 1,040 Swiss plans; labels and numbers are cut off at 60 and 120) | `operation` (`count_symbols`, `count_apartments`, `rooms`, `area_apartment`, `area_floor`, `compare`, `none`), `symbols[]`, `labels[]` (only this plan's labels can be chosen), `room_numbers[]`, `apartments[]`, `pick` (all, largest, smallest), `measure` (count, area, average, list), `missing[]`, `broader_label`, `reason`, `locate`, `answer_type` |
| Raster image, or a PDF sheet | the 13 kinds our detectors know | `operation` (`count_known`, `count_other`, `read`), `targets[]`, `whole_drawing`, `items`, `locate`, `answer_type` |
| IFC model | storey names with elevations and room counts, the element classes present with their counts, room names (at most 60, those sharing a word with the question first; median 1.0k characters, at most 1.9k over the 29 models) | `operation` (`count_elements`, `rooms`, `storey_total`, `model_facts`, `none`), `elements[]`, `storey` (one of the model's storeys, or the whole model), `rooms[]`, `pick`, `measure`, `quantity`, `missing[]`, `reason`, `locate`, `answer_type` |

What the code does with a call:

- Several kinds or several rooms in one question are all counted or measured and all marked; the answer is the total
  and a sentence says what it consists of ("The total of 31 consists of 20 doors and 11 windows").
- Symbols of one apartment or room on a DXF plan are found by containment: a fixture lies inside its room, a door or
  window reaches the outline of the rooms it serves, so an entrance door belongs to its apartment.
- Sums, averages and comparisons are computed from the rooms the model selects ("Apartment A: 107.40 m²; Apartment B:
  80.20 m². Largest: apartment A, 27.20 m² more than apartment B."). Rooms that tie for largest are all named.
- A room number, label, apartment or storey that the drawing does not have is not replaced: the answer says that the
  drawing does not have it and lists what it has.
- The answer says which of the plan's labels a word was matched to, and it is labelled an estimate when the model
  took a broader label for want of an exact one ("the living room" on a plan that labels every room 'Zimmer').
- A question the drawing cannot answer gets the reason in a sentence, and a request to show, mark or find things
  returns the marks or says why there are none.
- A raster question limited to part of the drawing ("the kitchen sink", "in enlarged plan 6A") is counted by the
  external vision model from the full question, because the detectors count on the whole drawing only; the method
  line says so.

The method line of every answer says how the question was read and by whom, for example
`understood as "count doors in apartment A" by claude-cli:claude-haiku-5-5; door symbols on layer DOOR; those lying
in or reaching the outline of one of the 11 rooms in apartment A`.

The keyword parsers read a question on their own in two cases only, and the method line then starts with
`read by the keyword parser (...)`:

- **Bulk mode**, `INTERPRETER=templates` or `--interpreter templates` in the evaluation scripts: free, and how the
  dataset's own wording is scored in the tables below. `npm run eval` refuses to send more than 200 questions to the
  interpreter unless `--interpreter model` is given.
- **Fallback**: no interpreter model is configured (`VISION_PROVIDER=none` or `PLANNER_PROVIDER=none`), or its call
  failed or named nothing runnable. A show-request is then honoured only when it names nothing but the thing to show.

One interpretation is one text call, cached by question and menu. Measured with `PLANNER_MODEL=claude-haiku-5-5`
through the local CLI over 646 calls: 4.4 seconds per call on average (median 4.2, nine in ten under 5.5) and $0.0007
(DXF $0.0007, raster $0.0006, IFC $0.0009). A request is 3 to 6 thousand characters, of which the system prompt is 2.1
to 3.5 thousand. Without `PLANNER_MODEL` the vision model does the interpreting, which is slower. The interpreter only
needs the text side of `VisionModel` with a JSON schema, so `PLANNER_PROVIDER` and `PLANNER_MODEL` can point it at any
model.

Model first against bulk mode on the same questions in the dataset's own wording, asked without the answer type
(14 November 2026, interpreter claude-haiku-5-5):

| Sample | Questions | Bulk mode | Model first |
|---|---|---|---|
| Swiss apartment floors, 30 plans, all 12 kinds, English | 150 | 150 | 150 |
| Swiss apartment floors, 10 plans, German, French and Italian wording | 20 | 20 | 20 |
| Raster floor plans, the 30 drawings of `raster-dev.txt`, all 12 kinds, English | 90 | 76 | 76 |
| Raster floor plans, 12 drawings, Finnish wording | 12 | 10 | 10 |
| IFC models, 30 models and sheets, numeric questions, English | 58 | 57 | 57 |
| IFC models, 7 models and sheets, numeric questions in other languages | 13 | 8 | 12 |
| Practice drawing sheets, with the dataset's answer type | 48 scorable | 48 | 48 |

The raster rows of this table and of the next three were measured while room types and storeys were still read by the
vision model (`RASTER_DETECTOR_TARGETS=symbols` today); they compare how questions are read, which the local-first
default does not change.

No kind is read worse by the model than by the templates; every miss is a counting or geometry miss that both modes
share. The bulk-mode misses on IFC questions in other languages come from the keyword guess of the answer type; with
the type stated, as in the tables under Measured, the cached rewrite of `server/src/rewrite.ts` reads them.

Reworded dataset questions (`npm run eval:paraphrase`): a language model rewrites each sampled question in one of
five styles (casual, show/mark/where, terse keywords, another language, typos), the app answers it without being told
the answer type, and the original expected answer decides.

| Sample | Questions | Model first | Same questions in the dataset's wording |
|---|---|---|---|
| Swiss apartment floors, 24 plans | 120 | 120 (100%) | 120 |
| Raster floor plans, the 30 drawings of `raster-dev.txt` | 90 | 76 (84%) | 76 |
| IFC models, 20 models | 40 | 40 (100%) | 40 |

The style set was used while building the interpreter, so these are development numbers, not held-out ones. On raster
drawings 89 of the 90 reworded questions were read as the kind of the original; the other one ("... the ones marked
MH") was read as a count limited to part of the drawing and answered by the vision model. The 14 raster misses are
counting errors that the dataset's wording has as well.

### A local interpreter: fine-tuned FunctionGemma on the CPU

`PLANNER_PROVIDER=gemma-local` replaces the hosted interpreter by a small open model inside the Node process:
FunctionGemma 270M, fine-tuned on this app's own question-to-call pairs, as a 292 MB GGUF file (q8_0) run on the CPU
with `node-llama-cpp` (`server/src/models/gemma.ts`). Nothing leaves the machine and a call costs nothing. The planner
and the router are unchanged. The provider puts the first line of the instruction, a one-line summary of the schema and
the drawing's menu into the developer turn, and the question with the keyword parser's reading into the user turn,
exactly as in training. A grammar built from the request's JSON schema constrains the output, so a call is always
valid and names only this drawing's labels, apartments and storeys. A missing model file or an unusable call leaves
the question to the keyword parser, like any other interpreter failure.

```bash
# the weights are not in the repository: put the GGUF file at models/interpreter/interpreter-q8_0.gguf
PLANNER_PROVIDER=gemma-local npm start
# or name the file; PLANNER_THREADS sets the CPU threads (default 8, or fewer cores)
PLANNER_PROVIDER=gemma-local PLANNER_MODEL=C:/models/interpreter-q8_0.gguf npm start
```

Haiku against the local Gemma on the same questions, answered by the app end to end (14 November 2026; the raster
sample is the 24 drawings of `raster-dev.txt` now on disk):

| Sample | Questions | claude-haiku-5-5 | Local Gemma | What the local model missed |
|---|---|---|---|---|
| Reworded, Swiss apartment floors, 24 plans | 120 | 120 | 119 | "all the bedrooms" matched to 'Soggiorno' on a plan that labels them 'Camera da letto' |
| Reworded, raster floor plans | 72 | 65 | 64 | three misreadings that add kinds nobody asked for ("bedrooms makuuhuone MH number", two questions with typos about kitchens and sinks); the other five are counting errors that the dataset's wording has as well |
| Reworded, IFC models, 20 models | 40 | 40 | 40 | |
| Dataset wording, Swiss, 30 plans, English | 150 | 150 | 150 | |
| Dataset wording, Swiss, German, French and Italian | 20 | 20 | 20 | |
| Dataset wording, raster, English | 72 | 65 | 65 | the same seven counting errors |
| Dataset wording, raster, Finnish | 12 | 11 | 11 | the same counting error |
| Dataset wording, IFC, 30 models and sheets, English | 58 | 57 | 56 | a room name with an apostrophe ('IMMUNIZ'N ROOM (1D40)') cut at the apostrophe; the other is a wall-area miss both share |
| Dataset wording, IFC, other languages | 12 | 11 | 11 | the same wall-area miss |

The reworded samples use the development styles, which the model was trained on (on other plans; the IFC models are
partly the same). On held-out pairs, from plans and models outside training, test-only question templates and
rewording styles kept for the test (`heldout` in `server/src/paraphrase.ts`), it is weaker than Haiku:

| Held-out pairs, the call compared field by field | Pairs | Untuned FunctionGemma | Local Gemma | claude-haiku-5-5 (first 200) |
|---|---|---|---|---|
| Whole call, all pairs (Python, free decoding) | 1,257 | 0 of 200 | 1,075 (85.5%) | |
| Whole call, first 200 pairs (Node, q8_0, grammar) | 200 | | 174 (87.0%) | 160 (80.0%) |
| Fields the operation reads, first 200 pairs | 200 | | 174 (87.0%) | 188 (94.0%) |
| ... dataset wording | 36 | | 35 | 33 |
| ... constructed questions | 62 | | 57 | 58 |
| ... reworded in the held-out styles | 102 | | 82 (80.4%) | 97 (95.1%) |
| ... layered DXF / IFC / raster | 94 / 59 / 47 | | 89 / 54 / 31 | 88 / 57 / 43 |

Haiku loses whole-call matches to fields its operation does not read (`measure` on an apartment area, `""` written
out), which the second measure ignores. The local model's misses on all 1,257 pairs: it copies an item it never saw
in training wrongly into `items` (raster `count_other` 11 of 54), it misses a show-request that avoids the words show,
mark and where (19 of 62), it is weak in languages outside its training (Polish, Danish, Norwegian, Portuguese, Dutch,
Estonian: 71 of 119), and it drops the second kind in "compare the number of X with the number of Y". Dataset wording
is read right 199 times of 201, constructed questions 359 of 397, held-out rewordings 517 of 659.

One interpretation takes 0.9 seconds on a laptop CPU (i7-11800H, 8 threads; median 0.93, nineteen in twenty under
1.4) against 4.6 seconds for Haiku through the CLI; the model loads in about a second on the first question. The
prompt is 300 to 1,400 tokens and the call 30 to 65. How the pairs were built and the model trained:
`training/gemma/README.md`; `scripts/interp-pairs.ts` writes the pairs, `scripts/interp-eval.ts` scores any
interpreter on the held-out ones, `scripts/gemma-parity.ts` checks the tokens after a conversion.

## Measured

Scored with the dataset's rules (counts exact; areas, lengths and volumes within 2%) on 14 November 2026, in bulk
mode.

| Part of the dataset | Questions | Correct | |
|---|---|---|---|
| Swiss apartment floors (DXF geometry) | 37,584 | 37,376 | 99.4% |
| IFC models, numeric questions | 3,062 | 3,044 | 99.4% |
| Practice drawing sheets (PDF text) | 48 scorable | 48 | 100% |
| Raster floor plans, 200 held-out drawings, our detectors alone | 1,781 | 1,530 | 85.9% |
| IFC models, free-text questions (graded sample) | 46 | 16, and 11 partly | 35% |

Raster floor plans, on drawings the detectors never saw in training (two samples of 100, English questions; the
Finnish questions map to the same targets):

| Who answers | Sample A (916) | Sample B (865) | Both | Vision calls per drawing |
|---|---|---|---|---|
| Our trained detectors for all 13 kinds (default) | 773 | 757 | 1,530, 85.9% | 0 |
| Optional, `RASTER_DETECTOR_TARGETS=symbols`: detectors for drawn symbols, one Sonnet 5.5 reading for room types and storeys | 791 | 757 | 1,548, 86.9% | none for a symbol question; 1 once a room type or storey is asked |
| Sonnet 5.5 alone (`--no-detector`) | 713 | 660 | 1,373, 77.1% | 1 |

All 200 drawings pass the detectors' in-domain guard, so the default made no vision call on these samples. What the
optional setting buys, per room kind on both samples (exact counts; the symbols are the same in both rows above):

| Kind | Asked | Our detectors (default) | Sonnet 5.5 reading |
|---|---|---|---|
| Storeys | 200 | 191 | 196 |
| WC rooms | 98 | 95 | 97 |
| Kitchens | 129 | 118 | 125 |
| Saunas | 137 | 133 | 129 |
| Balconies | 61 | 55 | 58 |
| Bedrooms | 125 | 111 | 116 |
| Bathrooms | 94 | 87 | 87 |
| All seven | 844 | 790 | 808 |

Windows are the weak kind (97 of 200 drawings counted exactly); doors are at 76%, every other kind between 87% and 99%.

Things that were tried and measured but are not in the code any more:

- Voting: every detector and the vision model's inventory counted each symbol and the middle count won. It scored 809
  and 760 (88.1%), about one point above the default, for one extra vision call on every drawing; removed for cost.
- Passing the detectors' findings to the vision model as hints lifted the vision model's own score from 713 to 779 on
  sample A, but the vote dropped, because the hinted reading stopped being an independent opinion.
- Three vision readings per drawing instead of one gained a few questions at three times the cost.
- A larger detector at a higher resolution (YOLO11x at 1536 px) scored below YOLO11l at 1280 px on the test drawings.
- Reading the room labels (MH, K, KH, WC, S, PARVEKE, "2. kerros") with a local OCR engine, to close the gap to the
  vision model on room types without a model call. PP-OCRv4 through `onnxruntime-node` reads the labels well where
  they are printed upright; tesseract.js reads almost nothing on these line drawings. Counting the seven room kinds
  from the labels alone scored 267 of 445 on sample A and 241 of 399 on sample B, against 410 and 380 for the
  detectors: 20 and 13 of the 100 drawings carry no label it can read in any rotation, many rooms have none (open
  kitchens), and the single letters K and S also turn up as noise and in apartment formulas ("3h+k+s"). The best
  combination with the detectors' boxes, chosen on sample A (a kitchen box under the threshold counts when a kitchen
  label lies in it; more sauna labels than sauna boxes win; a bathroom box whose only label names another room is
  dropped), gained 4 questions on A (414) and lost 2 on B (378), so it is not in the app. It would have added about
  1 second per drawing (one reading upright and one upside-down; all four rotations take 2 seconds).

## Measure it yourself

```
npm run eval -- --source swiss_dwellings --interpreter templates       # bulk mode: keyword parsers, no model call
npm run eval -- --source ifc_models --interpreter templates
npm run eval -- --source opening_design --interpreter templates        # needs STOA_DATASET=../dataset
npm run eval -- --source opening_design --interpreter model            # the interpreter reads every question
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates     # sample A; raster-test100b.txt is sample B
RASTER_DETECTOR_TARGETS=symbols npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates   # room types and storeys by the vision model
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates --no-detector                      # the vision model alone
npm run eval -- --source ifc_bench --per-file 2 --judge --interpreter templates   # free text, graded by a language model
npm run eval:paraphrase -- --source swiss_dwellings --drawings 24 --per-file 5      # reworded questions, model first
npm run eval:paraphrase -- --source cubicasa5k --sample ../raster-dev.txt --drawings 30 --per-file 3
npm run eval:paraphrase -- --source ifc_models --drawings 20 --per-file 2 --original   # same sample, dataset wording
npm run eval:paraphrase -- --source swiss_dwellings --drawings 30 --per-file 5 --original --interpreter templates   # and in bulk mode
npm test
```

Set `STOA_DATASET=../dataset-full` to score against the full dataset instead of the preview; the practice sheets and
the drawings of `raster-dev.txt` are in the preview only. Model calls are cached in `.cache/vision`, so a repeated
run costs nothing. `raster-dev.txt` is for tuning prompts; the two test samples are held out from detector training
and should not be tuned on.

## Configuration

The server reads `../.env` and the environment:

| Variable | Purpose |
|---|---|
| `STOA_DATASET` | dataset folder, default `../dataset` |
| `VISION_PROVIDER` | the external model, used as the fallback only: `claude-cli` (default, the local `claude` CLI), `anthropic-api` (needs `ANTHROPIC_API_KEY`), `gemini-api` (needs `GEMINI_API_KEY`), or `none`: no external model at all, questions read by the keyword parsers unless `PLANNER_PROVIDER` names an interpreter; a question that only an external model could answer then gets an answer with no value and a note saying why |
| `VISION_MODEL` | model id, default `claude-sonnet-5-5` |
| `PLANNER_MODEL` | the interpreter model that reads every question, default the vision model; a small one is enough (measured: `claude-haiku-5-5`). `PLANNER_PROVIDER` picks its provider (default the vision provider; `gemma-local` is the fine-tuned Gemma on this machine's CPU, with `PLANNER_MODEL` as the optional path of its GGUF file; `none` leaves the keyword parsers), `PLANNER_EFFORT` its effort with the CLI |
| `INTERPRETER` | `templates` is the bulk mode: the keyword parsers read the questions and no interpreter is asked |
| `DETECTOR` | `onnx` (our weights in `../models`, the default when present), `roboflow` (needs `ROBOFLOW_API_KEY`), `none` |
| `RASTER_DETECTOR_TARGETS` | `all` (default: the detectors count every kind they know, room types and storeys included, with no vision call), `symbols` (the earlier behaviour, for comparison: the detectors count drawn symbols and one reading by the vision model gives room types and storeys), `none` (the vision model counts everything) |
| `INVENTORY_PROMPT` | version of the prompt for the vision model's inventory of a drawing, default `v3` |

The first count on a drawing takes about 3 seconds on a laptop CPU (both detectors scan it once; later questions about
the same drawing reuse the scan) and costs nothing. A fallback reading by the external model takes about 5 seconds
and costs about $0.009 with `anthropic-api`; through the local CLI it takes about 20 seconds.

## Detector weights

`../models/*.onnx` with a `.json` next to each (classes, input size, per-class thresholds tuned on validation
drawings). They are trained with the scripts in `../training` on the public CubiCasa5k annotations, which Stoa's raster
drawings come from. Ultralytics YOLO is AGPL-3.0 and CubiCasa5k is CC BY-NC-SA 4.0, so the weights are for
non-commercial use. The weights are not in the repository.
