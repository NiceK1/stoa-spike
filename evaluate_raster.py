"""Score a vision model on the raster floor-plan count questions, via the local `claude` CLI.

    python -I evaluate_raster.py dataset --models claude-sonnet-5-5 claude-haiku-5-5

Answers are cached under out/raster/<model>/, so a re-run only asks for drawings it has not seen.
English questions only: the Finnish ones repeat them with the same answers.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from takeoff import raster  # noqa: E402

KINDS = (
    ("windows", "windows"), ("floors", "floors"), ("toilet bowls", "toilet bowls"), ("sinks", "sinks"),
    ("showers and bathtubs", "showers"), ("doors", "doors"), ("saunas", "saunas"), ("kitchens", "kitchens"),
    ("bedrooms", "bedrooms"), ("separate WC rooms", "WC rooms"), ("bathrooms", "bathrooms"),
    ("balconies", "balconies"),
)


def kind_of(question):
    return next((label for needle, label in KINDS if needle in question), "other")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("dataset")
    p.add_argument("--models", nargs="+", default=["claude-sonnet-5-5"])
    p.add_argument("--sample", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "raster-sample.txt"),
                   help="file listing drawing paths, one per line")
    p.add_argument("--limit", type=int, help="use only the first N drawings of the sample")
    p.add_argument("--effort")
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--out", default="out/raster")
    args = p.parse_args()

    with open(args.sample, encoding="utf-8") as f:
        drawings = [line.strip() for line in f if line.strip()][:args.limit]
    by_drawing = defaultdict(list)
    with open(os.path.join(args.dataset, "questions.jsonl"), encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            if row["path"] in drawings and re.match(r"(How|What) ", row["question"]):
                by_drawing[row["path"]].append(row)

    for model in args.models:
        folder = os.path.join(args.out, model + (f"-{args.effort}" if args.effort else ""))
        os.makedirs(folder, exist_ok=True)

        def run(path):
            cache = os.path.join(folder, os.path.splitext(os.path.basename(path))[0] + ".json")
            if os.path.exists(cache):
                with open(cache, encoding="utf-8") as f:
                    return path, json.load(f)
            result = raster.count(os.path.join(args.dataset, path), [r["question"] for r in by_drawing[path]],
                                  model, args.effort)
            if "answers" in result:
                with open(cache, "w", encoding="utf-8") as f:
                    json.dump(result, f)
            return path, result

        with ThreadPoolExecutor(args.workers) as pool:
            results = dict(pool.map(run, drawings))

        stats = defaultdict(lambda: [0, 0])
        errors, cost, seconds, perfect, off_by = [], 0.0, [], 0, defaultdict(int)
        for path in drawings:
            result = results[path]
            cost += result.get("cost_usd", 0.0)
            if "answers" not in result:
                errors.append((path, result.get("error")))
                for row in by_drawing[path]:
                    stats[kind_of(row["question"])][1] += 1
                continue
            seconds.append(result["seconds"])
            all_right = True
            for row, got, right in raster.graded(by_drawing[path], result["answers"]):
                s = stats[kind_of(row["question"])]
                s[0] += right
                s[1] += 1
                all_right &= right
                if got is not None and not right:
                    off_by[min(abs(got - row["answer"]), 3)] += 1
            perfect += all_right

        n, correct = sum(s[1] for s in stats.values()), sum(s[0] for s in stats.values())
        print(f"\n== {model}{' effort ' + args.effort if args.effort else ''}: "
              f"{correct}/{n} correct ({correct / n:.1%}) on {len(drawings)} drawings")
        for kind, (right, total) in sorted(stats.items(), key=lambda kv: -kv[1][0] / kv[1][1]):
            print(f"   {kind:12} {right:3}/{total:3}  {right / total:6.1%}")
        print(f"   drawings with every answer right: {perfect}/{len(drawings)}")
        print(f"   wrong answers off by 1: {off_by[1]}, by 2: {off_by[2]}, by 3 or more: {off_by[3]}")
        if seconds:
            print(f"   median {sorted(seconds)[len(seconds) // 2]}s per drawing; "
                  f"CLI-reported cost {cost:.2f} USD total, {cost / len(drawings):.3f} per drawing")
        for path, error in errors:
            print(f"   FAILED {path}: {error}")


if __name__ == "__main__":
    main()
