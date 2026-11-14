"""Score the exported ONNX file the way the app will run it (onnxruntime on CPU, plain letterbox), and store
thresholds tuned for that path in the model's spec file.

    eval_onnx.py <name>        # reads /data/export/<name>.onnx and .json
"""
import json
import os
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

import eval_counts as E

name = sys.argv[1]
spec_path = f"/data/export/{name}.json"
spec = json.load(open(spec_path))
size = spec["input"]["shape"][2]
session = ort.InferenceSession(f"/data/export/{name}.onnx", providers=["CPUExecutionProvider"])
input_name = session.get_inputs()[0].name


def letterbox(image):
    scale = min(size / image.width, size / image.height)
    w, h = round(image.width * scale), round(image.height * scale)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    left, top = (size - w) // 2, (size - h) // 2
    canvas.paste(image.resize((w, h), Image.BILINEAR), (left, top))
    return np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0, scale, left, top


def detect(part, cache):
    if os.path.exists(cache):
        return json.load(open(cache))
    out, seconds = {}, []
    for stem in E.stems_of(part):
        tensor, scale, left, top = letterbox(Image.open(f"{E.DATA}/images/{part}/{stem}.png").convert("RGB"))
        started = time.time()
        rows = session.run(None, {input_name: tensor})[0][0]
        seconds.append(time.time() - started)
        out[stem] = [[E.NAMES[int(c)], round(float(p), 4),
                      [round(float((x1 - left) / scale), 1), round(float((y1 - top) / scale), 1),
                       round(float((x2 - left) / scale), 1), round(float((y2 - top) / scale), 1)]]
                     for x1, y1, x2, y2, p, c in rows if p > 0]
    print(f"{part}: {len(out)} drawings, median {np.median(seconds):.2f}s each")
    json.dump(out, open(cache, "w"))
    return out


out_dir = f"/data/eval/{name}-onnx"
os.makedirs(out_dir, exist_ok=True)
result = E.report(detect("val", f"{out_dir}/val.json"), detect("test", f"{out_dir}/test.json"), out_dir, {"onnx": name})
spec["thresholds"] = result["thresholds"]
spec["measured"] = {k: result[k] for k in ("val", "test", "sample30")}
spec["measured_with"] = "onnxruntime on CPU, PIL bilinear letterbox; thresholds tuned on validation with the same path"
json.dump(spec, open(spec_path, "w"), indent=1)
