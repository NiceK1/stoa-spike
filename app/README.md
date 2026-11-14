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

## How a question is answered

`server/src/router.ts` picks the pipeline from the file. In the dataset, files with the same name and a different
extension are the same drawing, and `<model>_plan-<level>.pdf` was rendered from `<model>.ifc`, so a question about a
PDF is answered from its vector twin when one is there.

| Drawing | Pipeline | Evidence shown | Model calls |
|---|---|---|---|
| IFC model, or a PDF rendered from one | stored quantities, else geometry, read with web-ifc | storey plan with the measured rooms or elements highlighted | none (a rewrite call for questions in other languages) |
| IFC model, free-text question | facts extracted from the model, answered by a language model | storey plan when a rule matched | one text call |
| Layered DXF, or a PDF/PNG with a DXF of the same name | room outlines, labels and symbols from the CAD layers | plan with the counted shapes numbered | none |
| PDF sheet with a text layer (schedules, notes) | text rows with positions, answered by a language model | the rows used, boxed on the page | one text call |
| Raster floor plan | our trained detectors count the drawn symbols and vote with a vision model's inventory; room types and storeys come from the inventory | numbered boxes or marks on the image | one vision call per drawing, shared by all its questions |

Vector answers are exact and labelled so; model answers are labelled as estimates. Models sit behind two interfaces,
`VisionModel` (`server/src/models/vision.ts`) and `Detector` (`server/src/models/detector.ts`), so a provider can be
replaced without touching the pipelines.

## Questions outside the templates

The fixed parsers know the dataset's wording. They run first, because they cost nothing and their accuracy is measured.
A question they do not recognise ("show me the bedrooms", "which room is the largest?", "ikkunoiden määrä", a typo)
goes to a planner: a language model that gets the question and a menu of what this drawing supports, and returns one
operation with its parameters. Code then computes the answer and the marks, so the numbers stay exact.

| Drawing | What the planner chooses from | Then |
|---|---|---|
| Layered DXF | the take-off operations, with this plan's own room labels (and how many rooms carry each), room numbers, apartments and symbol counts; a room selection by label, number or apartment that is counted, summed, listed or narrowed to its largest or smallest room; a free answer from the room table | the geometry is measured as for a dataset question; a free answer is labelled an estimate and highlights the rooms it rests on |
| Raster image | the kinds the detectors and the inventory know, a count of any other item that can be pointed at, or a free reading | the detector vote, the located count, or the free-form prompt |
| IFC model | the rewrite into the English templates (`server/src/rewrite.ts`), now also tried when a typed question reads as free text | the rule parser |

A request to show, mark, find or locate something is answered like the count of that thing: the marks are on the
drawing, the number stays in the answer, and a sentence says what was marked. The method line of an answer says when
the planner was used and how it read the question, for example `understood as "count rooms labelled 'Schlafzimmer'"`.
The planner costs one text call (5 to 20 seconds through the local CLI); `PLANNER_MODEL` can name a smaller model for it.

Measured on reworded dataset questions (`npm run eval:paraphrase`): a language model rewrites each sampled question
in one of five styles (casual, show/mark/where, terse keywords, another language, typos), the app answers it without
being told the answer type, and the original expected answer decides. Before is the app without the planner and the
locate intent.

| Sample | Questions | Before | After | Same questions in the dataset's wording |
|---|---|---|---|---|
| Swiss apartment floors, 24 plans | 120 | 53 (44%) | 120 (100%) | 120 |
| Raster floor plans, the 30 drawings of `raster-dev.txt` | 90 | 33 (37%) | 75 (83%) | 75 |
| IFC models, 20 models | 40 | 17 (43%) | 39 (98%) | 40 |

The style set was used while building the planner, so these are development numbers, not held-out ones. On raster
drawings every reworded question was understood as the same kind as the original; the misses are counting errors that
the dataset's wording has as well.

## Measured

Scored with the dataset's rules (counts exact; areas, lengths and volumes within 2%) on 14 November 2026.

| Part of the dataset | Questions | Correct | |
|---|---|---|---|
| Swiss apartment floors (DXF geometry) | 37,584 | 37,376 | 99.4% |
| IFC models, numeric questions | 3,062 | 3,040 | 99.3% |
| Practice drawing sheets (PDF text) | 48 scorable | 48 | 100% |
| Raster floor plans, 200 held-out drawings | 1,781 | 1,569 | 88.1% |
| IFC models, free-text questions (graded sample) | 46 | 16, and 11 partly | 35% |

