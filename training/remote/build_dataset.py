"""Turn the parsed CubiCasa5k features into a YOLO detection dataset and a truth file for count evaluation.

Classes follow the Stoa question definitions (each verified against Stoa's answers by agreement.py):
  window, door (doorways with a leaf), toilet, sink, shower, bathtub, sauna, kitchen, bedroom, wc_room, bathroom,
  balcony, floor.
Splits are by drawing with a fixed seed; the 30 drawings of raster-sample.txt are always in test.
"""
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, "/data")
import agreement  # noqa: E402

FEATURES = "/data/feat/features.jsonl"
OUT = "/data/yolo"
NAMES = ["window", "door", "toilet", "sink", "shower", "bathtub", "sauna", "kitchen", "bedroom", "wc_room", "bathroom",
         "balcony", "floor"]
SEED, TEST_SHARE, VAL_SHARE = 20261114, 0.10, 0.05
MIN_SIDE_SHARE = 0.012  # thin marks (windows in a wall) get padded to this share of the image's long side


def area(b):
    return (b[2] - b[0]) * (b[3] - b[1])


def center(b):
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def inside(b, p):
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def objects(d):
    """(class name, box) for every countable thing on the drawing."""
    out = [("window", w["box"]) for w in d["windows"]]
    out += [("door", x["box"]) for x in d["doors"] if not x["kind"].startswith("None")]
    for f in d["fixtures"]:
        name = f["name"]
        if name == "Toilet":
            out.append(("toilet", f["box"]))
        elif "Sink" in name:
            out.append(("sink", f["box"]))
        elif name == "Shower":
            out.append(("shower", f["box"]))
        elif name in ("Bathtub", "BathtubRound"):
            out.append(("bathtub", f["box"]))
    sauna_rooms = {i for i, s in enumerate(d["spaces"]) if s["kind"].startswith("Sauna")}
    for f in d["fixtures"]:
        if "Sauna" in f["name"]:
            holders = [(area(s["box"]), i) for i, s in enumerate(d["spaces"])
                       if s["floor"] == f["floor"] and inside(s["box"], center(f["box"]))]
            if holders:
                sauna_rooms.add(min(holders)[1])
    out += [("sauna", d["spaces"][i]["box"]) for i in sorted(sauna_rooms)]
    for s in d["spaces"]:
        kind, label = s["kind"], s["label"].strip().upper()
        if kind.startswith("Kitchen"):
            out.append(("kitchen", s["box"]))
        elif kind.startswith("Bedroom"):
            out.append(("bedroom", s["box"]))
        elif kind.startswith("Bath"):
            out.append(("wc_room" if re.search(r"\bWC\b", label) else "bathroom", s["box"]))
        elif kind.startswith("Outdoor Balcony"):
            out.append(("balcony", s["box"]))
    by_floor = defaultdict(list)
    for group in ("windows", "doors", "fixtures", "spaces"):
        for item in d[group]:
            by_floor[item["floor"]].append(item["box"])
    out += [("floor", union(boxes)) for _, boxes in sorted(by_floor.items())]
    return out


def counts(d):
    c = Counter(name for name, _ in objects(d))
    return {"windows": c["window"], "doors": c["door"], "toilets": c["toilet"], "sinks": c["sink"],
            "showers_bathtubs": c["shower"] + c["bathtub"], "saunas": c["sauna"], "kitchens": c["kitchen"],
            "bedrooms": c["bedroom"], "wc_rooms": c["wc_room"], "bathrooms": c["bathroom"], "balconies": c["balcony"],
            "floors": d["floors"]}


def yolo_lines(d, items=None, names=NAMES):
    w, h = d["width"], d["height"]
    pad = MIN_SIDE_SHARE * max(w, h)
    lines = []
    for name, (x0, y0, x1, y1) in (objects(d) if items is None else items):
        if x1 - x0 < pad:
            m = (x0 + x1) / 2
            x0, x1 = m - pad / 2, m + pad / 2
        if y1 - y0 < pad:
            m = (y0 + y1) / 2
            y0, y1 = m - pad / 2, m + pad / 2
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        lines.append(f"{names.index(name)} {(x0 + x1) / 2 / w:.6f} {(y0 + y1) / 2 / h:.6f} {(x1 - x0) / w:.6f} {(y1 - y0) / h:.6f}")
    return lines


def main():
    truth, _ = agreement.load_truth()
    feats = [json.loads(l) for l in open(FEATURES)]
    by_stem = {d["stem"]: d for d in feats}

    print("agreement of annotation-derived counts with Stoa's answers:")
    for kind in ("windows", "doors", "toilets", "sinks", "showers_bathtubs", "saunas", "kitchens", "bedrooms", "wc_rooms",
                 "bathrooms", "balconies", "floors"):
        asked = [(s, t[kind]) for s, t in truth.items() if kind in t and s in by_stem]
        ok = sum(1 for s, a in asked if counts(by_stem[s])[kind] == a)
        print(f"  {kind:17} {ok}/{len(asked)}  {ok / max(1, len(asked)):.2%}")

    sample = [os.path.splitext(os.path.basename(l.strip()))[0] for l in open("/data/raster-sample.txt") if l.strip()]
    stoa = sorted(d["stem"] for d in feats if d["in_stoa"])
    rest = [s for s in stoa if s not in set(sample)]
    random.Random(SEED).shuffle(rest)
    n_test, n_val = round(len(stoa) * TEST_SHARE) - len(sample), round(len(stoa) * VAL_SHARE)
    split = {s: "test" for s in sample + rest[:n_test]}
    split.update({s: "val" for s in rest[n_test:n_test + n_val]})
    split.update({s: "train" for s in rest[n_test + n_val:]})
    split.update({d["stem"]: "train" for d in feats if not d["in_stoa"]})

    os.makedirs(f"{OUT}/splits", exist_ok=True)
    per_split, class_count = Counter(), Counter()
    for part in ("train", "val", "test"):
        os.makedirs(f"{OUT}/images/{part}", exist_ok=True)
        os.makedirs(f"{OUT}/labels/{part}", exist_ok=True)
    for d in feats:
        part = split[d["stem"]]
        per_split[part] += 1
        link = f"{OUT}/images/{part}/{d['stem']}.png"
        if not os.path.lexists(link):
            os.symlink(d["image"], link)
        lines = yolo_lines(d)
        class_count.update(NAMES[int(l.split()[0])] for l in lines)
        with open(f"{OUT}/labels/{part}/{d['stem']}.txt", "w") as f:
            f.write("\n".join(lines))
    for part in ("train", "val", "test"):
        with open(f"{OUT}/splits/{part}.txt", "w") as f:
            f.write("\n".join(sorted(s for s, p in split.items() if p == part)) + "\n")
    with open(f"{OUT}/data.yaml", "w") as f:
        f.write(f"path: {OUT}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n")
        f.writelines(f"  {i}: {n}\n" for i, n in enumerate(NAMES))
    with open(f"{OUT}/truth.json", "w") as f:
        json.dump({s: {"split": split[s], "stoa": truth.get(s, {}), "annotation": counts(by_stem[s])} for s in split}, f)
    print("drawings per split:", dict(per_split), "| sample drawings in test:", sum(1 for s in sample if split.get(s) == "test"))
    print("objects per class:", dict(class_count))


if __name__ == "__main__":
    main()
