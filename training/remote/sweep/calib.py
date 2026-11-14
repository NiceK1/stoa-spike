"""Calibrated counts: a second-stage model per class that turns a run's low-confidence detections into a count.

    calib.py [run] [second run]      # default base and base_s1; writes /data/sweep/results/calib_<run>.json

Each detection of the run (floor 0.01) on validation is marked matched or unmatched against the annotations. Per class
a small model predicts that mark from the score, the box, its surroundings and the second run's detections. A count
rule then turns the probabilities of a drawing into a count: a threshold on the probability, the rounded sum, or the
mode of the Poisson-binomial distribution. Model and rule are chosen on validation from predictions made in
cross-validation grouped by drawing; the choice is then fitted on all of validation and applied once to dev.
Runs in /data/round3/venv-cal (numpy, scikit-learn, lightgbm). Reads val and dev only.
"""
import json
import math
import sys
import warnings

import numpy as np
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

ROOT = "/data/sweep"
DATA = f"{ROOT}/data/yolo_sym"
RUN = sys.argv[1] if len(sys.argv) > 1 else "base"
SECOND = sys.argv[2] if len(sys.argv) > 2 else "base_s1"
KINDS = {"windows": "window", "doors": "door"}
NAMES = [l.split(": ", 1)[1].strip() for l in open(f"{DATA}/data.yaml") if l.startswith("  ")]
MATCH_IOU = 0.3
TAUS = [round(0.05 + 0.025 * i, 3) for i in range(37)]
FOLDS, REPEATS = 5, 3
FEATURES = ["logit", "score", "short", "long", "aspect", "log_area", "border", "near", "overlapping", "duplicate_iou",
            "touching", "rank", "rank_share", "confident_in_drawing", "top_score", "second_score", "second_iou",
            "other_class_score", "long_side"]


def iou_matrix(a, b):
    """IoU of every box in a (n, 4) with every box in b (m, 4)."""
    if not len(a) or not len(b):
        return np.zeros((len(a), len(b)))
    x0, y0 = np.maximum(a[:, None, 0], b[None, :, 0]), np.maximum(a[:, None, 1], b[None, :, 1])
    x1, y1 = np.minimum(a[:, None, 2], b[None, :, 2]), np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x1 - x0, 0, None) * np.clip(y1 - y0, 0, None)
    area = lambda v: (v[:, 2] - v[:, 0]) * (v[:, 3] - v[:, 1])
    return inter / np.maximum(1e-9, area(a)[:, None] + area(b)[None, :] - inter)


def gaps(a):
    """Distance between every pair of boxes, zero where they touch or overlap."""
    dx = np.clip(np.maximum(a[:, None, 0], a[None, :, 0]) - np.minimum(a[:, None, 2], a[None, :, 2]), 0, None)
    dy = np.clip(np.maximum(a[:, None, 1], a[None, :, 1]) - np.minimum(a[:, None, 3], a[None, :, 3]), 0, None)
    return np.hypot(dx, dy)


def labels_of(part, stem, size):
    w, h = size
    out = {}
    for line in open(f"{DATA}/labels/{part}/{stem}.txt"):
        if line.strip():
            c, xc, yc, bw, bh = (float(v) for v in line.split())
            out.setdefault(NAMES[int(c)], []).append([(xc - bw / 2) * w, (yc - bh / 2) * h, (xc + bw / 2) * w, (yc + bh / 2) * h])
    return out


def rows_of(cls, dets, second, size, annotations):
    """Feature rows and matched marks for one drawing's detections of a class, best score first."""
    w, h = size
    side = max(w, h)
    mine = sorted((d for d in dets if d[0] == cls), key=lambda d: -d[1])
    if not mine:
        return np.zeros((0, len(FEATURES))), np.zeros(0, int)
    score = np.array([d[1] for d in mine])
    box = np.array([d[2] for d in mine], float)
    bw, bh = box[:, 2] - box[:, 0], box[:, 3] - box[:, 1]
    cx, cy = (box[:, 0] + box[:, 2]) / 2, (box[:, 1] + box[:, 3]) / 2
    short, long = np.minimum(bw, bh) / side, np.maximum(bw, bh) / side
    own = iou_matrix(box, box)
    np.fill_diagonal(own, 0)
    distance = np.hypot(cx[:, None] - cx[None, :], cy[:, None] - cy[None, :])
    np.fill_diagonal(distance, np.inf)
    gap = gaps(box)
    np.fill_diagonal(gap, np.inf)
    higher = np.triu(np.ones_like(own), 1).T  # [i, j] = 1 where j scores above i
    other = np.array([d[2] for d in second if d[0] == cls], float).reshape(-1, 4)
    other_score = np.array([d[1] for d in second if d[0] == cls])
    cross = iou_matrix(box, other)
    best = cross.argmax(1) if len(other) else np.zeros(len(box), int)
    paired = cross[np.arange(len(box)), best] >= 0.5 if len(other) else np.zeros(len(box), bool)
    rest = [d for d in dets if d[0] != cls]
    rest_iou = iou_matrix(box, np.array([d[2] for d in rest], float).reshape(-1, 4))
    rest_score = np.array([d[1] for d in rest])
    features = np.column_stack([
        np.log(np.clip(score, 1e-4, 1 - 1e-4) / (1 - np.clip(score, 1e-4, 1 - 1e-4))), score, short, long,
        long / np.maximum(short, 1e-6), np.log(np.maximum(short * long, 1e-9)),
        np.minimum.reduce([cx, cy, w - cx, h - cy]) / side,
        ((distance < 0.1 * side) & (score[None, :] >= 0.1)).sum(1),
        ((own > 0.1) & (score[None, :] >= 0.05)).sum(1),
        (own * higher).max(1),
        ((gap <= 2.0 * side / 1280) & (score[None, :] >= 0.2)).sum(1),
        np.arange(len(mine)), np.arange(len(mine)) / len(mine),
        np.full(len(mine), (score >= 0.25).sum()), np.full(len(mine), score[0]),
        np.where(paired, other_score[best], 0.0) if len(other) else np.zeros(len(mine)),
        np.where(paired, cross[np.arange(len(box)), best], 0.0) if len(other) else np.zeros(len(mine)),
        (np.where(rest_iou >= 0.5, rest_score[None, :], 0.0).max(1) if len(rest) else np.zeros(len(mine))),
        np.full(len(mine), side),
    ])
    matched = np.zeros(len(mine), int)
    truth = np.array(annotations, float).reshape(-1, 4)
    if len(truth):
        against, free = iou_matrix(box, truth), np.ones(len(truth), bool)
        for i in range(len(mine)):
            j = np.where(free, against[i], -1).argmax()
            if free[j] and against[i, j] >= MATCH_IOU:
                matched[i], free[j] = 1, False
    return features, matched


