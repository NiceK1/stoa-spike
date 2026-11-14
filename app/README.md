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

The server reads `../.env`:

| Variable | Purpose |
|---|---|
| `ROBOFLOW_API_KEY` | hosted detector for windows and doors on raster plans (optional) |
| `ANTHROPIC_API_KEY` | only for `VISION_PROVIDER=anthropic-api` |
| `VISION_PROVIDER` | `claude-cli` (default, the local `claude` CLI) or `anthropic-api` |
| `VISION_MODEL` | model id, default `claude-sonnet-5-5` |
| `INVENTORY_VOTES` | independent readings per raster drawing; the middle count wins (default 1, 3 is more accurate) |
| `INVENTORY_PROMPT` | raster prompt version, default `v3` |
| `STOA_DATASET` | dataset folder, default `../dataset` |

## How a question is answered

| Drawing | Pipeline | Evidence |
|---|---|---|
| IFC model, or a PDF rendered from one | geometry and stored quantities read with web-ifc | storey plan, measured rooms or elements highlighted |
| Layered DXF, or a PDF/PNG with a DXF of the same name | room outlines, labels and symbols from the CAD layers | plan with the shapes numbered |
| PDF sheet with a text layer (schedules, notes) | text rows with positions, answered by a language model | the rows used, boxed on the page |
| Raster floor plan | one vision-model inventory of located items per drawing; a detector for windows and doors | numbered marks on the image |

`server/src/router.ts` picks the pipeline. Vector answers are exact; model answers are labelled as estimates.

Models sit behind two interfaces, `VisionModel` (`server/src/models/vision.ts`) and `Detector`
(`server/src/models/detector.ts`), so a provider can be replaced without touching the pipelines.

## Measure

```
npm run eval -- --source swiss_dwellings
npm run eval -- --source ifc_models
npm run eval -- --source opening_design
npm run eval -- --source cubicasa5k                      # the 30 drawings in ../raster-sample.txt
npm run eval -- --source cubicasa5k --sample ../raster-dev.txt --no-detector
npm test
```

Raster answers cost a model call per drawing and are cached in `.cache/vision`. `raster-dev.txt` is for tuning
prompts; `raster-sample.txt` is the test sample and should not be tuned on.
