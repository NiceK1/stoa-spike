"""A segmentation model for the annotated unit, and what its mask is worth as a gate on window and door detections.

    unitseg.py build                               # /data/sweep/data/yolo_unitseg from the SVG annotations, with checks
    unitseg.py eval <run> <train exit> <batch>     # masks for val and dev, mask IoU, the gate table -> results/<run>.json
    unitseg.py export <run>                        # ONNX, CPU seconds per drawing, ONNX against PyTorch masks

One class, "unit": each connected piece of the union of a drawing's annotated rooms, walls, railings, windows and doors
is one instance, which on a sheet with several floors is one per floor. Courtyards and other holes are filled, since
a polygon label has no holes. Sweep split; the test part is never read.
The gate drops base's detections whose centre lies outside the predicted mask grown by a margin. The margin is the one
with the most exact counts on validation; no gate and the oracle mask (probes.py) are scored next to it.
"""
import csv
import json
import os
import sys
import time
from multiprocessing import Pool

import cv2
import numpy as np

sys.path.insert(0, "/data")
sys.path.insert(0, "/data/sweep")
import build_dataset as B  # noqa: E402
import probes as Pr  # noqa: E402

ROOT = "/data/sweep"
SOURCE = f"{ROOT}/data/yolo_sym"
OUT = f"{ROOT}/data/yolo_unitseg"
PARTS = ("train", "dev", "val")
IMGSZ = 1280
CONF = 0.25
# Pieces of the unit smaller than this many mask pixels (MASK_SIDE on the long side) get no label.
MIN_PIECE = 100
MARGINS = (0, 5, 10, 15, 20, 30, 40, 60)
EXPORT_NAME = "floorplan-unitseg-yolo11l-1280"


def pieces(mask):
    """Outlines of the connected pieces of a mask, after closing hairline gaps."""
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return [cv2.approxPolyDP(c, 1.0, True)[:, 0, :] for c in contours if cv2.contourArea(c) >= MIN_PIECE]


def build_job(args):
    d, part = args
    stem = d["stem"]
    mask, s = Pr.unit_area(d)
    outlines = [o for o in pieces(mask) if len(o) >= 3]
    link = f"{OUT}/images/{part}/{stem}.png"
    if not os.path.lexists(link):
        os.symlink(os.path.realpath(f"{SOURCE}/images/{part}/{stem}.png"), link)
    with open(f"{OUT}/labels/{part}/{stem}.txt", "w") as f:
        f.write("\n".join("0 " + " ".join(f"{min(1.0, max(0.0, x / (d['width'] * s))):.5f} {min(1.0, max(0.0, y / (d['height'] * s))):.5f}"
                                           for x, y in o) for o in outlines))
    if part != "train":
        cv2.imwrite(f"{OUT}/masks/{stem}.png", mask * 255)
    drawn = np.zeros_like(mask)
    cv2.fillPoly(drawn, [o.astype(np.int32) for o in outlines], 1)
    union = int((drawn | mask).sum())
    return part, stem, len(outlines), float(mask.mean()), (int((drawn & mask).sum()) / union if union else 1.0)


def build():
    part_of = {l.strip(): p for p in PARTS for l in open(f"{SOURCE}/splits/{p}.txt") if l.strip()}
    for part in PARTS:
        os.makedirs(f"{OUT}/images/{part}", exist_ok=True)
        os.makedirs(f"{OUT}/labels/{part}", exist_ok=True)
    os.makedirs(f"{OUT}/masks", exist_ok=True)
    os.makedirs(f"{OUT}/splits", exist_ok=True)
    feats = [d for d in (json.loads(l) for l in open(B.FEATURES)) if d["stem"] in part_of]
    with Pool(12) as pool:
        rows = pool.map(build_job, [(d, part_of[d["stem"]]) for d in feats], chunksize=16)
    for part in PARTS:
        with open(f"{OUT}/splits/{part}.txt", "w") as f:
            f.write("\n".join(sorted(s for s, p in part_of.items() if p == part)) + "\n")
    with open(f"{OUT}/data.yaml", "w") as f:
        f.write(f"path: {OUT}\ntrain: images/train\nval: images/val\nnames:\n  0: unit\n")
    floors = {d["stem"]: d["floors"] for d in feats}
    print("yolo_unitseg: class unit; pieces of the annotated unit as polygons (holes filled)")
    for part in PARTS:
        mine = [r for r in rows if r[0] == part]
        n = [r[2] for r in mine]
        print(f"   {part}: {len(mine)} drawings, {sum(n)} instances; drawings by instances "
              f"{ {k: sum(v == k for v in n) for k in sorted(set(n))} }; no instance {sum(v == 0 for v in n)}; "
              f"instances equal to the sheet's floors {sum(r[2] == floors[r[1]] for r in mine)}; "
              f"unit covers {np.mean([r[3] for r in mine]):.1%} of the sheet; "
              f"IoU of the polygons with the annotated mask: mean {np.mean([r[4] for r in mine]):.4f}, "
              f"lowest {min(r[4] for r in mine):.3f}, under 0.9 on {sum(r[4] < 0.9 for r in mine)}")


