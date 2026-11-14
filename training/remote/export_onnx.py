"""Export a trained detector to ONNX with NMS inside the graph, verify it on CPU, and write the spec the app needs.

    export_onnx.py <weights> <imgsz> <name> <eval report.json>

The ONNX counts are compared with PyTorch on 30 drawings: the raster sample (part of test) for a run scored on test,
the first 30 validation drawings for any other run, so a sweep run never opens the test part.
A dataset with an app_spec.json (build_winrun.py) is written under the class names the app counts: classes are
renamed, and an optional class counts as another only if that gives more exact counts on validation. That is decided
on the rows the ONNX graph returns, which have no NMS across classes, because that is what the app sums.
"""
import json
import os
import shutil
import sys
import time
from collections import Counter

import numpy as np
import onnxruntime as ort
from PIL import Image
from ultralytics import YOLO

import eval_counts as E

weights, imgsz, name, report_path = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
report = json.load(open(report_path))
model = YOLO(weights)
exported = model.export(format="onnx", imgsz=imgsz, opset=17, simplify=True, nms=True, conf=0.05, iou=report["iou"],
                        max_det=1000, dynamic=False, half=False, device="cpu")
out_dir = os.environ.get("STOA_OUT", "/data") + "/export"
os.makedirs(out_dir, exist_ok=True)
onnx_path = f"{out_dir}/{name}.onnx"
shutil.copy(exported, onnx_path)

session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
inp, out = session.get_inputs()[0], session.get_outputs()[0]


def letterbox(image, size):
    """Resize to fit a size x size square keeping the aspect ratio; centre on a grey (114) canvas."""
    scale = min(size / image.width, size / image.height)
    w, h = round(image.width * scale), round(image.height * scale)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    left, top = (size - w) // 2, (size - h) // 2
    canvas.paste(image.resize((w, h), Image.BILINEAR), (left, top))
    return np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0, scale, left, top


def app_view(names, thresholds, weights, val):
    """Classes, thresholds and count weights under the names the app counts, and what validation decided."""
    app_file = f"{E.DATA}/app_spec.json"
    app = json.load(open(app_file)) if os.path.exists(app_file) else {}
    classes, thresholds, weights = list(names), dict(thresholds), {k: dict(w) for k, w in weights.items()}
    decided = None
    optional = app.get("optional")
    if optional:
        kind, extra, main = optional["kind"], optional["class"], optional["counts_as"]
        truth = json.load(open("/data/yolo/truth.json"))
        labels = {s: Counter(names[int(l.split()[0])] for l in open(f"{E.DATA}/labels/val/{s}.txt") if l.strip()) for s in val}
        asked = [s for s in val if kind in truth[s]["stoa"]]
        tried = {}
        for label, group in (("alone", [main]), ("with", [main, extra])):
            def got(s, t):
                return sum(E.count(val[s], c, t) for c in group)
            t = max(E.THRESHOLDS, key=lambda t: (sum(got(s, t) == labels[s][main] + labels[s][extra] for s in val), -abs(t - 0.4)))
            tried[label] = {"threshold": t, "exact": sum(got(s, t) == truth[s]["stoa"][kind] for s in asked), "asked": len(asked)}
        counted = tried["with"]["exact"] > tried["alone"]["exact"]
        thresholds[main] = tried["with" if counted else "alone"]["threshold"]
        weights[kind] = {main: 1}
        if counted:
            classes[names.index(extra)] = main
            del thresholds[extra]
        decided = dict(optional, counted=counted, validation=tried)
    rename = app.get("rename", {})
    classes = [rename.get(c, c) for c in classes]
    thresholds = {rename.get(c, c): t for c, t in thresholds.items()}
    weights = {k: {rename.get(c, c): w for c, w in ws.items()} for k, ws in weights.items()}
    return bool(app), classes, thresholds, weights, decided


def app_exact(classes, thresholds, weights, names, val):
    """Exact counts on validation the way the app sums the ONNX rows: [exact, asked] per question kind."""
    truth = json.load(open("/data/yolo/truth.json"))
    shown = dict(zip(names, classes))
    result = {}
    for kind, ws in weights.items():
        asked = [s for s in val if kind in truth[s]["stoa"]]
        got = [sum(ws.get(shown[c], 0) for c, p, *_ in val[s] if shown[c] in ws and p >= thresholds[shown[c]]) for s in asked]
        result[kind] = [sum(g == truth[s]["stoa"][kind] for g, s in zip(got, asked)), len(asked)]
    return result


