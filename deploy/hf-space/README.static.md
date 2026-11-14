---
title: Blueline
emoji: 📐
colorFrom: blue
colorTo: indigo
sdk: static
app_file: index.html
pinned: false
license: other
short_description: Construction take-off with every counted item marked
---

# Blueline: take-off check

Ask a quantity question about a construction drawing ("How many doors?", "What is the net floor area of apartment A?").
The answer comes back with every counted or measured item marked and numbered on the drawing, so you can check it.

Built at Junction 2026 for the Stoa quantity take-off challenge.

- **CAD floor plans (DXF) and IFC building models** are answered exactly from their geometry.
- **Floor plan images** are answered by object detectors we trained on CubiCasa5k (YOLO11, run with ONNX Runtime on the CPU).
  The images in this demo are a held-out test sample the detectors never saw in training.

This is a static demo: the answers to each drawing's listed questions were computed in advance by the app running with
local models only (no cloud AI model), and the page shows them with their marked-up drawings. To upload your own drawings
and ask your own questions, run the app from the source below.

Source code: https://github.com/NiceK1/stoa-spike

## Licences and credits

- The drawings and questions are a small subset of the Junction 2026 Stoa dataset, for non-commercial use in the Junction
  challenge. Every drawing keeps its own licence; the credit for each file is in `dataset/data/<source>/LICENSE.md`.
  Floor plan images: CubiCasa5k, CC BY-NC-SA 4.0. Swiss apartment floors: Swiss Dwellings, CC BY 4.0. IFC models: per file.
- The detector weights were trained with Ultralytics YOLO (AGPL-3.0) on CubiCasa5k annotations (CC BY-NC-SA 4.0), so they
  are for non-commercial use, and the source of this service is linked above.
