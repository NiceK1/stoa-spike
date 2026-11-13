"""Score the solvers against questions.jsonl with the dataset's own rules.

    python -I evaluate.py dataset
    python -I evaluate.py dataset --svg out      # one evidence overlay per question kind
"""
import argparse
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from takeoff import swiss  # noqa: E402
from takeoff.scoring import is_correct  # noqa: E402

SOLVERS = {"swiss_dwellings": swiss}
try:
    from takeoff import ifc  # noqa: E402
    SOLVERS["ifc_models"] = ifc
except ImportError:
    print("ifcopenshell not installed: IFC questions are skipped (pip install ifcopenshell)\n")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dataset")
    p.add_argument("--svg", metavar="DIR", help="write one evidence overlay per question kind")
    p.add_argument("--failures", type=int, default=3, help="wrong answers to print per question kind")
    args = p.parse_args()

    with open(os.path.join(args.dataset, "questions.jsonl"), encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]

    stats = defaultdict(lambda: {"n": 0, "answered": 0, "correct": 0})
    failures = defaultdict(list)
    rendered = set()
    for row in rows:
        source = row["path"].split("/")[1]
        solver = SOLVERS.get(source)
        kind, answer = solver.solve(args.dataset, row) if solver else ("no solver", None)
        s = stats[(source, kind)]
        s["n"] += 1
        if answer is None:
            continue
        s["answered"] += 1
        if is_correct(row["type"], row["answer"], answer.value):
            s["correct"] += 1
            if args.svg and hasattr(solver, "render") and (source, kind) not in rendered:
                rendered.add((source, kind))
                os.makedirs(args.svg, exist_ok=True)
                solver.render(args.dataset, row, answer, os.path.join(args.svg, f"{source}-{kind}.svg"))
        elif len(failures[(source, kind)]) < args.failures:
            failures[(source, kind)].append((row["path"], row["question"], row["answer"], answer.value))

    print(f"{'source':17} {'kind':24} {'n':>6} {'answered':>9} {'correct':>8} {'accuracy':>9}")
    for (source, kind), s in sorted(stats.items()):
        print(f"{source:17} {kind:24} {s['n']:6} {s['answered']:9} {s['correct']:8} {s['correct'] / s['n']:9.1%}")
    print()
    for source in sorted(SOLVERS):
        covered = [s for (src, _), s in stats.items() if src == source]
        n, correct = sum(s["n"] for s in covered), sum(s["correct"] for s in covered)
        print(f"{source:17} {correct}/{n} correct ({correct / n:.1%})")
    correct = sum(s["correct"] for s in stats.values())
    print(f"{'whole file':17} {correct}/{len(rows)} correct ({correct / len(rows):.1%})")

    for (source, kind), items in sorted(failures.items()):
        print(f"\nwrong: {source} / {kind}")
        for path, question, expected, got in items:
            print(f"  expected {expected}, got {got} | {path} | {question[:90]}")


if __name__ == "__main__":
    main()
