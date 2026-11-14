"""List (and optionally download) the IFC models that the full dataset's ifc_models questions refer to.

    python -I app/scripts/full_ifc_list.py dataset-full [--fetch] [--max-mb 60]
"""
import json
import os
import sys
import zipfile
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from fetch_preview import HttpFile  # noqa: E402

FULL = "https://fwjydgxpttajiqpfmqtj.supabase.co/storage/v1/object/public/stoa-junction-2026/junction-dataset.zip"
root = sys.argv[1]
fetch = "--fetch" in sys.argv
max_mb = float(sys.argv[sys.argv.index("--max-mb") + 1]) if "--max-mb" in sys.argv else 60

rows = [json.loads(line) for line in open(os.path.join(root, "questions.jsonl"), encoding="utf-8") if line.strip()]
needed = Counter()
for r in rows:
    if "/ifc_models/" in r["path"] or "/ifc_bench/" in r["path"]:
        needed[os.path.splitext(r["path"])[0].split("_plan-")[0] + ".ifc"] += 1

z = zipfile.ZipFile(HttpFile(FULL))
infos = {i.filename.split("/", 1)[1]: i for i in z.infolist() if "/" in i.filename}
total = 0.0
for path, n in sorted(needed.items(), key=lambda kv: -kv[1]):
    info = infos.get(path)
    size = info.file_size / 1e6 if info else None
    target = os.path.join(root, path)
    state = "missing in zip" if info is None else "on disk" if os.path.exists(target) else "too big" if size > max_mb else "to fetch"
    if state == "to fetch" and fetch:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(z.read(info))
        state = "fetched"
    if state in ("fetched", "to fetch"):
        total += size
    print(f"{n:5} questions  {size if size is None else round(size, 1)!s:>7} MB  {state:14} {path}")
print(f"{len(needed)} models, {sum(needed.values())} questions; {total:.0f} MB {'fetched' if fetch else 'to fetch'}")
