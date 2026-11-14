"""Exact-count accuracy of a trained detector against Stoa's answers.

    eval_counts.py <weights> <imgsz> [iou] [tag] [augment] [part=dev] [floor=0.01] [out=DIR]

Per-class confidence thresholds are tuned on the validation split only (against annotation counts), then applied
unchanged to the held-out part, which is scored on the questions Stoa actually asks. The held-out part is the test
split unless part=dev is given: that scores the dev drawings of a sweep dataset and never reads the test split.
Every detection above the floor is saved per drawing as [class, score, [x1, y1, x2, y2]] in <out>/<part>.json.
A count is a weighted sum over the classes of the question kind. A box counts once, unless the dataset has a
count_weights.json ({kind: {class: weight}}, e.g. window_3 counts three); the report then repeats that table.
A dataset with a count_rules.json (build_winrun.py) is counted after three more steps, all fitted on validation:
door classes are de-duplicated against each other and share one threshold, and a window run counts as the panes
that sweep/panes.py reads from it. <part>_counted.json holds the detections as counted, the panes as a fourth value.
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
WEIGHTS_FILE = f"{DATA}/count_weights.json"
WEIGHTED = os.path.exists(WEIGHTS_FILE)
COUNT_WEIGHTS = json.load(open(WEIGHTS_FILE)) if WEIGHTED else {
    k: {c: 1 for c in cs} for k, cs in ALL_KIND_CLASSES.items() if all(c in NAMES for c in cs)}
KIND_CLASSES = {k: list(ws) for k, ws in COUNT_WEIGHTS.items()}
THRESHOLDS = [round(0.05 + 0.025 * i, 3) for i in range(35)]
RULES_FILE = f"{DATA}/count_rules.json"
RULES = json.load(open(RULES_FILE)) if os.path.exists(RULES_FILE) else {}


def stems_of(part):
    return [l.strip() for l in open(f"{DATA}/splits/{part}.txt") if l.strip()]


def sample_stems():
    return [os.path.splitext(os.path.basename(l.strip()))[0] for l in open("/data/raster-sample.txt") if l.strip()]


def count(dets, cls, t):
    return sum(1 for d in dets if d[0] == cls and d[1] >= t)


def answer(dets, cls, t):
    """As count, except that a detection carrying a fourth value (the panes of a window run) counts as that many."""
    return sum(d[3] if len(d) > 3 else 1 for d in dets if d[0] == cls and d[1] >= t)


def overlap(a, b):
    inter = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return inter / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def apply_rules(dets, part, out_dir):
    """Detections as they are counted under count_rules.json; without the panes model a run counts once."""
    out = {}
    for stem, rows in dets.items():
        dropped = set()
        for group in RULES.get("cross_class_nms", []):
            kept = []
            for i in sorted((i for i, d in enumerate(rows) if d[0] in group), key=lambda i: -rows[i][1]):
                if any(overlap(rows[i][2], rows[k][2]) >= RULES.get("nms_iou", 0.6) for k in kept):
                    dropped.add(i)
                else:
                    kept.append(i)
        out[stem] = [list(d) for i, d in enumerate(rows) if i not in dropped]
    panes = RULES.get("panes")
    if panes and os.path.exists(f"{panes['model_dir']}/rule.json"):
        sys.path.insert(0, panes["module_dir"])
        from panes import WindowCounter
        counter = WindowCounter(panes["model_dir"])
        for stem, rows in out.items():
            runs = [d for d in rows if d[0] == panes["class"] and d[1] >= THRESHOLDS[0]]
            image, boxes = f"{DATA}/images/{part}/{stem}.png", [d[2] for d in runs]
            read = counter.read(image, boxes)
            for d, weight, n in zip(runs, counter.weights(image, boxes, read), read):
                d += [weight, n]
        print(f"{part}: panes per window run from {panes['model_dir']}, drawing rule {counter.rule['rule']}")
    elif panes:
        print(f"{part}: no panes model in {panes['model_dir']}; every window run counts once")
    json.dump(out, open(f"{out_dir}/{part}_counted.json", "w"))
    return out


def rule_thresholds(val, labels):
    """Thresholds that the count rules fit jointly: one per group of classes, and the run threshold on the pane sum."""
    fitted = {}
    for group in RULES.get("shared_threshold", []):
        t = max(THRESHOLDS, key=lambda t: (sum(sum(count(val[s], c, t) for c in group) == sum(labels[s][c] for c in group)
                                               for s in val), -abs(t - 0.4)))
        fitted.update({c: t for c in group})
    panes = RULES.get("panes")
    if panes and any(len(d) > 3 for rows in val.values() for d in rows):
        true = {s: sum(n for *_, n in runs) for s, runs in json.load(open(f"{DATA}/runs.json")).items()}
        fitted[panes["class"]] = max(THRESHOLDS, key=lambda t: (sum(answer(val[s], panes["class"], t) == true[s] for s in val),
                                                                -abs(t - 0.4)))
    return fitted


def tune(val):
    """One confidence threshold per class: the one that reproduces the most annotation counts on validation."""
    labels = defaultdict(lambda: defaultdict(int))
    for stem in val:
        for line in open(f"{DATA}/labels/val/{stem}.txt"):
            if line.strip():
                labels[stem][NAMES[int(line.split()[0])]] += 1
    thresholds = {cls: max(THRESHOLDS, key=lambda t: (sum(count(val[s], cls, t) == labels[s][cls] for s in val), -abs(t - 0.4)))
                  for cls in NAMES}
    if RULES:
        thresholds.update(rule_thresholds(val, labels))
    return thresholds


def score(dets, stems, truth, thresholds, label):
    per_kind, total, right = {}, 0, 0
    for kind, weights in COUNT_WEIGHTS.items():
        asked = [(s, truth[s]["stoa"][kind]) for s in stems if kind in truth[s]["stoa"]]
        got = [sum(w * answer(dets[s], c, thresholds[c]) for c, w in weights.items()) for s, _ in asked]
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
    if RULES:
        val, held = apply_rules(val, "val", out_dir), apply_rules(held, part, out_dir)
    thresholds = tune(val)
    print("thresholds from validation:", thresholds)
    result = dict(extra, thresholds=thresholds)
    if RULES:
        result["count_rules"] = RULES
    if WEIGHTED:
        print("count weights:", COUNT_WEIGHTS)
        result["count_weights"] = COUNT_WEIGHTS
    result["val"] = score(val, list(val), truth, thresholds, "VALIDATION (thresholds tuned here)")
    result[part] = score(held, list(held), truth, thresholds, part.upper())
    panes = RULES.get("panes")
    if panes and any(len(d) > 4 for rows in val.values() for d in rows):
        # For information: the count if every run counted the panes read from it, whatever the drawing rule says.
        def read_exact(dets):
            asked = [s for s in dets if panes["kind"] in truth[s]["stoa"]]
            return [sum(sum(d[4] for d in dets[s] if d[0] == panes["class"] and d[1] >= thresholds[panes["class"]])
                        == truth[s]["stoa"][panes["kind"]] for s in asked), len(asked)]
        result["panes_read"] = {"val": read_exact(val), part: read_exact(held)}
        print(f"{panes['kind']} if every run counted the panes read from it:", result["panes_read"])
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
