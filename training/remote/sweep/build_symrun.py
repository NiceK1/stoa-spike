"""Sweep variants in which a run of window panes is one box whose class says how many annotations it holds.

    build_symrun.py       # writes /data/sweep/data/yolo_symrun and yolo_symrun_do, then prints the checks

Whether the panes of one window are annotated separately differs between drawings, and where they touch the
detector draws one box over them. Here window annotations that lie in line and touch (or nearly) become one box,
the union, of class window_1, window_2, window_3 or window_4plus. A question is then answered by a weighted sum
over classes, which eval_counts.py reads from the dataset's count_weights.json.
yolo_symrun_do also separates the doors that do not swing (door_other: sliding, folding, roll-up) and lists every
train drawing that has one REPEAT times.
Same drawings and parts as yolo_sym. Nothing here reads the test part back.
"""
import json
import math
import os
import shutil
import sys
from collections import Counter

sys.path.insert(0, "/data")
import build_dataset as B  # noqa: E402

ROOT = "/data/sweep/data"
SOURCE = f"{ROOT}/yolo_sym"
PARTS = ("train", "dev", "val", "test")
CHECKED = ("train", "dev", "val")
# Largest gap between two panes of a run, in pixels at 1280 on the long side. Up to here the reference detector
# covers a quarter of such neighbours with one box; beyond, about one in thirty.
GAP_PX = 2.0
# Least share of a pair's union box that the two annotations cover. Panes in one wall give about 1; windows that
# meet at a corner or stand in an angled wall give less, and their union would be a box around the room corner.
MIN_FILL = 0.8
REPEAT = 4
WINDOWS = ["window_1", "window_2", "window_3", "window_4plus"]
FIXTURES = ["toilet", "sink", "shower", "bathtub"]
VARIANTS = {
    "yolo_symrun": WINDOWS + ["door"] + FIXTURES + ["doorway"],
    "yolo_symrun_do": WINDOWS + ["door"] + FIXTURES + ["doorway", "door_other"],
}
SYM_WEIGHTS = {"windows": {"window": 1}, "doors": {"door": 1}, "toilets": {"toilet": 1}, "sinks": {"sink": 1},
               "showers_bathtubs": {"shower": 1, "bathtub": 1}}


def gap(a, b):
    return math.hypot(max(0.0, max(a[0], b[0]) - min(a[2], b[2])), max(0.0, max(a[1], b[1]) - min(a[3], b[3])))


def fill(a, b):
    inter = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return (B.area(a) + B.area(b) - inter) / max(1e-9, B.area(B.union([a, b])))


