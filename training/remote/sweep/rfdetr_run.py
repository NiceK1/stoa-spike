"""RF-DETR medium on the symbols dataset: train, score exact counts on dev, export to ONNX and time it on the CPU.

    rfdetr_run.py train <epochs> [batch] [accumulate] [out dir]
    rfdetr_run.py eval       # detections for val and dev, thresholds on val, exact counts on dev -> results/rfdetr.json
    rfdetr_run.py export     # ONNX and CPU seconds for one drawing, added to results/rfdetr.json

Runs in /data/round3/venv-rfdetr on rfdetr_data.py's letterboxed copy of the data. Scoring is eval_counts.report, the
rule the YOLO runs are scored with. The test part is never read.
"""
import csv
import glob
import json
import os
import shutil
import sys
import time
from collections import Counter, defaultdict

ROOT = "/data/round3/rfdetr"
DATA = f"{ROOT}/data"
# A trial run is scored under another name: RFDETR_OUT=/data/round3/rfdetr/probe RFDETR_NAME=rfdetr_probe.
OUT = os.environ.get("RFDETR_OUT", f"{ROOT}/out")
SYM = "/data/sweep/data/yolo_sym"
NAME = os.environ.get("RFDETR_NAME", "rfdetr")
RES = 1280
FLOOR = 0.01
EVAL_DIR = f"/data/sweep/eval/{NAME}"
RESULT = f"/data/sweep/results/{NAME}.json"
EXPORT_NAME = f"floorplan-{NAME}-medium-1280"


def update(fields):
    result = json.load(open(RESULT)) if os.path.exists(RESULT) else {"name": NAME}
    result.update(fields)
    json.dump(result, open(RESULT + ".tmp", "w"), indent=1)
    os.replace(RESULT + ".tmp", RESULT)


def train(epochs, batch=4, accumulate=4, out=OUT):
    from rfdetr import RFDETRMedium
    model = RFDETRMedium(resolution=RES)
    model.train(dataset_dir=DATA, epochs=epochs, batch_size=batch, grad_accum_steps=accumulate, lr=1e-4, resolution=RES,
                output_dir=out, num_workers=10, tensorboard=False, run_test=False, progress_bar="tqdm",
                checkpoint_interval=1000)


def best_checkpoint():
    for f in ("checkpoint_best_total.pth", "checkpoint_best_ema.pth", "checkpoint_best_regular.pth", "last.ckpt"):
        if os.path.exists(f"{OUT}/{f}"):
            return f"{OUT}/{f}"
    sys.exit(f"no checkpoint in {OUT}")


def load(path):
    import rfdetr
    return rfdetr.from_checkpoint(path, trust_checkpoint=True)


def detect(model, folder):
    """{stem: [[class id, score, box in pixels of the drawing]]} for one folder of letterboxed drawings."""
    from PIL import Image
    meta = json.load(open(f"{DATA}/meta.json"))
    stems = [im["file_name"][:-4] for im in json.load(open(f"{DATA}/{folder}/_annotations.coco.json"))["images"]]
    out = {}
    for i in range(0, len(stems), 8):
        chunk = stems[i:i + 8]
        found = model.predict([Image.open(f"{DATA}/{folder}/{s}.png").convert("RGB") for s in chunk], threshold=FLOOR,
                              include_source_image=False)
        for stem, d in zip(chunk, found if isinstance(found, list) else [found]):
            scale, left, top, _, _ = meta[stem]
            out[stem] = [[int(c), round(float(p), 4), [round((x1 - left) / scale, 1), round((y1 - top) / scale, 1),
                                                       round((x2 - left) / scale, 1), round((y2 - top) / scale, 1)]]
                         for (x1, y1, x2, y2), p, c in zip(d.xyxy.tolist(), d.confidence.tolist(), d.class_id.tolist())]
    return out


def iou(a, b):
    inter = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return inter / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def class_of_id(val, names, declared):
    """Class name per predicted id: the model's own list, overruled where its confident detections land on another class."""
    meta = json.load(open(f"{DATA}/meta.json"))
    votes = defaultdict(Counter)
    for stem, rows in val.items():
        _, _, _, w, h = meta[stem]
        labels = []
        for line in open(f"{SYM}/labels/val/{stem}.txt"):
            if line.strip():
                c, xc, yc, bw, bh = (float(v) for v in line.split())
                labels.append((names[int(c)], [(xc - bw / 2) * w, (yc - bh / 2) * h, (xc + bw / 2) * w, (yc + bh / 2) * h]))
        for c, p, box in rows:
            if p >= 0.4:
                hit = max(labels, key=lambda l: iou(box, l[1]), default=None)
                if hit and iou(box, hit[1]) >= 0.5:
                    votes[c][hit[0]] += 1
    print("class ids by overlap with validation labels:", {c: dict(v.most_common(2)) for c, v in sorted(votes.items())})
    print("class names the model declares:", declared)
    mapping = dict(enumerate(declared)) if declared and set(declared) == set(names) else {}
    for c, v in votes.items():
        seen = v.most_common(1)[0][0]
        if mapping.get(c) != seen:
            print(f"class id {c}: declared {mapping.get(c)}, lands on {seen}; counted as {seen}")
            mapping[c] = seen
    return mapping


