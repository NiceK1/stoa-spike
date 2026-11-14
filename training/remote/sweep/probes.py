"""CPU probes on the sweep split that decide the window and door label design.

    probes.py paired [run ...]     # exact counts on dev per run, wins and losses per drawing against base, sign test
    probes.py convention           # pane-level / unit-level / both / none per drawing -> probe/convention.json
    probes.py gate                 # unit gate: oracle (annotated rooms and walls) and practical (m1280 boxes), val and dev
    probes.py doors                # contact sheets of confident base door detections on val that match no annotation

Reads train, val and dev only. Thresholds are the ones each run tuned on validation.
"""
import json
import math
import os
import random
import sys
from collections import Counter, defaultdict

sys.path.insert(0, "/data")
sys.path.insert(0, "/data/sweep")
import build_dataset as B  # noqa: E402
import build_symrun as S  # noqa: E402

ROOT = "/data/sweep"
DATA = f"{ROOT}/data/yolo_sym"
OUT = f"{ROOT}/probe"
PARTS = ("train", "val", "dev")
KINDS = {"windows": ["window"], "doors": ["door"], "toilets": ["toilet"], "sinks": ["sink"],
         "showers_bathtubs": ["shower", "bathtub"]}
# Lowest score at which a window detection counts as evidence that the detector sees a pane.
LOW = 0.2
MASK_SIDE = 1024
# Dilation of the unit mask, in pixels at 1280 on the long side.
GATE_MARGIN = 10


def load():
    part_of = {l.strip(): p for p in PARTS for l in open(f"{DATA}/splits/{p}.txt") if l.strip()}
    feats = {}
    for line in open(B.FEATURES):
        d = json.loads(line)
        if d["stem"] in part_of:
            feats[d["stem"]] = d
    return part_of, feats, json.load(open("/data/yolo/truth.json"))


def run_dets(name, part):
    return json.load(open(f"{ROOT}/eval/{name}/{part}.json"))


def thresholds_of(name):
    return json.load(open(f"{ROOT}/eval/{name}/report.json"))["thresholds"]


def kind_count(dets, classes, thr):
    return sum(1 for c, p, _ in dets if c in classes and p >= thr[c])


def sign_test(wins, losses):
    n, k = wins + losses, min(wins, losses)
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def paired(names):
    _, _, truth = load()
    right = {}
    for name in names:
        if not os.path.exists(f"{ROOT}/eval/{name}/report.json"):
            print(f"{name}: not finished, left out")
            continue
        thr, dets = thresholds_of(name), run_dets(name, "dev")
        right[name] = {(s, k): kind_count(dets[s], cs, thr) == truth[s]["stoa"][k]
                       for s in dets for k, cs in KINDS.items() if k in truth[s]["stoa"]}
    base = right["base"]
    print(f"\n{'run':9} {'kind':17} {'exact':>9} {'share':>6}   wins losses vs base   sign test p")
    for name, ok in right.items():
        for kind in list(KINDS) + ["all"]:
            keys = [key for key in ok if kind in ("all", key[1])]
            wins = sum(ok[key] and not base[key] for key in keys)
            losses = sum(base[key] and not ok[key] for key in keys)
            n = sum(ok[key] for key in keys)
            versus = "" if name == "base" else f"{wins:4} {losses:6}             {sign_test(wins, losses):.3f}"
            print(f"{name:9} {kind:17} {n:4}/{len(keys):4} {n / len(keys):6.1%}   {versus}")


def padded(box, pad):
    x0, y0, x1, y1 = box
    if x1 - x0 < pad:
        x0, x1 = (x0 + x1) / 2 - pad / 2, (x0 + x1) / 2 + pad / 2
    if y1 - y0 < pad:
        y0, y1 = (y0 + y1) / 2 - pad / 2, (y0 + y1) / 2 + pad / 2
    return [x0, y0, x1, y1]


def inter(a, b):
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def iou(a, b):
    i = inter(a, b)
    return i / max(1e-9, B.area(a) + B.area(b) - i)


def boxes_on(annotation, dets, pad, low=LOW):
    """Number of separate window detections lying along one annotated window, each clearly shorter than it."""
    a = padded(annotation, pad)
    horizontal = a[2] - a[0] >= a[3] - a[1]
    length = max(a[2] - a[0], a[3] - a[1])
    keep = []
    for p, b in sorted(dets, reverse=True):
        if p < low or inter(a, b) < 0.7 * B.area(b):
            continue
        if (b[2] - b[0] if horizontal else b[3] - b[1]) > 0.8 * length:
            continue
        if all(iou(b, k) < 0.3 for k in keep):
            keep.append(b)
    return len(keep)


