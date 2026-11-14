"""Export a trained detector to ONNX with NMS inside the graph, verify it on CPU, and write the spec the app needs.

    export_onnx.py <weights> <imgsz> <name> <eval report.json>
"""
import json
import os
import shutil
import sys
import time

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


names = list(model.names.values())
thresholds = report["thresholds"]
sample = [os.path.splitext(os.path.basename(l.strip()))[0] for l in open("/data/raster-sample.txt") if l.strip()]
agree = total = 0
seconds = []
for stem in sample:
    path = f"{E.DATA}/images/test/{stem}.png"
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
    "classes": names,
    "thresholds": thresholds,
    "question_kinds": report.get("question_kinds") or E.KIND_CLASSES,
    "measured": {k: report[k] for k in ("val", "dev", "test", "sample30") if k in report},
    "onnx_vs_pytorch_count_agreement_on_sample": f"{agree}/{total}",
    "cpu_seconds_per_drawing_on_instance": round(float(np.median(seconds)), 3),
}
json.dump(spec, open(f"{out_dir}/{name}.json", "w"), indent=1)
print(json.dumps({k: spec[k] for k in ("model", "input", "output", "onnx_vs_pytorch_count_agreement_on_sample",
                                       "cpu_seconds_per_drawing_on_instance")}, indent=1))
print("size MB:", round(os.path.getsize(onnx_path) / 1e6, 1))