def epochs_run():
    try:
        rows = list(csv.DictReader(open(f"{OUT}/metrics.csv")))
    except OSError:
        return None, None
    epochs = sorted({int(float(r["epoch"])) for r in rows if r.get("epoch")})
    maps = {k: max(float(r[k]) for r in rows if r.get(k)) for k in (rows[0] if rows else {})
            if "map" in k.lower() and "val" in k.lower() and any(r.get(k) for r in rows)}
    return (epochs[-1] + 1 if epochs else 0), maps


def evaluate():
    os.environ["STOA_DATA"] = SYM
    sys.path.insert(0, "/data")
    import eval_counts as E
    os.makedirs(EVAL_DIR, exist_ok=True)
    checkpoint = best_checkpoint()
    model = load(checkpoint)
    started = time.time()
    raw = {"val": detect(model, "valid"), "dev": detect(model, "dev")}
    seconds = (time.time() - started) / sum(len(v) for v in raw.values())
    mapping = class_of_id(raw["val"], E.NAMES, getattr(model, "class_names", None))
    dets = {part: {s: [[mapping[c], p, box] for c, p, box in rows if c in mapping] for s, rows in found.items()}
            for part, found in raw.items()}
    for part, found in dets.items():
        json.dump(found, open(f"{EVAL_DIR}/{part}.json", "w"))
    report = E.report(dets["val"], dets["dev"], EVAL_DIR, {"weights": checkpoint, "imgsz": RES, "augment": False}, "dev")
    done, maps = epochs_run()
    timing = open(f"{OUT}/train_time.txt").read().split() if os.path.exists(f"{OUT}/train_time.txt") else None
    fields = {"status": "ok", "model": "RFDETRMedium", "resolution": RES, "weights": checkpoint, "epochs_run": done,
              "best_val_metrics": maps, "thresholds": report["thresholds"],
              "gpu_seconds_per_drawing_pytorch": round(seconds, 3),
              "detections": {p: f"{EVAL_DIR}/{p}.json" for p in ("val", "dev")}}
    for part in ("val", "dev"):
        fields[part] = dict({k: {"exact": ok, "asked": n, "within_one": near} for k, (ok, n, near) in report[part]["per_kind"].items()},
                            correct=report[part]["correct"], total=report[part]["total"])
    if timing:
        fields["minutes"] = {"train": round((int(timing[1]) - int(timing[0])) / 60, 1)}
        fields["train_exit"] = int(timing[2])
        fields["epochs_planned"] = int(timing[3])
        if int(timing[2]) != 0:
            fields["status"] = "truncated"
    update(fields)


def export():
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    model = load(best_checkpoint())
    shutil.rmtree(f"{ROOT}/export", ignore_errors=True)
    written = model.export(output_dir=f"{ROOT}/export", verbose=False)
    files = sorted(glob.glob(f"{ROOT}/export/**/*.onnx", recursive=True), key=os.path.getsize)
    onnx_path = str(written) if str(written).endswith(".onnx") else files[-1]
    os.makedirs("/data/sweep/export", exist_ok=True)
    target = f"/data/sweep/export/{EXPORT_NAME}.onnx"
    shutil.copy(onnx_path, target)

    stem = sorted(json.load(open(f"{DATA}/meta.json")))[0]
    folder = next(f for f in ("valid", "dev", "train") if os.path.exists(f"{DATA}/{f}/{stem}.png"))
    pixels = np.asarray(Image.open(f"{DATA}/{folder}/{stem}.png").convert("RGB"), np.float32) / 255.0
    tensor = ((pixels - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).astype(np.float32).transpose(2, 0, 1)[None]
    seconds, shapes = {}, {}
    for threads in (0, 6):
        options = ort.SessionOptions()
        if threads:
            options.intra_op_num_threads = threads
        session = ort.InferenceSession(target, options, providers=["CPUExecutionProvider"])
        feed = {session.get_inputs()[0].name: tensor}
        session.run(None, feed)
        times = []
        for _ in range(5):
            started = time.time()
            outputs = session.run(None, feed)
            times.append(time.time() - started)
        seconds[f"{threads} threads" if threads else f"all {os.cpu_count()} cores"] = round(sorted(times)[len(times) // 2], 3)
        shapes = {o.name: list(v.shape) for o, v in zip(session.get_outputs(), outputs)}
    update({"onnx": {"model": target, "size_mb": round(os.path.getsize(target) / 1e6, 1),
                     "input": {"name": session.get_inputs()[0].name, "shape": list(tensor.shape),
                               "preprocess": f"letterbox to {RES}x{RES} on grey 114 as rfdetr_data.py, RGB / 255, then "
                                             "(x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]"},
                     "outputs": shapes, "cpu_seconds_per_drawing": seconds}})
    print(json.dumps(seconds))


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "train":
        numbers = [int(v) for v in sys.argv[2:5]]
        train(*numbers, **({"out": sys.argv[5]} if len(sys.argv) > 5 else {}))
    else:
        {"eval": evaluate, "export": export}[command]()
