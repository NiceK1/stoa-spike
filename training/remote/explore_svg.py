"""Look at the CubiCasa5k SVG annotations: class vocabulary, nesting, and how the images relate to Stoa's PNGs."""
import glob
import os
import random
import struct
import sys
from collections import Counter

from lxml import etree

CUBI = "/data/cubi/cubicasa5k"
STOA = "/data/stoa/junction-dataset/data/cubicasa5k"


def png_size(path):
    with open(path, "rb") as f:
        return struct.unpack(">II", f.read(24)[16:24])


random.seed(0)
plans = sorted(glob.glob(f"{CUBI}/*/*/model.svg"))
print("plans with model.svg:", len(plans), "| categories:", Counter(p.split("/")[-3] for p in plans))
print("files in one plan folder:", os.listdir(os.path.dirname(plans[0])))
for name in ("train.txt", "val.txt", "test.txt"):
    p = os.path.join(CUBI, name)
    if os.path.exists(p):
        print(name, sum(1 for _ in open(p)), open(p).readline().strip())

print("\nimage sizes: stoa vs F1_original vs F1_scaled vs svg size")
same_orig = same_scaled = 0
sample = random.sample(plans, 40)
for i, svg in enumerate(sample):
    folder = os.path.dirname(svg)
    cat, pid = folder.split("/")[-2:]
    stoa = f"{STOA}/{cat}-{pid}.png"
    if not os.path.exists(stoa):
        continue
    s, o, c = png_size(stoa), png_size(f"{folder}/F1_original.png"), png_size(f"{folder}/F1_scaled.png")
    same_orig += s == o
    same_scaled += s == c
    if i < 6:
        root = etree.parse(svg).getroot()
        print(f"  {cat}-{pid}: stoa {s} original {o} scaled {c} svg w/h {root.get('width')}/{root.get('height')} viewBox {root.get('viewBox')}")
print(f"  stoa size equals original: {same_orig}, equals scaled: {same_scaled}, of {len(sample)}")
missing = sum(1 for svg in plans if not os.path.exists(f"{STOA}/{svg.split('/')[-3]}-{svg.split('/')[-2]}.png"))
print("  cubicasa plans with no stoa png:", missing)

classes, pairs, tags = Counter(), Counter(), Counter()
for svg in random.sample(plans, 400):
    root = etree.parse(svg).getroot()
    for el in root.iter():
        tag = etree.QName(el).localname if isinstance(el.tag, str) else "?"
        cls = el.get("class")
        if cls:
            classes[(tag, cls)] += 1
            parent = el.getparent()
            pcls = parent.get("class") if parent is not None else None
            pairs[(pcls.split()[0] if pcls else None, cls.split()[0])] += 1
print("\nCLASS STRINGS (tag, class): top 150 of", len(classes))
for (tag, cls), n in classes.most_common(150):
    print(f"  {n:6}  <{tag}> {cls}")
print("\nPARENT -> CHILD (first class word): top 60")
for (p, c), n in pairs.most_common(60):
    print(f"  {n:6}  {p} -> {c}")

svg = sample[0]
print("\nSAMPLE SVG head:", svg)
print(open(svg, encoding="utf-8", errors="replace").read()[:3500])
