"""Assembles the Hugging Face Space: the app's source, the detector models and a demo subset of the dataset.

    python -I deploy/hf-space/build_bundle.py dataset-full .hf-space-build

The subset holds only drawings that can be answered without a cloud model: the held-out raster test sample
(raster-test100.txt), Swiss apartment floors (CAD geometry) and IFC models up to MAX_IFC_MB with their plan sheets.
"""
import json
import os
import random
import shutil
import subprocess
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SWISS = 60
MAX_IFC_MB = 20

source, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
if os.path.exists(out):
    shutil.rmtree(out)
os.makedirs(out)

# The app's source as git sees it (tracked and new files, nothing ignored: no node_modules, caches or builds).
tracked = subprocess.run(["git", "-C", REPO, "ls-files", "--cached", "--others", "--exclude-standard", "app"], capture_output=True, text=True, check=True).stdout.split()
for path in tracked:
    os.makedirs(os.path.dirname(os.path.join(out, path)), exist_ok=True)
    shutil.copy2(os.path.join(REPO, path), os.path.join(out, path))
shutil.copytree(os.path.join(REPO, "models"), os.path.join(out, "models"))
for name in ("Dockerfile", "README.md"):
    shutil.copy2(os.path.join(HERE, name), os.path.join(out, name))

rows = [json.loads(line) for line in open(os.path.join(source, "questions.jsonl"), encoding="utf-8") if line.strip()]
by_path = defaultdict(list)
for row in rows:
    by_path[row["path"]].append(row)


def files_of(path):
    """The drawing, its same-name twins, and the IFC model a plan sheet was rendered from."""
    stem = os.path.splitext(path)[0]
    folder = os.path.dirname(os.path.join(source, path))
    base = os.path.basename(stem)
    found = [os.path.join(os.path.dirname(path), f) for f in os.listdir(folder) if os.path.splitext(f)[0] == base]
    model = stem.split("_plan-")[0] + ".ifc"
    if os.path.exists(os.path.join(source, model)) and model not in found:
        found.append(model)
    return found


def size_mb(paths):
    return sum(os.path.getsize(os.path.join(source, p)) for p in paths) / 1e6


chosen = [line.strip() for line in open(os.path.join(REPO, "raster-test100.txt")) if line.strip() in by_path]
swiss = sorted(p for p in by_path if p.split("/")[1] == "swiss_dwellings")
chosen += random.Random(2026).sample(swiss, SWISS)
for path in sorted(p for p in by_path if p.split("/")[1] == "ifc_models"):
    model = os.path.splitext(path)[0].split("_plan-")[0] + ".ifc"
    if os.path.exists(os.path.join(source, model)) and size_mb([model]) <= MAX_IFC_MB:
        chosen.append(path)

copied = set()
for path in chosen:
    for f in files_of(path):
        if f not in copied:
            os.makedirs(os.path.dirname(os.path.join(out, "dataset", f)), exist_ok=True)
            shutil.copy2(os.path.join(source, f), os.path.join(out, "dataset", f))
            copied.add(f)
for src in sorted({p.split("/")[1] for p in chosen}):
    shutil.copy2(os.path.join(source, "data", src, "LICENSE.md"), os.path.join(out, "dataset", "data", src, "LICENSE.md"))
shutil.copy2(os.path.join(source, "README.md"), os.path.join(out, "dataset", "README.md"))
with open(os.path.join(out, "dataset", "questions.jsonl"), "w", encoding="utf-8") as f:
    for path in chosen:
        for row in by_path[path]:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

counts = defaultdict(int)
for path in chosen:
    counts[path.split("/")[1]] += 1
total = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs) / 1e6
print(f"{len(chosen)} drawings {dict(counts)}, {sum(len(by_path[p]) for p in chosen)} questions, {len(copied)} files")
print(f"bundle: {out}, {total:.0f} MB")