def det_runs(boxes, d):
    """Detected window boxes grouped the way build_symrun groups annotations."""
    reach = S.GAP_PX * max(d["width"], d["height"]) / 1280
    parent = list(range(len(boxes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(boxes):
        for j in range(i + 1, len(boxes)):
            if S.gap(a, boxes[j]) <= reach and S.fill(a, boxes[j]) >= S.MIN_FILL:
                parent[find(i)] = find(j)
    return len({find(i) for i in range(len(boxes))})


def convention():
    part_of, feats, truth = load()
    dets = {"val": run_dets("base", "val"), "dev": run_dets("base", "dev"),
            "train": json.load(open(f"{OUT}/base_train.json"))}
    thr = thresholds_of("base")["window"]
    rows = {}
    for stem, d in feats.items():
        part = part_of[stem]
        windows = [(p, b) for c, p, b in dets[part][stem] if c == "window"]
        pad = B.MIN_SIDE_SHARE * max(d["width"], d["height"])
        groups = S.runs(d)
        split = [boxes_on(w["box"], windows, pad) for w in d["windows"]]
        multi, unit = sum(len(g) > 1 for g in groups), sum(n >= 2 for n in split)
        label = ("nowin" if not groups else "both" if multi and unit else "pane" if multi else "unit" if unit else "none")
        kept = [b for p, b in windows if p >= thr]
        rows[stem] = {"part": part, "label": label, "windows": len(d["windows"]), "runs": len(groups), "multi_runs": multi,
                      "unit_windows": unit, "unit_windows_strict": sum(boxes_on(w["box"], windows, pad, 0.4) >= 2 for w in d["windows"]),
                      "prefix": stem.rsplit("-", 1)[0], "long_side": max(d["width"], d["height"]), "floors": d["floors"],
                      "det_count": len(kept), "det_runs": det_runs(kept, d), "stoa": truth[stem]["stoa"].get("windows")}
    json.dump(rows, open(f"{OUT}/convention.json", "w"))

    labels = ("pane", "unit", "both", "none", "nowin")
    print(f"convention labels (unit-level evidence: two or more base detections >= {LOW} along one annotated window)")
    for part in PARTS + ("all",):
        c = Counter(r["label"] for r in rows.values() if part in ("all", r["part"]))
        n = sum(c.values())
        shown = c["pane"] + c["unit"] + c["both"]
        print(f"   {part:5} {n:5} drawings: " + ", ".join(f"{l} {c[l]} ({c[l] / n:.1%})" for l in labels)
              + f" | of the {shown} showing a convention, both: {c['both'] / max(1, shown):.1%}")
    strict = Counter(("both" if r["multi_runs"] and r["unit_windows_strict"] else "pane" if r["multi_runs"] else
                      "unit" if r["unit_windows_strict"] else "none") for r in rows.values() if r["label"] != "nowin")
    print(f"   same with detections >= 0.4 only: {dict(strict)}")
    both = [r for r in rows.values() if r["label"] == "both"]
    print(f"   in 'both' drawings: median multi-annotation runs {sorted(r['multi_runs'] for r in both)[len(both) // 2]}, "
          f"median split windows {sorted(r['unit_windows'] for r in both)[len(both) // 2]}; "
          f"both with >= 2 of each: {sum(r['multi_runs'] >= 2 and r['unit_windows'] >= 2 for r in both)}")

    def table(title, key):
        print(f"\n   {title:28} " + " ".join(f"{l:>6}" for l in labels[:4]) + "   pane share of pane+unit")
        cells = defaultdict(Counter)
        for r in rows.values():
            if r["label"] != "nowin":
                cells[key(r)][r["label"]] += 1
        for k in sorted(cells):
            c = cells[k]
            print(f"   {str(k):28} " + " ".join(f"{c[l]:6}" for l in labels[:4])
                  + f"   {c['pane'] / max(1, c['pane'] + c['unit']):.1%}")

    sides = sorted(r["long_side"] for r in rows.values())
    cuts = [sides[len(sides) * q // 4] for q in (1, 2, 3)]
    table("file-name prefix", lambda r: r["prefix"])
    table("floors on the sheet", lambda r: min(r["floors"], 3))
    table(f"long side (quartile cuts {cuts})", lambda r: sum(r["long_side"] > c for c in cuts))
    table("annotated windows", lambda r: min(4, r["windows"] // 5) * 5)

    print("\ndecision level with base detections (windows, exact against Stoa's answer):")
    for part in ("val", "dev"):
        asked = [r for r in rows.values() if r["part"] == part and r["stoa"] is not None]
        today = sum(r["det_count"] == r["stoa"] for r in asked)
        as_runs = sum(r["det_runs"] == r["stoa"] for r in asked)
        oracle = sum((r["det_runs"] if r["label"] == "unit" else r["det_count"]) == r["stoa"] for r in asked)
        either = sum(r["stoa"] in (r["det_runs"], r["det_count"]) for r in asked)
        print(f"   {part}: today {today}/{len(asked)}; every drawing counted as runs {as_runs}; true label decides "
              f"(unit -> runs, else boxes) {oracle}; better of the two per drawing {either}")
        for label in labels[:4]:
            mine = [r for r in asked if r["label"] == label]
            print(f"      {label:5} {len(mine):4} drawings: boxes exact {sum(r['det_count'] == r['stoa'] for r in mine):4}, "
                  f"runs exact {sum(r['det_runs'] == r['stoa'] for r in mine):4}")


def unit_polygons(d):
    """Room and wall polygons of the annotated unit, in pixels of the Stoa image."""
    import parse_svg as P
    from lxml import etree
    category, plan = d["stem"].rsplit("-", 1)
    folder = f"{P.CUBI}/{category}/{plan}"
    scaled_w, scaled_h = P.png_size(f"{folder}/F1_scaled.png")
    sx, sy = d["width"] / scaled_w, d["height"] / scaled_h
    polygons = []

    def walk(el, matrix):
        for child in el:
            if not isinstance(child.tag, str):
                continue
            m = P.compose(matrix, P.parse_transform(child.get("transform")))
            head = ((child.get("class") or "").split() or [""])[0]
            if head in ("Space", "Wall", "Railing"):
                for g in child:
                    if isinstance(g.tag, str) and etree.QName(g).localname == "polygon":
                        polygons.append([(x * sx, y * sy) for x, y in (P.apply(m, *pt) for pt in P.own_points(g))])
                continue
            walk(child, m)

    walk(etree.parse(f"{folder}/model.svg").getroot(), P.IDENTITY)
    return polygons


def unit_mask(d):
    import cv2
    import numpy as np
    s = MASK_SIDE / max(d["width"], d["height"])
    mask = np.zeros((math.ceil(d["height"] * s) + 1, math.ceil(d["width"] * s) + 1), np.uint8)
    for poly in unit_polygons(d):
        if len(poly) >= 3:
            cv2.fillPoly(mask, [np.round(np.array(poly) * s).astype(np.int32)], 1)
    for item in d["windows"] + d["doors"]:
        x0, y0, x1, y1 = (round(v * s) for v in item["box"])
        mask[max(0, y0):y1 + 1, max(0, x0):x1 + 1] = 1
    r = round(GATE_MARGIN * MASK_SIDE / 1280)
    return cv2.dilate(mask, np.ones((2 * r + 1, 2 * r + 1), np.uint8)), s


def in_mask(mask, s, box):
    x, y = round((box[0] + box[2]) / 2 * s), round((box[1] + box[3]) / 2 * s)
    return 0 <= y < mask.shape[0] and 0 <= x < mask.shape[1] and bool(mask[y, x])


def mask_job(d):
    import numpy as np
    mask, s = unit_mask(d)
    np.save(f"{OUT}/masks/{d['stem']}.npy", mask)
    return d["stem"], s


def masks_for(feats, stems):
    from multiprocessing import Pool
    os.makedirs(f"{OUT}/masks", exist_ok=True)
    with Pool(20) as pool:
        return dict(pool.imap_unordered(mask_job, [feats[s] for s in stems], chunksize=8))


def load_mask(stem):
    import numpy as np
    return np.load(f"{OUT}/masks/{stem}.npy")


def best_threshold(per_drawing, truth_of):
    """Threshold with the most exact counts; per_drawing is {stem: [scores]}."""
    grid = [round(0.05 + 0.025 * i, 3) for i in range(35)]
    return max(grid, key=lambda t: (sum(sum(p >= t for p in ps) == truth_of[s] for s, ps in per_drawing.items()), -abs(t - 0.4)))


def gate():
    part_of, feats, truth = load()
    thr = thresholds_of("base")
    stems = {p: sorted(s for s, q in part_of.items() if q == p) for p in ("val", "dev")}
    scale = masks_for(feats, stems["val"] + stems["dev"])
    m1280 = json.load(open("/data/eval/m1280-1280-iou0.6/val.json"))
    m_thr = json.load(open("/data/eval/m1280-1280-iou0.6/report.json"))["thresholds"]

    def floor_boxes(stem, margin, least=None):
        d = feats[stem]
        pad = margin * max(d["width"], d["height"])
        return [[b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad] for c, p, b in m1280[stem]
                if c == "floor" and p >= (least or m_thr["floor"])]

    def annotated_floors(stem, margin):
        d = feats[stem]
        pad = margin * max(d["width"], d["height"])
        return [[b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad] for name, b in B.objects(d) if name == "floor"]

    def all_box(stem, margin):
        d = feats[stem]
        pad = margin * max(d["width"], d["height"])
        boxes = [b for c, p, b in m1280[stem] if c != "floor" and p >= m_thr[c]]
        return [[min(b[0] for b in boxes) - pad, min(b[1] for b in boxes) - pad, max(b[2] for b in boxes) + pad,
                 max(b[3] for b in boxes) + pad]] if boxes else []

    def centre_in(boxes, b):
        return any(B.inside(q, B.center(b)) for q in boxes) if boxes else True

    hulls = {}

    def in_hull(dets, s, b, margin):
        """Inside the convex hull of the drawing's window and fixture detections, grown by a share of the long side."""
        import cv2
        import numpy as np
        if s not in hulls:
            corners = [(x, y) for c, p, q in dets[s] if c not in ("door", "doorway") and p >= thr[c]
                       for x in (q[0], q[2]) for y in (q[1], q[3])]
            hulls[s] = cv2.convexHull(np.array(corners, np.float32)) if len(corners) >= 12 else None
        if hulls[s] is None:
            return True
        d = feats[s]
        return cv2.pointPolygonTest(hulls[s], B.center(b), True) >= -margin * max(d["width"], d["height"])

    for kind, cls in (("windows", "window"), ("doors", "door")):
        print(f"\nunit gate, {kind} (base detections; exact against Stoa's answer)")
        fitted = {}
        for part in ("val", "dev"):
            dets = run_dets("base", part)
            asked = [s for s in stems[part] if kind in truth[s]["stoa"]]
            answer = {s: truth[s]["stoa"][kind] for s in asked}
            masks = {s: load_mask(s) for s in asked}
            raw = {s: [(p, b) for c, p, b in dets[s] if c == cls] for s in asked}
            rules = {"no gate": lambda s, b: True,
                     "oracle: rooms and walls": lambda s, b: in_mask(masks[s], scale[s], b),
                     "oracle: box per floor +1%": lambda s, b: centre_in(annotated_floors(s, 0.01), b)}
            if kind == "doors":
                rules["hull of windows, fixtures +2%"] = lambda s, b: in_hull(dets, s, b, 0.02)
                rules["hull of windows, fixtures +5%"] = lambda s, b: in_hull(dets, s, b, 0.05)
            if part == "val":
                rules["m1280 floor boxes +1.5%"] = lambda s, b: centre_in(floor_boxes(s, 0.015), b)
                rules["m1280 floor boxes >= 0.1, +3%"] = lambda s, b: centre_in(floor_boxes(s, 0.03, 0.1), b)
                rules["box round m1280 detections +3%"] = lambda s, b: centre_in(all_box(s, 0.03), b)
            for rule, keep in rules.items():
                kept = {s: [p for p, b in raw[s] if keep(s, b)] for s in asked}
                fixed = sum(sum(p >= thr[cls] for p in kept[s]) == answer[s] for s in asked)
                if part == "val":
                    fitted[rule] = best_threshold(kept, answer)
                t = fitted.get(rule)
                refit = "" if t is None else f"   threshold refitted on val ({t}): {sum(sum(p >= t for p in kept[s]) == answer[s] for s in asked)}"
                dropped = sum(sum(p >= thr[cls] for p, _ in raw[s]) for s in asked) - sum(sum(p >= thr[cls] for p in kept[s]) for s in asked)
                true_dropped = 0
                if rule != "no gate":
                    key = "windows" if kind == "windows" else "doors"
                    true_dropped = sum(not keep(s, x["box"]) for s in asked for x in feats[s][key]
                                       if kind == "windows" or not x["kind"].startswith("None"))
                print(f"   {part} {rule:32} {fixed:4}/{len(asked)} = {fixed / len(asked):.1%} at the run's threshold{refit}"
                      f"   detections dropped {dropped}, annotated objects outside {true_dropped}")


def doors():
    from PIL import Image, ImageDraw
    part_of, feats, truth = load()
    thr = thresholds_of("base")["door"]
    dets = run_dets("base", "val")
    stems = sorted(dets)
    scale = masks_for(feats, stems)
    unmatched, confident = [], 0
    for s in stems:
        d = feats[s]
        mask = load_mask(s)
        counted = [x["box"] for x in d["doors"] if not x["kind"].startswith("None")]
        doorways = [x["box"] for x in d["doors"] if x["kind"].startswith("None")]
        for c, p, b in dets[s]:
            if c != "door" or p < thr:
                continue
            confident += 1
            if any(iou(b, a) >= 0.1 for a in counted):
                continue
            unmatched.append({"stem": s, "score": p, "box": b, "in_unit": in_mask(mask, scale[s], b),
                              "on_doorway": any(iou(b, a) >= 0.1 for a in doorways),
                              "on_window": any(inter(b, w["box"]) > 0 for w in d["windows"]),
                              "near_door": any(S.gap(b, a) < 0.5 * max(b[2] - b[0], b[3] - b[1]) for a in counted),
                              "asked": "doors" in truth[s]["stoa"]})
    n = len(unmatched)
    print(f"val: {confident} door detections >= {thr}; {n} overlap no annotated door with a leaf (IoU < 0.1)")
    print(f"   outside the unit mask {sum(not u['in_unit'] for u in unmatched)}, on an annotated leafless doorway "
          f"{sum(u['on_doorway'] for u in unmatched)}, touching an annotated window {sum(u['on_window'] for u in unmatched)}, "
          f"within half a box of an annotated door {sum(u['near_door'] for u in unmatched)}")
    print("   by score: " + ", ".join(f">= {t}: {sum(u['score'] >= t for u in unmatched)}" for t in (0.35, 0.5, 0.7, 0.85)))
    pick = random.Random(7).sample(unmatched, min(30, n))
    json.dump({"all": unmatched, "picked": pick}, open(f"{OUT}/doors_unmatched.json", "w"))
    tile, cols = 400, 5
    for sheet in range(0, len(pick), 15):
        canvas = Image.new("RGB", (cols * tile, 3 * tile), "white")
        for k, u in enumerate(pick[sheet:sheet + 15]):
            d = feats[u["stem"]]
            image = Image.open(f"{DATA}/images/val/{u['stem']}.png").convert("RGB")
            b = u["box"]
            half = max(2.2 * max(b[2] - b[0], b[3] - b[1]), 0.06 * max(d["width"], d["height"]))
            cx, cy = B.center(b)
            window = (cx - half, cy - half, cx + half, cy + half)
            crop = image.crop(tuple(round(v) for v in window)).resize((tile, tile), Image.LANCZOS)
            draw = ImageDraw.Draw(crop)
            z = tile / (2 * half)

            def rect(box, colour, width):
                draw.rectangle([(box[0] - window[0]) * z, (box[1] - window[1]) * z, (box[2] - window[0]) * z,
                                (box[3] - window[1]) * z], outline=colour, width=width)

            for x in d["doors"]:
                rect(x["box"], (0, 0, 230) if x["kind"].startswith("None") else (0, 160, 0), 2)
            for w in d["windows"]:
                rect(w["box"], (0, 190, 190), 1)
            rect(b, (230, 0, 0), 3)
            flags = ("in" if u["in_unit"] else "OUT") + (" dw" if u["on_doorway"] else "") + (" win" if u["on_window"] else "")
            draw.rectangle([0, 0, tile, 14], fill="white")
            draw.text((3, 1), f"{sheet + k + 1}  {u['score']:.2f}  {flags}  {u['stem'][-22:]}", fill=(0, 0, 0))
            canvas.paste(crop, ((k % cols) * tile, (k // cols) * tile))
        canvas.save(f"{OUT}/doors_sheet{sheet // 15 + 1}.png")
    print("sheets: red = detection, green = annotated door with a leaf, blue = annotated leafless doorway, cyan = window")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    command = sys.argv[1]
    if command == "paired":
        paired(sys.argv[2:] or ["base", "drawsafe", "y26l"])
    else:
        {"convention": convention, "gate": gate, "doors": doors}[command]()