def stems_of(part):
    return [l.strip() for l in open(f"{OUT}/splits/{part}.txt") if l.strip()]


def oracle_mask(stem):
    return (cv2.imread(f"{OUT}/masks/{stem}.png", cv2.IMREAD_GRAYSCALE) > 0).astype(np.uint8)


def predict_masks(run, limit=None):
    """The model's union mask per val and dev drawing, on the grid of the annotated mask; saved under eval/<run>/masks."""
    from ultralytics import YOLO
    model = YOLO(f"{ROOT}/runs/{run}/weights/best.pt")
    os.makedirs(f"{ROOT}/eval/{run}/masks", exist_ok=True)
    for part in ("val", "dev"):
        for stem in stems_of(part)[:limit]:
            shape = oracle_mask(stem).shape
            r = model.predict(f"{OUT}/images/{part}/{stem}.png", imgsz=IMGSZ, conf=CONF, retina_masks=True, verbose=False)[0]
            mask = np.zeros(shape, np.uint8)
            if r.masks is not None and len(r.masks.data):
                union = r.masks.data.any(0).cpu().numpy().astype(np.uint8)
                mask = cv2.resize(union, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
            cv2.imwrite(f"{ROOT}/eval/{run}/masks/{stem}.png", mask * 255)


def predicted_mask(run, stem):
    return (cv2.imread(f"{ROOT}/eval/{run}/masks/{stem}.png", cv2.IMREAD_GRAYSCALE) > 0).astype(np.uint8)


def overlap(a, b):
    union = int((a | b).sum())
    return int((a & b).sum()) / union if union else 1.0


def mask_iou(run):
    out = {}
    for part in ("val", "dev"):
        pairs = [(predicted_mask(run, s), oracle_mask(s)) for s in stems_of(part)]
        each = sorted(overlap(p, o) for p, o in pairs)
        out[part] = {"drawings": len(each), "mean": round(float(np.mean(each)), 4), "median": round(each[len(each) // 2], 4),
                     "pooled": round(sum(int((p & o).sum()) for p, o in pairs) / sum(int((p | o).sum()) for p, o in pairs), 4),
                     "share_at_least_0.9": round(sum(v >= 0.9 for v in each) / len(each), 4),
                     "empty_predictions": sum(not p.any() for p, _ in pairs)}
    return out


def gate(run):
    """Exact window and door counts of base under no gate, the oracle gate and the predicted gate, val and dev."""
    part_of, feats, truth = Pr.load()
    thr = Pr.thresholds_of("base")
    stems = {p: stems_of(p) for p in ("val", "dev")}
    scale = {s: Pr.MASK_SIDE / max(feats[s]["width"], feats[s]["height"]) for p in stems for s in stems[p]}
    oracle = {s: Pr.grown(oracle_mask(s), Pr.GATE_MARGIN) for p in stems for s in stems[p]}
    predicted = {s: predicted_mask(run, s) for p in stems for s in stems[p]}

    def predicted_gate(margin):
        # A drawing on which the model finds no unit is left ungated.
        return {s: Pr.grown(m, margin) if m.any() else None for s, m in predicted.items()}

    table = {}
    for kind, cls in (("windows", "window"), ("doors", "door")):
        asked, answer, raw = {}, {}, {}
        for part in ("val", "dev"):
            dets = Pr.run_dets("base", part)
            asked[part] = [s for s in stems[part] if kind in truth[s]["stoa"]]
            answer.update({s: truth[s]["stoa"][kind] for s in asked[part]})
            raw.update({s: [(p, b) for c, p, b in dets[s] if c == cls] for s in asked[part]})

        def measure(masks):
            kept = {s: [p for p, b in raw[s] if masks[s] is None or Pr.in_mask(masks[s], scale[s], b)] for s in raw}
            refit = Pr.best_threshold({s: kept[s] for s in asked["val"]}, answer)
            row = {"threshold_refitted_on_val": refit}
            for part in ("val", "dev"):
                objects = [x["box"] for s in asked[part] for x in feats[s][kind]
                           if kind == "windows" or not x["kind"].startswith("None")]
                row[part] = {
                    "asked": len(asked[part]),
                    "exact_at_base_threshold": sum(sum(p >= thr[cls] for p in kept[s]) == answer[s] for s in asked[part]),
                    "exact_refitted": sum(sum(p >= refit for p in kept[s]) == answer[s] for s in asked[part]),
                    "detections_dropped": sum(sum(p >= thr[cls] for p, _ in raw[s]) - sum(p >= thr[cls] for p in kept[s])
                                              for s in asked[part]),
                    "annotated_objects_outside": sum(
                        masks[s] is not None and not Pr.in_mask(masks[s], scale[s], x["box"])
                        for s in asked[part] for x in feats[s][kind] if kind == "windows" or not x["kind"].startswith("None")),
                    "annotated_objects": len(objects)}
            row["right"] = {s: sum(p >= refit for p in kept[s]) == answer[s] for s in asked["dev"]}
            return row

        none = measure({s: None for s in raw})
        by_margin = {m: measure(predicted_gate(m)) for m in MARGINS}
        best = max(MARGINS, key=lambda m: (by_margin[m]["val"]["exact_refitted"], by_margin[m]["val"]["exact_at_base_threshold"], m))
        chosen = by_margin[best]
        base_right = {s: sum(p >= thr[cls] for p, _ in raw[s]) == answer[s] for s in asked["dev"]}
        wins = sum(chosen["right"][s] and not base_right[s] for s in asked["dev"])
        losses = sum(base_right[s] and not chosen["right"][s] for s in asked["dev"])

        def shown(row):
            return {k: v for k, v in row.items() if k != "right"}

        table[kind] = {
            "no_gate": shown(none), f"oracle_mask_grown_{Pr.GATE_MARGIN}px": shown(measure(oracle)),
            "predicted_mask": dict(shown(chosen), margin_px_at_1280=best, chosen_on="val exact counts, threshold refitted",
                                   dev_against_no_gate={"wins": wins, "losses": losses, "sign_test_p": round(Pr.sign_test(wins, losses), 4)}),
            "predicted_mask_by_margin": {str(m): {p: [r[p]["exact_at_base_threshold"], r[p]["exact_refitted"]] for p in ("val", "dev")}
                                         for m, r in by_margin.items()},
            "columns_by_margin": "[exact at base's threshold, exact with the threshold refitted on val]"}
    return table


def training(run):
    try:
        rows = [{k.strip(): v.strip() for k, v in r.items()} for r in csv.DictReader(open(f"{ROOT}/runs/{run}/results.csv"))]
    except OSError:
        return {}
    best = max(rows, key=lambda r: float(r.get("metrics/mAP50-95(M)") or 0))
    return {"epochs_run": len(rows), "minutes": {"train": round(float(rows[-1]["time"]) / 60, 1)},
            "best_epoch": {"epoch": int(float(best["epoch"])), "mask_mAP50": float(best.get("metrics/mAP50(M)") or 0),
                           "mask_mAP50-95": float(best.get("metrics/mAP50-95(M)") or 0)}}


def write(run, fields):
    path = f"{ROOT}/results/{run}.json"
    result = json.load(open(path)) if os.path.exists(path) else {"name": run}
    result.update(fields)
    json.dump(result, open(path + ".tmp", "w"), indent=1)
    os.replace(path + ".tmp", path)


def evaluate(run, train_exit, batch):
    result = dict({"status": "ok" if train_exit == 0 else "truncated", "train_exit": train_exit, "batch_used": batch,
                   "epochs_planned": 60, "weights": f"{ROOT}/runs/{run}/weights/best.pt", "imgsz": IMGSZ, "conf": CONF,
                   "masks": f"{ROOT}/eval/{run}/masks/<stem>.png (val and dev, {Pr.MASK_SIDE} on the long side)"}, **training(run))
    if not os.path.exists(result["weights"]):
        return write(run, dict(result, status="failed", error="no weights", log_tail=open(f"{ROOT}/logs/{run}.log", errors="replace")
                               .read().replace("\r", "\n").splitlines()[-15:]))
    predict_masks(run)
    result["mask_iou"] = mask_iou(run)
    result["gate"] = table = gate(run)

    def cell(kind):
        t = table[kind]
        oracle = next(v for k, v in t.items() if k.startswith("oracle"))
        return (f"{kind} dev {t['no_gate']['dev']['exact_at_base_threshold']} -> {t['predicted_mask']['dev']['exact_refitted']} "
                f"(oracle {oracle['dev']['exact_refitted']}) of {t['no_gate']['dev']['asked']}")

    result["summary"] = f"unit mask IoU dev {result['mask_iou']['dev']['mean']}; {cell('doors')}; {cell('windows')}"
    write(run, result)
    print(json.dumps(result, indent=1))


def letterbox(image):
    h, w = image.shape[:2]
    scale = min(IMGSZ / w, IMGSZ / h)
    nw, nh = round(w * scale), round(h * scale)
    canvas = np.full((IMGSZ, IMGSZ, 3), 114, np.uint8)
    left, top = (IMGSZ - nw) // 2, (IMGSZ - nh) // 2
    canvas[top:top + nh, left:left + nw] = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0, (left, top, nw, nh)


def onnx_mask(outputs, placed, shape):
    """Union mask of the rows an NMS-in-graph export returns, on the grid of the annotated mask."""
    rows, protos = outputs[0][0], outputs[1][0]
    side = protos.shape[-1]
    k = side / IMGSZ
    union = np.zeros((side, side), bool)
    for row in rows[rows[:, 4] >= CONF]:
        mask = (row[6:] @ protos.reshape(protos.shape[0], -1)).reshape(side, side) > 0
        x0, y0, x1, y1 = row[:4] * k
        box = np.zeros_like(mask)
        box[max(0, int(y0)):int(np.ceil(y1)), max(0, int(x0)):int(np.ceil(x1))] = True
        union |= mask & box
    left, top, nw, nh = (round(v * k) for v in placed)
    return cv2.resize(union[top:top + nh, left:left + nw].astype(np.uint8), (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)


def export(run):
    import shutil

    import onnxruntime as ort
    from ultralytics import YOLO
    model = YOLO(f"{ROOT}/runs/{run}/weights/best.pt")
    settings = dict(format="onnx", imgsz=IMGSZ, opset=17, simplify=True, dynamic=False, half=False, device="cpu")
    try:
        exported, nms = model.export(nms=True, conf=CONF, iou=0.6, max_det=20, **settings), True
    except Exception as e:  # an export without NMS still gives the app a model
        print("export with NMS in the graph failed:", repr(e))
        exported, nms = model.export(**settings), False
    os.makedirs(f"{ROOT}/export", exist_ok=True)
    target = f"{ROOT}/export/{EXPORT_NAME}.onnx"
    shutil.copy(exported, target)
    session = ort.InferenceSession(target, providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    seconds, agreement = [], []
    for stem in stems_of("val")[:12]:
        tensor, placed = letterbox(cv2.imread(f"{OUT}/images/val/{stem}.png", cv2.IMREAD_COLOR))
        started = time.time()
        outputs = session.run(None, {feed: tensor})
        seconds.append(time.time() - started)
        if nms:
            try:
                reference = predicted_mask(run, stem)
                agreement.append(overlap(onnx_mask(outputs, placed, reference.shape), reference))
            except Exception as e:
                print("ONNX mask not decoded:", repr(e))
    result = json.load(open(f"{ROOT}/results/{run}.json")) if os.path.exists(f"{ROOT}/results/{run}.json") else {}
    margins = {k: v["predicted_mask"]["margin_px_at_1280"] for k, v in result.get("gate", {}).items()}
    spec = {
        "model": f"{EXPORT_NAME}.onnx", "size_mb": round(os.path.getsize(target) / 1e6, 1),
        "source": "Ultralytics YOLO (AGPL-3.0), trained on CubiCasa5k annotations (CC BY-NC-SA 4.0)",
        "input": {"name": feed, "shape": [1, 3, IMGSZ, IMGSZ], "layout": "NCHW", "channels": "RGB", "range": "0..1",
                  "preprocess": f"letterbox to {IMGSZ}x{IMGSZ} on grey 114, as for the detectors"},
        "outputs": {o.name: list(v.shape) for o, v in zip(session.get_outputs(), outputs)},
        "nms_in_graph": nms,
        "mask": "rows are [x1, y1, x2, y2, confidence, class, 32 coefficients]; a row's mask is (coefficients . prototypes) > 0 "
                f"inside its box at a quarter of the canvas; the unit is the union over rows with confidence >= {CONF}",
        "gate": "drop a detection whose centre is outside the unit grown by margin_px_at_1280; no unit found: keep everything",
        "margin_px_at_1280": margins,
        "cpu_seconds_per_drawing_on_instance": round(float(np.median(seconds)), 3),
        "onnx_against_pytorch_mask_iou_on_12_val_drawings": round(float(np.mean(agreement)), 4) if agreement else None,
    }
    json.dump(spec, open(f"{ROOT}/export/{EXPORT_NAME}.json", "w"), indent=1)
    write(run, {"onnx": spec})
    print(json.dumps(spec, indent=1))


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "build":
        build()
    elif command == "eval":
        evaluate(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    else:
        export(sys.argv[2])
