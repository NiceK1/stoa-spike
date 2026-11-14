"""Exact-count accuracy of a trained detector against Stoa's answers.

    eval_counts.py <weights> <imgsz> [iou] [tag] [augment] [part=dev] [floor=0.01] [out=DIR]

Per-class confidence thresholds are tuned on the validation split only (against annotation counts), then applied
unchanged to the held-out part, which is scored on the questions Stoa actually asks. The held-out part is the test
split unless part=dev is given: that scores the dev drawings of a sweep dataset and never reads the test split.
Every detection above the floor is saved per drawing as [class, score, [x1, y1, x2, y2]] in <out>/<part>.json.
"""
import json
import os
import sys
from collections import defaultdict

DATA = os.environ.get("STOA_DATA", "/data/yolo")
NAMES = [l.split(": ", 1)[1].strip() for l in open(f"{DATA}/data.yaml") if l.startswith("  ")]
ALL_KIND_CLASSES = {
    "windows": ["window"], "doors": ["door"], "toilets": ["toilet"], "sinks": ["sink"],
    "showers_bathtubs": ["shower", "bathtub"], "saunas": ["sauna"], "kitchens": ["kitchen"], "bedrooms": ["bedroom"],
    "wc_rooms": ["wc_room"], "bathrooms": ["bathroom"], "balconies": ["balcony"], "floors": ["floor"],
}
KIND_CLASSES = {k: cs for k, cs in ALL_KIND_CLASSES.items() if all(c in NAMES for c in cs)}
THRESHOLDS = [round(0.05 + 0.025 * i, 3) for i in range(35)]


def stems_of(part):
    return [l.strip() for l in open(f"{DATA}/splits/{part}.txt") if l.strip()]


def sample_stems():
    return [os.path.splitext(os.path.basename(l.strip()))[0] for l in open("/data/raster-sample.txt") if l.strip()]


def count(dets, cls, t):
    return sum(1 for c, p, _ in dets if c == cls and p >= t)


def tune(val):
    """One confidence threshold per class: the one that reproduces the most annotation counts on validation."""
    labels = defaultdict(lambda: defaultdict(int))
    for stem in val:
        for line in open(f"{DATA}/labels/val/{stem}.txt"):
            if line.strip():
                labels[stem][NAMES[int(line.split()[0])]] += 1
    return {cls: max(THRESHOLDS, key=lambda t: (sum(count(val[s], cls, t) == labels[s][cls] for s in val), -abs(t - 0.4)))
            for cls in NAMES}


def score(dets, stems, truth, thresholds, label):
    per_kind, total, right = {}, 0, 0
    for kind, classes in KIND_CLASSES.items():
        asked = [(s, truth[s]["stoa"][kind]) for s in stems if kind in truth[s]["stoa"]]
        got = [sum(count(dets[s], c, thresholds[c]) for c in classes) for s, _ in asked]
        ok = sum(g == a for g, (_, a) in zip(got, asked))
        near = sum(abs(g - a) <= 1 for g, (_, a) in zip(got, asked))
        per_kind[kind] = [ok, len(asked), near]
        total += len(asked)
        right += ok
    print(f"\n{label}: {right}/{total} = {right / max(1, total):.1%}")
    for kind, (ok, n, near) in per_kind.items():
        print(f"   {kind:17} {ok:4}/{n:4}  {ok / max(1, n):6.1%}   within one {near / max(1, n):6.1%}")
    return {"correct": right, "total": total, "per_kind": per_kind}


def report(val, held, out_dir, extra, part="test"):
    truth = json.load(open("/data/yolo/truth.json"))
    thresholds = tune(val)
    print("thresholds from validation:", thresholds)
    result = dict(extra, thresholds=thresholds)
    result["val"] = score(val, list(val), truth, thresholds, "VALIDATION (thresholds tuned here)")
    result[part] = score(held, list(held), truth, thresholds, part.upper())
    if part == "test":
        result["sample30"] = score(held, sample_stems(), truth, thresholds, "RASTER-SAMPLE (30 drawings, part of test)")
    json.dump(result, open(f"{out_dir}/report.json", "w"), indent=1)
    return result


def load_model(weights):
    from ultralytics import RTDETR, YOLO
    model = YOLO(weights)
    if type(model.model).__name__ == "RTDETRDetectionModel" and not isinstance(model, RTDETR):
        model = RTDETR(weights)
    return model


def detect(model, part, imgsz, iou, cache, augment=False, floor=0.05):
    if os.path.exists(cache):
        return json.load(open(cache))
    out = {}
    stems = stems_of(part)
    paths = [f"{DATA}/images/{part}/{s}.png" for s in stems]
    step = 4 if augment else 16
    for i in range(0, len(paths), step):
        results = model.predict(paths[i:i + step], imgsz=imgsz, conf=floor, iou=iou, max_det=1000, verbose=False,
                                augment=augment)
        for stem, r in zip(stems[i:i + step], results):
            out[stem] = [[model.names[int(c)], round(float(p), 4), [round(float(v), 1) for v in b]]
                         for c, p, b in zip(r.boxes.cls, r.boxes.conf, r.boxes.xyxy)]
    json.dump(out, open(cache, "w"))
    return out


def main():
    positional = [a for a in sys.argv[1:] if "=" not in a]
    options = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
    weights, imgsz = positional[0], int(positional[1])
    iou = float(positional[2]) if len(positional) > 2 else 0.6
    tag = positional[3] if len(positional) > 3 else os.path.basename(os.path.dirname(os.path.dirname(weights)))
    augment = len(positional) > 4 and positional[4] == "augment"
    part, floor = options.get("part", "test"), float(options.get("floor", 0.05))
    out_dir = options.get("out") or (f"/data/eval/{tag}-{imgsz}-iou{iou}{'-tta' if augment else ''}"
                                     f"{'' if part == 'test' else '-' + part}")
    os.makedirs(out_dir, exist_ok=True)
    model = load_model(weights)
    val = detect(model, "val", imgsz, iou, f"{out_dir}/val.json", augment, floor)
    held = detect(model, part, imgsz, iou, f"{out_dir}/{part}.json", augment, floor)
    report(val, held, out_dir, {"weights": weights, "imgsz": imgsz, "iou": iou, "augment": augment}, part)


if __name__ == "__main__":
    main()
