"""Sweep variant in which the window target does not depend on the drawing's pane convention.

    build_winrun.py       # writes /data/sweep/data/yolo_winrun, then prints the checks
    build_winrun.py full  # the same labels on the original split (/data/yolo_sym, no dev part): yolo_winrun_full

Windows: annotations that lie in line and touch become one box of class window_run, in every drawing alike (the
grouping of build_symrun). How many annotations a run holds is not a class: it is kept in runs.json for the
panes-per-run classifier (panes.py), and eval_counts.py sums predicted panes over detected runs (count_rules.json).
Doors: door (swing), door_other (sliding, folding, roll-up) and doorway (no leaf; detected, never counted).
Train drawings with a door_other appear REPEAT times, as extra links in images/train.
Same drawings and parts as the source dataset. Nothing here reads the test part back.
app_spec.json tells export_onnx.py how the app is to see the classes: a run is a "window" that counts once, and
door_other counts as "door" only if that gives more exact counts on validation.
"""
import json
import os
import shutil
import sys
from collections import Counter

sys.path.insert(0, "/data")
sys.path.insert(0, "/data/sweep")
import build_dataset as B  # noqa: E402
import build_symrun as S  # noqa: E402

FULL = sys.argv[1:] == ["full"]
SOURCE = "/data/yolo_sym" if FULL else S.SOURCE
PARTS = ("train", "val", "test") if FULL else S.PARTS
CHECKED = ("train", "val") if FULL else S.CHECKED
OUT = f"{S.ROOT}/yolo_winrun" + ("_full" if FULL else "")
NAMES = ["window_run", "door", "toilet", "sink", "shower", "bathtub", "doorway", "door_other"]
REPEAT = 3
PANES_DIR = "/data/sweep/panes"
COUNT_WEIGHTS = {"windows": {"window_run": 1}, "doors": {"door": 1, "door_other": 1}, "toilets": {"toilet": 1},
                 "sinks": {"sink": 1}, "showers_bathtubs": {"shower": 1, "bathtub": 1}}
# Read by eval_counts.py: a window_run counts as its predicted panes; the door classes are de-duplicated against each
# other and share one threshold.
COUNT_RULES = {"panes": {"kind": "windows", "class": "window_run", "model_dir": PANES_DIR, "module_dir": "/data/sweep"},
               "shared_threshold": [["door", "door_other"]],
               "cross_class_nms": [["door", "door_other", "doorway"]]}
APP_SPEC = {"rename": {"window_run": "window"}, "optional": {"kind": "doors", "class": "door_other", "counts_as": "door"}}


def items(d):
    """(class, box) for every label, and the runs as [x0, y0, x1, y1, annotations]."""
    runs = [(B.union(run), len(run)) for run in S.runs(d)]
    out = [("window_run", box) for box, _ in runs]
    out += [(S.door_class(x["kind"], NAMES), x["box"]) for x in d["doors"]]
    out += [(name, box) for name, box in B.objects(d) if name in S.FIXTURES]
    return out, [[*box, n] for box, n in runs]


def main():
    part_of = {l.strip(): part for part in PARTS for l in open(f"{SOURCE}/splits/{part}.txt") if l.strip()}
    truth = json.load(open("/data/yolo/truth.json"))
    feats = [json.loads(l) for l in open(B.FEATURES)]
    for part in PARTS:
        shutil.rmtree(f"{OUT}/images/{part}", ignore_errors=True)
        shutil.rmtree(f"{OUT}/labels/{part}", ignore_errors=True)
        os.makedirs(f"{OUT}/images/{part}")
        os.makedirs(f"{OUT}/labels/{part}")
    os.makedirs(f"{OUT}/splits", exist_ok=True)
    for part in PARTS:
        shutil.copy(f"{SOURCE}/splits/{part}.txt", f"{OUT}/splits/{part}.txt")

    runs_of, counts, repeated = {}, {}, 0
    for d in feats:
        stem, part = d["stem"], part_of[d["stem"]]
        labels, runs = items(d)
        lines = B.yolo_lines(d, labels, NAMES)
        image = os.path.realpath(f"{SOURCE}/images/{part}/{stem}.png")
        copies = [stem]
        if part == "train" and any(name == "door_other" for name, _ in labels):
            copies += [f"{stem}.rep{i}" for i in range(1, REPEAT)]
            repeated += 1
        for copy in copies:
            os.symlink(image, f"{OUT}/images/{part}/{copy}.png")
            with open(f"{OUT}/labels/{part}/{copy}.txt", "w") as f:
                f.write("\n".join(lines))
        if part != "test":
            runs_of[stem] = runs
            counts[stem] = Counter(NAMES[int(l.split()[0])] for l in lines)
            counts[stem]["panes"] = sum(n for *_, n in runs)
    with open(f"{OUT}/data.yaml", "w") as f:
        f.write(f"path: {OUT}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n")
        f.writelines(f"  {i}: {n}\n" for i, n in enumerate(NAMES))
    json.dump(COUNT_WEIGHTS, open(f"{OUT}/count_weights.json", "w"), indent=1)
    json.dump(COUNT_RULES, open(f"{OUT}/count_rules.json", "w"), indent=1)
    json.dump(APP_SPEC, open(f"{OUT}/app_spec.json", "w"), indent=1)
    json.dump(runs_of, open(f"{OUT}/runs.json", "w"))

    print(f"{os.path.basename(OUT)}: classes {NAMES}; {repeated} train drawings with a door_other listed {REPEAT} times, "
          f"{len(os.listdir(f'{OUT}/images/train'))} train images")
    for part in CHECKED:
        stems = [s for s, p in part_of.items() if p == part]
        print(f"   {part}: boxes per class {dict(sum((counts[s] for s in stems), Counter()))}; runs by annotations "
              f"{dict(sorted(Counter(n for s in stems for *_, n in runs_of[s]).items()))}")
    print("   counts from the labels (windows = annotations summed over runs, doors = door + door_other) equal to "
          "Stoa's answer:")
    derived = {"windows": lambda c: c["panes"], "doors": lambda c: c["door"] + c["door_other"], "toilets": lambda c: c["toilet"],
               "sinks": lambda c: c["sink"], "showers_bathtubs": lambda c: c["shower"] + c["bathtub"]}
    for kind, value in derived.items():
        cells = []
        for part in CHECKED:
            asked = [s for s, p in part_of.items() if p == part and kind in truth[s]["stoa"]]
            ok = sum(value(counts[s]) == truth[s]["stoa"][kind] for s in asked)
            runs_only = sum(counts[s]["window_run"] == truth[s]["stoa"][kind] for s in asked) if kind == "windows" else None
            cells.append(f"{part} {ok}/{len(asked)} = {ok / max(1, len(asked)):.2%}"
                         + (f" (runs alone {runs_only})" if runs_only is not None else ""))
        print(f"   {kind:17} " + "   ".join(cells))
    lost = sum(len(d["windows"]) for d in feats if part_of[d["stem"]] != "test") - sum(c["panes"] for c in counts.values())
    print(f"   window annotations that get no label (outside the image): {lost}")


if __name__ == "__main__":
    main()