Raster floor plans, on drawings the detectors never saw in training (two samples of 100, English questions; the
Finnish questions map to the same targets):

| Who answers | Sample A (916) | Sample B (865) | Both | Model calls per drawing |
|---|---|---|---|---|
| Sonnet 5.5 alone | 713 | 660 | 77.1% | 1 |
| Our trained detectors alone | 773 | 757 | 85.9% | 0 |
| Detectors and Sonnet together (default) | 809 | 760 | 88.1% | 1 |

The voting rules were chosen on sample A, so sample B is the number to trust for them. Windows are the weak kind
(about half of the drawings counted exactly); every other kind is between 76% and 99%.

Things that were tried and measured but are not the default:

- Passing the detectors' findings to the vision model as hints (`INVENTORY_HINTS=symbols`) lifts the vision model's
  own score from 713 to 779 on sample A, but the vote drops from 804 to 798, because the hinted reading stops being
  an independent opinion.
- Three vision readings per drawing instead of one (`INVENTORY_VOTES=3`) gains a few questions at three times the cost.
- A larger detector at a higher resolution (YOLO11x at 1536 px) scored below YOLO11l at 1280 px on the test drawings.

## Measure it yourself

```
npm run eval -- --source swiss_dwellings
npm run eval -- --source ifc_models
npm run eval -- --source opening_design
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt     # sample A; raster-test100b.txt is sample B
npm run eval -- --source cubicasa5k --sample ../raster-test100.txt --no-detector
npm run eval -- --source ifc_bench --per-file 2 --judge                # free text, graded by a language model
npm run eval -- --source swiss_dwellings --no-planner                  # fixed parsers alone; unrecognised questions cost no call
npm run eval:paraphrase -- --source swiss_dwellings --drawings 24 --per-file 5      # reworded questions
npm run eval:paraphrase -- --source cubicasa5k --sample ../raster-dev.txt --drawings 30 --per-file 3
npm run eval:paraphrase -- --source ifc_models --drawings 20 --per-file 2 --original   # same sample, dataset wording
npx tsx scripts/voters.ts count ../raster-test100.txt a.json           # every count source per question
npx tsx scripts/voters.ts report a.json b.json                         # rules chosen on a.json, checked on b.json
npm test
```

Set `STOA_DATASET=../dataset-full` to score against the full dataset instead of the preview. Raster answers cost a
model call per drawing and are cached in `.cache/vision`. `raster-dev.txt` is for tuning prompts; the two test
samples are held out from detector training and should not be tuned on.

## Configuration

The server reads `../.env` and the environment:

| Variable | Purpose |
|---|---|
| `STOA_DATASET` | dataset folder, default `../dataset` |
| `VISION_PROVIDER` | `claude-cli` (default, the local `claude` CLI) or `anthropic-api` (needs `ANTHROPIC_API_KEY`) |
| `VISION_MODEL` | model id, default `claude-sonnet-5-5` |
| `PLANNER_MODEL` | model that maps free-form questions onto operations, default the vision model; `PLANNER_EFFORT` sets its effort with the CLI |
| `DETECTOR` | `onnx` (our weights in `../models`, the default when present), `roboflow` (needs `ROBOFLOW_API_KEY`), `none` |
| `RASTER_DETECTOR_TARGETS` | `symbols` (default), `all` (detectors also count room types), `none` |
| `RASTER_SYMBOL_VOTE` | `off` answers from the preferred detector alone |
| `INVENTORY_VOTES` | independent vision readings per drawing; the middle count wins (default 1) |
| `INVENTORY_HINTS` | `symbols` or `all` passes detector findings to the vision model (default off) |
| `INVENTORY_PROMPT` | raster prompt version, default `v3` |

With `anthropic-api` a drawing takes about 5 seconds and costs about $0.009; through the local CLI it takes about
20 seconds.

## Detector weights

`../models/*.onnx` with a `.json` next to each (classes, input size, per-class thresholds tuned on validation
drawings). They are trained with the scripts in `../training` on the public CubiCasa5k annotations, which Stoa's raster
drawings come from. Ultralytics YOLO is AGPL-3.0 and CubiCasa5k is CC BY-NC-SA 4.0, so the weights are for
non-commercial use. The weights are not in the repository.