def models():
    return {"logistic": lambda: make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=2000)),
            "boosting": lambda: LGBMClassifier(n_estimators=200, max_depth=4, num_leaves=15, learning_rate=0.05,
                                               min_child_samples=20, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                                               n_jobs=8, verbose=-1)}


def mode(ps):
    pmf = np.ones(1)
    for p in ps[ps > 1e-3]:
        pmf = np.convolve(pmf, [1 - p, p])
    return int(pmf.argmax())


def rules():
    out = {f"threshold {t}": (lambda ps, t=t: int((ps >= t).sum())) for t in TAUS}
    out["rounded sum"] = lambda ps: int(math.floor(ps.sum() + 0.5))
    out["Poisson-binomial mode"] = mode
    return out


def counts(prob, drawing, stems, rule):
    return {s: rule(prob[drawing == i]) for i, s in enumerate(stems)}


def sign_test(wins, losses):
    n, k = wins + losses, min(wins, losses)
    return 1.0 if n == 0 else min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def main():
    truth = json.load(open("/data/yolo/truth.json"))
    size = {}
    for line in open("/data/feat/features.jsonl"):
        d = json.loads(line)
        size[d["stem"]] = (d["width"], d["height"])
    thresholds = json.load(open(f"{ROOT}/eval/{RUN}/report.json"))["thresholds"]
    dets = {p: json.load(open(f"{ROOT}/eval/{RUN}/{p}.json")) for p in ("val", "dev")}
    second = {p: json.load(open(f"{ROOT}/eval/{SECOND}/{p}.json")) for p in ("val", "dev")}
    result = {"run": RUN, "second_run": SECOND, "match_iou": MATCH_IOU, "features": FEATURES,
              "protocol": f"{REPEATS}x{FOLDS}-fold cross-validation grouped by drawing on val picks model and rule; "
                          "fitted on all of val, applied once to dev"}
    for kind, cls in KINDS.items():
        data = {}
        for part in ("val", "dev"):
            stems = sorted(dets[part])
            x, y, drawing, target = [], [], [], {}
            for i, s in enumerate(stems):
                annotations = labels_of(part, s, size[s]).get(cls, []) if part == "val" else []
                fx, fy = rows_of(cls, dets[part][s], second[part][s], size[s], annotations)
                x.append(fx), y.append(fy), drawing.append(np.full(len(fy), i))
                target[s] = len(annotations)
            data[part] = (stems, np.vstack(x), np.concatenate(y), np.concatenate(drawing), target)
        stems, x, y, drawing, target = data["val"]
        asked = {p: [s for s in data[p][0] if kind in truth[s]["stoa"]] for p in ("val", "dev")}
        answer = {s: truth[s]["stoa"][kind] for p in asked for s in asked[p]}

        # Predictions for every validation detection from models that never saw its drawing.
        held_out = {name: [] for name in models()}
        for repeat in range(REPEATS):
            order = np.random.RandomState(repeat).permutation(len(stems))
            fold_of = np.empty(len(stems), int)
            fold_of[order] = np.arange(len(stems)) % FOLDS
            for name, make in models().items():
                prob = np.zeros(len(y))
                for train, test in GroupKFold(FOLDS).split(x, y, fold_of[drawing]):
                    prob[test] = make().fit(x[train], y[train]).predict_proba(x[test])[:, 1]
                held_out[name].append(prob)
        candidates = {("raw score", name): [x[:, 1]] for name in rules() if name.startswith("threshold")}
        candidates.update({(m, r): held_out[m] for m in models() for r in rules()})

        def exact(prob, rule, part_stems, truth_of, d=drawing, all_stems=stems):
            got = counts(prob, d, all_stems, rule)
            return sum(got[s] == truth_of[s] for s in part_stems)

        scored = {}
        for (model, rule), probs in candidates.items():
            scored[model, rule] = (float(np.mean([exact(p, rules()[rule], stems, target) for p in probs])),
                                   float(np.mean([exact(p, rules()[rule], asked["val"], answer) for p in probs])))
        # Ties go to the raw score, then to the simpler model.
        preference = {"raw score": 0, "logistic": 1, "boosting": 2}
        chosen = max(scored, key=lambda k: (scored[k][0], scored[k][1], -preference[k[0]]))
        best_per_family = {}
        for model in ("raw score", *models()):
            for family in ("threshold", "rounded sum", "Poisson-binomial mode"):
                keys = [k for k in scored if k[0] == model and k[1].startswith(family)]
                if keys:
                    k = max(keys, key=lambda k: scored[k])
                    best_per_family[f"{model}, {k[1]}"] = k

        dev_stems, dev_x, _, dev_drawing, _ = data["dev"]
        fitted = {name: make().fit(x, y) for name, make in models().items()}
        dev_prob = {"raw score": dev_x[:, 1], **{name: m.predict_proba(dev_x)[:, 1] for name, m in fitted.items()}}

        def dev_counts(key):
            return counts(dev_prob[key[0]], dev_drawing, dev_stems, rules()[key[1]])

        base_right = {s: sum(1 for c, p, _ in dets["dev"][s] if c == cls and p >= thresholds[cls]) == answer[s] for s in asked["dev"]}
        got = dev_counts(chosen)
        right = {s: got[s] == answer[s] for s in asked["dev"]}
        wins = sorted(s for s in asked["dev"] if right[s] and not base_right[s])
        losses = sorted(s for s in asked["dev"] if base_right[s] and not right[s])
        table = {}
        for label, key in best_per_family.items():
            c = dev_counts(key)
            table[label] = {"val_cv_exact_all_drawings": round(scored[key][0], 1), "val_cv_exact_asked": round(scored[key][1], 1),
                            "dev_exact": sum(c[s] == answer[s] for s in asked["dev"])}
        result[kind] = {
            "detections_on_val": int(len(y)), "matched_on_val": int(y.sum()), "annotations_on_val": int(sum(target.values())),
            "asked": {p: len(asked[p]) for p in asked}, "val_drawings": len(stems),
            "base_threshold": thresholds[cls], "base_dev_exact": sum(base_right.values()),
            "base_val_exact_asked": sum(sum(1 for c, p, _ in dets["val"][s] if c == cls and p >= thresholds[cls]) == answer[s] for s in asked["val"]),
            "chosen": {"model": chosen[0], "rule": chosen[1], "val_cv_exact_all_drawings": round(scored[chosen][0], 1),
                       "val_cv_exact_asked": round(scored[chosen][1], 1)},
            "dev_exact": sum(right.values()), "dev_within_one": sum(abs(got[s] - answer[s]) <= 1 for s in asked["dev"]),
            "dev_against_base": {"wins": len(wins), "losses": len(losses), "sign_test_p": round(sign_test(len(wins), len(losses)), 4),
                                 "won": wins, "lost": losses},
            "best_rule_per_model_and_family": table,
            "note": "dev_exact of the rules not chosen is for information; only the chosen rule was selected without dev"}
        if hasattr(fitted["boosting"], "feature_importances_"):
            gain = fitted["boosting"].booster_.feature_importance(importance_type="gain")
            result[kind]["boosting_gain_share"] = {f: round(float(g / gain.sum()), 3) for f, g in sorted(zip(FEATURES, gain), key=lambda t: -t[1])}

        r = result[kind]
        print(f"\n{kind} ({cls}): {r['detections_on_val']} val detections >= 0.01, {r['matched_on_val']} matched at IoU >= {MATCH_IOU} "
              f"of {r['annotations_on_val']} annotations")
        print(f"   {'model, rule':46} {'val CV exact (all 239)':>23} {'val CV exact (asked)':>21} {'dev exact':>10}")
        for label, row in table.items():
            mark = "  <- chosen on val" if best_per_family[label] == chosen else ""
            print(f"   {label:46} {row['val_cv_exact_all_drawings']:>23} {row['val_cv_exact_asked']:>21} "
                  f"{row['dev_exact']:>6}/{len(asked['dev'])}{mark}")
        print(f"   base on dev at its threshold {thresholds[cls]}: {r['base_dev_exact']}/{len(asked['dev'])}; chosen rule "
              f"{r['dev_exact']}/{len(asked['dev'])}; per drawing {len(wins)} wins, {len(losses)} losses, sign test p "
              f"{r['dev_against_base']['sign_test_p']}")
        print("   boosting gain share:", dict(list(r.get("boosting_gain_share", {}).items())[:8]))
    json.dump(result, open(f"{ROOT}/results/calib_{RUN}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
