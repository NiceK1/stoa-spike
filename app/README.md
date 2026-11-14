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
| Raster floor plan | a drawn symbol (window, door, sanitary fixture) is counted by the trained detector routed to its class; room types and storeys come from one inventory of the drawing by a vision model | numbered boxes or marks on the image | none for a symbol; one vision call per drawing for room types and storeys, shared by all its questions |

Before a pipeline computes anything, the question is read by the interpreter model, which costs one small text call
per question (next section). Vector answers are exact and labelled so; model answers are labelled as estimates.
Models sit behind two interfaces, `VisionModel` (`server/src/models/vision.ts`) and `Detector`
(`server/src/models/detector.ts`), so a provider can be replaced without touching the pipelines.

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
| Raster image, or a PDF sheet | the kinds the detectors and the inventory know | `operation` (`count_known`, `count_other`, `read`), `targets[]`, `whole_drawing`, `items`, `locate`, `answer_type` |
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
  vision model from the full question instead of by the whole-drawing detectors.

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

## Measured

Scored with the dataset's rules (counts exact; areas, lengths and volumes within 2%) on 14 November 2026, in bulk
mode.

| Part of the dataset | Questions | Correct | |
|---|---|---|---|
| Swiss apartment floors (DXF geometry) | 37,584 | 37,376 | 99.4% |
| IFC models, numeric questions | 3,062 | 3,044 | 99.4% |
| Practice drawing sheets (PDF text) | 48 scorable | 48 | 100% |
| Raster floor plans, 200 held-out drawings | 1,781 | 1,548 | 86.9% |
| IFC models, free-text questions (graded sample) | 46 | 16, and 11 partly | 35% |

Raster floor plans, on drawings the detectors never saw in training (two samples of 100, English questions; the
Finnish questions map to the same targets):

| Who answers | Sample A (916) | Sample B (865) | Both | Vision calls per drawing |
|---|---|---|---|---|
| Sonnet 5.5 alone (`--no-detector`) | 713 | 660 | 77.1% | 1 |
| Our trained detectors alone (`RASTER_DETECTOR_TARGETS=all`, or `VISION_PROVIDER=none`) | 773 | 757 | 85.9% | 0 |
| Detectors for symbols, one Sonnet reading for room types and storeys (default) | 791 | 757 | 86.9% | none for a symbol question; 1 once a room type or storey is asked |

Windows are the weak kind (97 of 200 drawings counted exactly); doors are at 76%, every other kind between 87% and 99%.

Things that were tried and measured but are not in the code any more:

- Voting: every detector and the vision model's inventory counted each symbol and the middle count won. It scored 809
  and 760 (88.1%), about one point above the default, for one extra vision call on every drawing; removed for cost.
- Passing the detectors' findings to the vision model as hints lifted the vision model's own score from 713 to 779 on
  sample A, but the vote dropped, because the hinted reading stopped being an independent opinion.
- Three vision readings per drawing instead of one gained a few questions at three times the cost.
- A larger detector at a higher resolution (YOLO11x at 1536 px) scored below YOLO11l at 1280 px on the test drawings.

## Measure it yourself

```
npm run eval -- --source swiss_dwellings --interpreter templates       # bulk mode: keyword parsers, no model call
npm run eval -- --source ifc_models --interpreter templates
npm run eval -- --source opening_design --interpreter templates        # needs STOA_DATASET=../dataset
npm run eval -- --source opening_design --interpreter model            # the interpreter reads every question
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates     # sample A; raster-test100b.txt is sample B
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --interpreter templates --no-detector
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
| `VISION_PROVIDER` | `claude-cli` (default, the local `claude` CLI), `anthropic-api` (needs `ANTHROPIC_API_KEY`), `gemini-api` (needs `GEMINI_API_KEY`), or `none`: no cloud model at all, image plans answered by the detectors in `../models`, which then count every class they know, and questions read by the keyword parsers; questions only a vision model can answer then return an error |
| `VISION_MODEL` | model id, default `claude-sonnet-5-5` |
| `PLANNER_MODEL` | the interpreter model that reads every question, default the vision model; a small one is enough (measured: `claude-haiku-5-5`). `PLANNER_PROVIDER` picks its provider (default the vision provider; `none` leaves the keyword parsers), `PLANNER_EFFORT` its effort with the CLI |
| `INTERPRETER` | `templates` is the bulk mode: the keyword parsers read the questions and no interpreter is asked |
| `DETECTOR` | `onnx` (our weights in `../models`, the default when present), `roboflow` (needs `ROBOFLOW_API_KEY`), `none` |
| `RASTER_DETECTOR_TARGETS` | `symbols` (default: the detectors count drawn symbols, the vision model reads room types and storeys), `all` (detectors also count the room types and storeys they know), `none` |
| `INVENTORY_PROMPT` | raster prompt version, default `v3` |

With `anthropic-api` a drawing takes about 5 seconds and costs about $0.009; through the local CLI it takes about
20 seconds.

## Detector weights

`../models/*.onnx` with a `.json` next to each (classes, input size, per-class thresholds tuned on validation
drawings). They are trained with the scripts in `../training` on the public CubiCasa5k annotations, which Stoa's raster
drawings come from. Ultralytics YOLO is AGPL-3.0 and CubiCasa5k is CC BY-NC-SA 4.0, so the weights are for
non-commercial use. The weights are not in the repository.
