"""Symbols-only variant of the dataset: the drawn marks that are orientation-free, so training can mirror them.

Same drawings and splits as /data/yolo. Open doorways get their own class so the detector learns to tell them
from doors with a leaf; they are never counted.
"""
import json
import os

import build_dataset as B

OUT = "/data/yolo_sym"
NAMES = ["window", "door", "toilet", "sink", "shower", "bathtub", "doorway"]

split = {}
for part in ("train", "val", "test"):
    os.makedirs(f"{OUT}/images/{part}", exist_ok=True)
    os.makedirs(f"{OUT}/labels/{part}", exist_ok=True)
    split.update({l.strip(): part for l in open(f"/data/yolo/splits/{part}.txt") if l.strip()})
os.makedirs(f"{OUT}/splits", exist_ok=True)
for part in ("train", "val", "test"):
    os.system(f"cp /data/yolo/splits/{part}.txt {OUT}/splits/{part}.txt")

n = 0
for line in open(B.FEATURES):
    d = json.loads(line)
    part = split[d["stem"]]
    items = [(name, box) for name, box in B.objects(d) if name in NAMES]
    items += [("doorway", x["box"]) for x in d["doors"] if x["kind"].startswith("None")]
    link = f"{OUT}/images/{part}/{d['stem']}.png"
    if not os.path.lexists(link):
        os.symlink(d["image"], link)
    with open(f"{OUT}/labels/{part}/{d['stem']}.txt", "w") as f:
        f.write("\n".join(B.yolo_lines(d, items, NAMES)))
    n += len(items)
with open(f"{OUT}/data.yaml", "w") as f:
    f.write(f"path: {OUT}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n")
    f.writelines(f"  {i}: {name}\n" for i, name in enumerate(NAMES))
print("symbols dataset:", len(split), "drawings,", n, "objects")