names = list(model.names.values())
thresholds = report["thresholds"]
if os.environ.get("STOA_PART", "test") == "test":
    sample_part = "test"
    sample = [os.path.splitext(os.path.basename(l.strip()))[0] for l in open("/data/raster-sample.txt") if l.strip()]
else:
    sample_part, sample = "val", E.stems_of("val")[:30]
agree = total = 0
seconds = []
for stem in sample:
    path = f"{E.DATA}/images/{sample_part}/{stem}.png"
    image = Image.open(path).convert("RGB")
    tensor, scale, left, top = letterbox(image, imgsz)
    started = time.time()
    rows = session.run(None, {inp.name: tensor})[0][0]
    seconds.append(time.time() - started)
    onnx_counts = {n: 0 for n in names}
    for x1, y1, x2, y2, conf, cls in rows:
        n = names[int(cls)]
        if conf >= thresholds[n]:
            onnx_counts[n] += 1
    torch_counts = {n: 0 for n in names}
    r = model.predict(path, imgsz=imgsz, conf=0.05, iou=report["iou"], max_det=1000, verbose=False)[0]
    for c, p in zip(r.boxes.cls, r.boxes.conf):
        n = names[int(c)]
        if float(p) >= thresholds[n]:
            torch_counts[n] += 1
    for n in names:
        total += 1
        agree += onnx_counts[n] == torch_counts[n]

val_path = f"{os.path.dirname(report_path)}/val.json"
val = json.load(open(val_path)) if os.path.exists(val_path) else {}
for_app, classes, app_thresholds, count_weights, decided = app_view(
    names, thresholds, report.get("count_weights") or E.COUNT_WEIGHTS, val)
spec = {
    "model": f"{name}.onnx",
    "source": "Ultralytics YOLO (AGPL-3.0), trained on CubiCasa5k annotations (CC BY-NC-SA 4.0)",
    "input": {"name": inp.name, "shape": inp.shape, "dtype": "float32", "layout": "NCHW", "channels": "RGB", "range": "0..1",
              "preprocess": f"letterbox: scale = min({imgsz}/width, {imgsz}/height); resize (bilinear) to round(width*scale) x "
                            f"round(height*scale); paste centred on a {imgsz}x{imgsz} canvas filled with 114; "
                            "left = (size - w) // 2, top = (size - h) // 2"},
    "output": {"name": out.name, "shape": out.shape, "nms_in_graph": True,
               "row": "[x1, y1, x2, y2, confidence, class_index] in canvas pixels; rows with confidence 0 are padding",
               "to_image": "x_image = (x - left) / scale, y_image = (y - top) / scale"},
    "classes": classes,
    "thresholds": app_thresholds,
    "question_kinds": {k: list(ws) for k, ws in count_weights.items()} if for_app else report.get("question_kinds") or E.KIND_CLASSES,
    "count_weights": count_weights,
    "count_rule": "answer for a question kind = sum over its classes in count_weights of weight * number of rows of "
                  "that class with confidence >= thresholds[class]",
    "measured": {k: report[k] for k in ("val", "dev", "test", "sample30") if k in report},
    "onnx_vs_pytorch_count_agreement_on_sample": f"{agree}/{total}",
    "cpu_seconds_per_drawing_on_instance": round(float(np.median(seconds)), 3),
}
if for_app:
    spec["trained_classes"] = names
    spec["validation_as_the_app_counts"] = app_exact(classes, app_thresholds, count_weights, names, val)
    if decided:
        spec["optional_class"] = decided
json.dump(spec, open(f"{out_dir}/{name}.json", "w"), indent=1)
print(json.dumps({k: spec[k] for k in ("model", "input", "output", "onnx_vs_pytorch_count_agreement_on_sample",
                                       "cpu_seconds_per_drawing_on_instance")}, indent=1))
print(json.dumps({k: spec[k] for k in ("classes", "thresholds", "count_weights", "optional_class",
                                       "validation_as_the_app_counts") if k in spec}, indent=1))
print("size MB:", round(os.path.getsize(onnx_path) / 1e6, 1))
