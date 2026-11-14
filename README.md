# Stoa take-off spike

Answers quantity take-off questions from the Junction 2026 Stoa dataset ("Make Blueprints Talk"), marks every counted
item on the drawing, and scores itself against `questions.jsonl` using the dataset's rules (counts exact; areas,
lengths and volumes within 2%).

- **Vector drawings** (DXF floor plans, IFC models with numeric answers) are answered by plain geometry code, with no
  model calls: 99.4% right on each, measured on every question.
- **Raster floor plans**: detectors we trained count the drawn symbols with no model call, and one vision-model
  reading per drawing gives room types and storeys: 86.9% right on 200 held-out drawings.
- **Practice drawing sheets and IFC free-text questions** are answered from the sheet's text layer and from facts
  extracted by code, worded by a language model.
- **Any wording**: a small language model turns each question into a structured call that the exact scripts run.

![Results on the full Stoa dataset, 14 November 2026. By code alone: Swiss apartment floors 37,376 of 37,584 right (99.4%), IFC numeric answers 3,044 of 3,062 (99.4%). Raster floor plans: 1,548 of 1,781 (86.9%) on 200 held-out drawings, against 77.1% for the vision model alone. Below: vision-model calls per drawing for each way of answering, and raster accuracy per kind of question.](docs/results.png)

Raster numbers are measured on 200 drawings the detectors never saw; the "about 90%" for the whole dataset is a
projection from them. Our detectors beat the vision model on drawn symbols and need no hosted call; windows (97 of
200) and doors (119 of 156) are where errors remain.

![How the solution got here, 13 and 14 November 2026. Raster score on one fixed sample of 30 drawings, in seven steps: from 198 to 237 of 280 questions right. Reworded questions answered right: from 103 to 236 of 250 once a language model interprets the question. IFC numeric answers: from 89.4% to 99.4%.](docs/progress.png)

Every step is scored on the same 30 test drawings. The last step dropped the vote between detectors and vision
model: 8 questions fewer, and a symbol count no longer needs a vision call.

## Web app

The full solution is the TypeScript web app in [app/](app/README.md): it takes any drawing of the dataset, routes it
to exact geometry (IFC, DXF), to the sheet's text layer, or to trained detectors and a vision model (raster plans),
and returns the answer with every counted item numbered on the drawing. Its README has the current measurements.
The detector training code is in [training/](training/README.md). The Python files below are the first spike.

How the detectors were trained, run by run: [training history](docs/training-history.png).

## Run

#### 🪟 Windows

```
python -m venv .venv
.venv\Scripts\pip install ifcopenshell
.venv\Scripts\python -I fetch_preview.py dataset README.md questions.jsonl "data/*/LICENSE.md" "data/swiss_dwellings/*.dxf" "data/ifc_models/*.ifc"
.venv\Scripts\python -I evaluate.py dataset --svg out
.venv\Scripts\python -I tests\test_core.py
```

#### 🐧 Linux / macOS

```
python -m venv .venv
.venv/bin/pip install ifcopenshell
.venv/bin/python -I fetch_preview.py dataset README.md questions.jsonl "data/*/LICENSE.md" "data/swiss_dwellings/*.dxf" "data/ifc_models/*.ifc"
.venv/bin/python -I evaluate.py dataset --svg out
.venv/bin/python -I tests/test_core.py
```

`fetch_preview.py` reads the preview zip over HTTP range requests, so only the listed files are downloaded.
`--svg out` writes one evidence overlay per question kind: the plan with the counted or measured shapes highlighted.
Without `ifcopenshell` the IFC questions are skipped and everything else still runs.

### Raster floor plans

Needs the `claude` CLI on PATH, signed in.

#### 🪟 Windows (PowerShell)

```
.venv\Scripts\python -I fetch_preview.py dataset (Get-Content raster-sample.txt)
.venv\Scripts\python -I evaluate_raster.py dataset --models claude-sonnet-5-5 claude-haiku-5-5
```

#### 🐧 Linux / macOS

```
.venv/bin/python -I fetch_preview.py dataset $(cat raster-sample.txt)
.venv/bin/python -I evaluate_raster.py dataset --models claude-sonnet-5-5 claude-haiku-5-5
```

`raster-sample.txt` lists the 30 drawings behind the step-by-step raster scores above. Answers are cached under
`out/raster/<model>/`, so a re-run only asks about drawings it has not seen.

## Layout

| File | Role |
|---|---|
| `takeoff/questions.py` | question text (EN/DE/FR/IT) to a structured intent |
| `takeoff/swiss.py` | rooms, units, doors, windows and fixtures from a layered DXF plan |
| `takeoff/ifc.py` | room areas from IFC space geometry, element counts per storey |
| `takeoff/raster.py` | counts on a raster plan, asked of a vision model with a JSON schema |
| `takeoff/scoring.py` | counts exact; areas, lengths and volumes within 2% |
| `takeoff/evidence.py` | SVG overlay of the shapes behind an answer |

## Limits of the first spike

- Raster results come from 30 drawings, English questions only, one run per model. Door and window counts are weak.
- Raster answers have no evidence overlay: the model returns counts, not locations.
- IFC-Bench text answers and the `opening_design` drawing sets have no solver.
- IFC wall lengths, side areas and volumes are not parsed.
- The DXF solver relies on the layer names and symbol shapes of the generated Swiss Dwellings files.

Drawings keep their own licences (`dataset/data/<source>/LICENSE.md`); `dataset/` is git-ignored.