def runs(d):
    """The drawing's window boxes grouped into runs. Windows that get no label (outside the image) are left out."""
    boxes = [w["box"] for w in d["windows"] if B.yolo_lines(d, [("window", w["box"])], ["window"])]
    reach = GAP_PX * max(d["width"], d["height"]) / 1280
    parent = list(range(len(boxes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(boxes):
        for j in range(i + 1, len(boxes)):
            if gap(a, boxes[j]) <= reach and fill(a, boxes[j]) >= MIN_FILL:
                parent[find(i)] = find(j)
    groups = {}
    for i, box in enumerate(boxes):
        groups.setdefault(find(i), []).append(box)
    return list(groups.values())


def door_class(kind, names):
    if kind.startswith("None"):
        return "doorway"
    return "door" if kind.startswith("Swing") or "door_other" not in names else "door_other"


def items(d, names):
    out = [(WINDOWS[min(len(run), 4) - 1], B.union(run)) for run in runs(d)]
    out += [(door_class(x["kind"], names), x["box"]) for x in d["doors"]]
    return out + [(name, box) for name, box in B.objects(d) if name in FIXTURES]


def count_weights(names, k):
    doors = {c: 1 for c in ("door", "door_other") if c in names}
    return {"windows": {"window_1": 1, "window_2": 2, "window_3": 3, "window_4plus": k}, "doors": doors,
            "toilets": {"toilet": 1}, "sinks": {"sink": 1}, "showers_bathtubs": {"shower": 1, "bathtub": 1}}


def write(variant, names, feats, part_of, k):
    out = f"{ROOT}/{variant}"
    for part in PARTS:
        os.makedirs(f"{out}/images/{part}", exist_ok=True)
        os.makedirs(f"{out}/labels/{part}", exist_ok=True)
    os.makedirs(f"{out}/splits", exist_ok=True)
    for part in PARTS:
        shutil.copy(f"{SOURCE}/splits/{part}.txt", f"{out}/splits/{part}.txt")
    train_list, repeated = [], 0
    for d in feats:
        stem, part = d["stem"], part_of[d["stem"]]
        link = f"{out}/images/{part}/{stem}.png"
        if not os.path.lexists(link):
            os.symlink(os.path.realpath(f"{SOURCE}/images/{part}/{stem}.png"), link)
        lines = B.yolo_lines(d, items(d, names), names)
        with open(f"{out}/labels/{part}/{stem}.txt", "w") as f:
            f.write("\n".join(lines))
        if part == "train":
            rare = "door_other" in names and any(int(l.split()[0]) == names.index("door_other") for l in lines)
            repeated += rare
            train_list += [link] * (REPEAT if rare else 1)
    train = "images/train"
    if "door_other" in names:
        train = "train_images.txt"
        with open(f"{out}/{train}", "w") as f:
            f.write("\n".join(sorted(train_list)) + "\n")
        print(f"{variant}: {repeated} train drawings with a door_other listed {REPEAT} times, {len(train_list)} lines in {train}")
    with open(f"{out}/data.yaml", "w") as f:
        f.write(f"path: {out}\ntrain: {train}\nval: images/val\ntest: images/test\nnames:\n")
        f.writelines(f"  {i}: {n}\n" for i, n in enumerate(names))
    json.dump(count_weights(names, k), open(f"{out}/count_weights.json", "w"), indent=1)


def label_counts(dataset, stems):
    """{stem: boxes per class name} read back from the label files of the checked parts."""
    names = [l.split(": ", 1)[1].strip() for l in open(f"{dataset}/data.yaml") if l.startswith("  ")]
    return {s: Counter(names[int(l.split()[0])] for l in open(f"{dataset}/labels/{part}/{s}.txt") if l.strip())
            for part in CHECKED for s in stems[part]}


def check(part_of, truth, k):
    """Counts read back from the label files against Stoa's answers, next to the same for yolo_sym."""
    stems = {part: sorted(s for s, p in part_of.items() if p == part) for part in CHECKED}
    sym = label_counts(SOURCE, stems)
    for variant, names in VARIANTS.items():
        weights = count_weights(names, k)
        new = label_counts(f"{ROOT}/{variant}", stems)
        print(f"\n{variant}: boxes per class " + "; ".join(
            f"{p} " + str({n: sum(new[s][n] for s in stems[p]) for n in names}) for p in CHECKED))
        print("   counts from the labels equal to Stoa's answer (this variant | yolo_sym), per part:")
        for kind in weights:
            cells = []
            for part in CHECKED:
                asked = [s for s in stems[part] if kind in truth[s]["stoa"]]
                ok = sum(sum(w * new[s][c] for c, w in weights[kind].items()) == truth[s]["stoa"][kind] for s in asked)
                ok_sym = sum(sum(w * sym[s][c] for c, w in SYM_WEIGHTS[kind].items()) == truth[s]["stoa"][kind] for s in asked)
                cells.append(f"{part} {ok}/{len(asked)} = {ok / max(1, len(asked)):.2%} | {ok_sym}/{len(asked)}")
            print(f"   {kind:17} " + "   ".join(cells))
        for kind in weights:
            differ = {part: [s for s in stems[part] if sum(w * new[s][c] for c, w in weights[kind].items())
                             != sum(w * sym[s][c] for c, w in SYM_WEIGHTS[kind].items())] for part in CHECKED}
            if any(differ.values()):
                asked = sum(1 for p in CHECKED for s in differ[p] if kind in truth[s]["stoa"])
                print(f"   {kind}: label count differs from yolo_sym on " + ", ".join(f"{p} {len(v)}" for p, v in differ.items())
                      + f" drawings ({asked} of them have the question)")


def convention(feats, part_of):
    """How visible a drawing's pane convention is: runs per train drawing."""
    per_drawing, sizes = [], Counter()
    for d in feats:
        if part_of[d["stem"]] != "train":
            continue
        groups = runs(d)
        sizes.update(len(g) for g in groups)
        n = sum(len(g) for g in groups)
        if n:
            per_drawing.append((sum(len(g) for g in groups if len(g) > 1) / n, d["stem"].rsplit("-", 1)[0]))
    windows = sum(n * c for n, c in sizes.items())
    print(f"\nruns in train: {dict(sorted(sizes.items()))} by number of annotations; "
          f"{1 - sizes[1] / windows:.1%} of {windows} window annotations are in a run of two or more")
    with_run = [s for s in per_drawing if s[0] > 0]
    print(f"train drawings with windows: {len(per_drawing)}; with at least one run of two or more: {len(with_run)} "
          f"= {len(with_run) / len(per_drawing):.1%}")
    edges = [0.1, 0.25, 0.5, 0.75, 1.0]
    buckets = Counter(next(e for e in edges if share <= e) for share, _ in with_run)
    print("   share of a drawing's windows that are in runs, drawings per bucket: none " + str(len(per_drawing) - len(with_run))
          + "".join(f", up to {e:.0%} {buckets[e]}" for e in edges))
    for style in sorted({s for _, s in per_drawing}):
        mine = [share for share, s in per_drawing if s == style]
        print(f"   {style:26} {sum(share > 0 for share in mine)}/{len(mine)} drawings with a run "
              f"= {sum(share > 0 for share in mine) / len(mine):.1%}")


def main():
    part_of = {l.strip(): part for part in PARTS for l in open(f"{SOURCE}/splits/{part}.txt") if l.strip()}
    truth = json.load(open("/data/yolo/truth.json"))
    feats = [json.loads(l) for l in open(B.FEATURES)]
    big = [len(g) for d in feats if part_of[d["stem"]] == "train" for g in runs(d) if len(g) >= 4]
    k = round(sum(big) / len(big))
    print(f"runs: gap <= {GAP_PX} px at 1280, pair fill >= {MIN_FILL}; window_4plus counts as {k} "
          f"(mean {sum(big) / len(big):.2f} over {len(big)} train runs of four or more, largest {max(big)})")
    for variant, names in VARIANTS.items():
        write(variant, names, feats, part_of, k)
    check(part_of, truth, k)
    convention(feats, part_of)


if __name__ == "__main__":
    main()
