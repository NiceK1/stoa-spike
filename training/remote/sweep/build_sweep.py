"""Sweep variants of the datasets, in which 480 train drawings become a "dev" part for comparing recipes.

    build_sweep.py [thick share]      # writes /data/sweep/data/<variant> and prints the box-size distribution

Validation and test are the same drawings as in the source datasets: thresholds are still tuned on validation, and
test stays for the final measurement. Dev drawings all have Stoa answers and are the same in every variant.
"""
import json
import os
import random
import sys

OUT = "/data/sweep/data"
SEED, DEV = 20261114, 480
# Windows and doors are grown to this share of the image's shorter side on their short side.
THICK_SHARE = float(sys.argv[1]) if len(sys.argv) > 1 else 0.025
ROOMS = ["sauna", "kitchen", "bedroom", "wc_room", "bathroom", "balcony", "floor"]
VARIANTS = {  # name: (source dataset, classes kept or None for all, classes grown)
    "yolo": ("/data/yolo", None, ()),
    "yolo_sym": ("/data/yolo_sym", None, ()),
    "yolo_sym_thick": ("/data/yolo_sym", None, ("window", "door")),
    "yolo_wd": ("/data/yolo_sym", ["window", "door", "doorway"], ()),
    "yolo_rooms": ("/data/yolo", ROOMS, ()),
}


def names_of(dataset):
    return [l.split(": ", 1)[1].strip() for l in open(f"{dataset}/data.yaml") if l.startswith("  ")]


def stems_of(dataset, part):
    return [l.strip() for l in open(f"{dataset}/splits/{part}.txt") if l.strip()]


def grow(xc, yc, w, h, width, height):
    """Box with both sides at least THICK_SHARE of the shorter image side, kept inside the image."""
    need = THICK_SHARE * min(width, height)
    w, h = max(w, need / width), max(h, need / height)
    x0, x1 = max(0.0, xc - w / 2), min(1.0, xc + w / 2)
    y0, y1 = max(0.0, yc - h / 2), min(1.0, yc + h / 2)
    return (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0


def main():
    truth = json.load(open("/data/yolo/truth.json"))
    size = {}
    for line in open("/data/feat/features.jsonl"):
        d = json.loads(line)
        size[d["stem"]] = (d["width"], d["height"])

    train = stems_of("/data/yolo", "train")
    dev = set(random.Random(SEED).sample(sorted(s for s in train if truth[s]["stoa"]), DEV))
    part_of = {s: ("dev" if s in dev else "train") for s in train}
    part_of.update({s: "val" for s in stems_of("/data/yolo", "val")})
    part_of.update({s: "test" for s in stems_of("/data/yolo", "test")})
    source_part = {s: ("train" if p == "dev" else p) for s, p in part_of.items()}

    for variant, (source, keep, thick) in VARIANTS.items():
        source_names = names_of(source)
        names = keep or source_names
        out = f"{OUT}/{variant}"
        for part in ("train", "dev", "val", "test"):
            os.makedirs(f"{out}/images/{part}", exist_ok=True)
            os.makedirs(f"{out}/labels/{part}", exist_ok=True)
        os.makedirs(f"{out}/splits", exist_ok=True)
        shares, grown, boxes = {c: [] for c in thick}, 0, 0
        for stem, part in part_of.items():
            link = f"{out}/images/{part}/{stem}.png"
            if not os.path.lexists(link):
                os.symlink(os.path.realpath(f"{source}/images/{source_part[stem]}/{stem}.png"), link)
            width, height = size[stem]
            lines = []
            for line in open(f"{source}/labels/{source_part[stem]}/{stem}.txt"):
                if not line.strip():
                    continue
                cls, *box = line.split()
                name = source_names[int(cls)]
                if name not in names:
                    continue
                box = [float(v) for v in box]
                if name in thick:
                    short = min(box[2] * width, box[3] * height) / min(width, height)
                    if part == "train":
                        shares[name].append(short)
                    boxes += 1
                    grown += short < THICK_SHARE
                    box = grow(*box, width, height)
                lines.append(f"{names.index(name)} " + " ".join(f"{v:.6f}" for v in box))
            with open(f"{out}/labels/{part}/{stem}.txt", "w") as f:
                f.write("\n".join(lines))
        for part in ("train", "dev", "val", "test"):
            with open(f"{out}/splits/{part}.txt", "w") as f:
                f.write("\n".join(sorted(s for s, p in part_of.items() if p == part)) + "\n")
        with open(f"{out}/data.yaml", "w") as f:
            f.write(f"path: {out}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n")
            f.writelines(f"  {i}: {n}\n" for i, n in enumerate(names))
        counts = {p: sum(1 for q in part_of.values() if q == p) for p in ("train", "dev", "val", "test")}
        print(variant, counts, "classes:", names)
        for name, values in shares.items():
            values.sort()
            marks = {q: round(values[int(q / 100 * (len(values) - 1))], 4) for q in (1, 5, 10, 25, 50, 75, 90, 99)}
            print(f"   {name}: short side as a share of the image's shorter side, train percentiles: {marks}")
        if thick:
            print(f"   grown to {THICK_SHARE:.3f} of the shorter side: {grown}/{boxes} boxes")


if __name__ == "__main__":
    main()
