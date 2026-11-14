"""Panes per window run and the drawing's pane convention: the two parts of a window count that are not detection.

    panes.py prepare                         # crops of annotated runs and thumbnails of train, val, dev -> panes/cache
    panes.py train                           # both classifiers; report on val and dev with annotated runs; save
    panes.py export                          # ONNX of both, checked on CPU, with the preprocessing spec
    panes.py pane-or-not                     # probe: pane-level or not, from the image and from the plan number
    panes.py count <detections.json> <part> <threshold>     # window counts from the detections of a winrun model

Window count of a drawing = sum over its runs of the predicted panes, or the number of runs where the drawing rule
(rule.json) says its windows are annotated as whole units. WindowCounter is what eval_counts.py calls.
A run is cut out with a margin, turned so that it lies horizontally and resized to 256 x 64, greyscale.
"""
import json
import math
import os
import random
import sys

import numpy as np
import torch
from PIL import Image

ROOT = "/data/sweep"
DATA = f"{ROOT}/data/yolo_winrun"
OUT = f"{ROOT}/panes"
CACHE = f"{OUT}/cache"
PARTS = ("train", "val", "dev")
MIN_SIDE_SHARE = 0.012  # as build_dataset.py: thin boxes are padded to this share of the long side
MARGIN = 0.75  # context round a run, in units of that padding
CROP_W, CROP_H, THUMB = 256, 64, 640
MAX_PANES = 6  # largest run among the train drawings
JITTERS = 2


def region_of(box, width, height):
    pad = MIN_SIDE_SHARE * max(width, height)
    x0, y0, x1, y1 = box[:4]
    if x1 - x0 < pad:
        x0, x1 = (x0 + x1) / 2 - pad / 2, (x0 + x1) / 2 + pad / 2
    if y1 - y0 < pad:
        y0, y1 = (y0 + y1) / 2 - pad / 2, (y0 + y1) / 2 + pad / 2
    m = MARGIN * pad
    return [x0 - m, y0 - m, x1 + m, y1 + m]


def cut(gray, region):
    """Region of a greyscale array, white where it leaves the image."""
    height, width = gray.shape
    x0, y0, x1, y1 = (int(round(v)) for v in region)
    x1, y1 = max(x1, x0 + 2), max(y1, y0 + 2)
    out = np.full((y1 - y0, x1 - x0), 255, np.uint8)
    sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(width, x1), min(height, y1)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = gray[sy0:sy1, sx0:sx1]
    return out


def run_crop(gray, box):
    piece = cut(gray, region_of(box, gray.shape[1], gray.shape[0]))
    if piece.shape[0] > piece.shape[1]:
        piece = np.rot90(piece)
    return np.asarray(Image.fromarray(np.ascontiguousarray(piece)).resize((CROP_W, CROP_H), Image.BILINEAR))


def thumbnail(image):
    """Whole drawing, greyscale, fitted into THUMB x THUMB on white."""
    s = THUMB / max(image.size)
    w, h = max(1, round(image.width * s)), max(1, round(image.height * s))
    canvas = Image.new("L", (THUMB, THUMB), 255)
    canvas.paste(image.resize((w, h), Image.BILINEAR), ((THUMB - w) // 2, (THUMB - h) // 2))
    return np.asarray(canvas)


def jitter(box, pad, rng):
    """The box a detector might give: ends moved by up to 4% of the length, sides by a third of the padding."""
    x0, y0, x1, y1 = box
    length = max(x1 - x0, y1 - y0)
    a, b = (rng.uniform(-0.04, 0.04) * length for _ in range(2))
    c, e = (rng.uniform(-0.3, 0.3) * pad for _ in range(2))
    return [x0 + a, y0 + c, x1 + b, y1 + e] if x1 - x0 >= y1 - y0 else [x0 + c, y0 + a, x1 + e, y1 + b]


def prepare_job(job):
    stem, part, runs = job
    image = Image.open(f"{DATA}/images/{part}/{stem}.png").convert("L")
    gray = np.asarray(image)
    rng = random.Random(stem)
    pad = MIN_SIDE_SHARE * max(gray.shape)
    versions = 1 + (JITTERS if part == "train" else 0)
    crops = np.zeros((len(runs), versions, CROP_H, CROP_W), np.uint8)
    for i, (*box, _) in enumerate(runs):
        crops[i, 0] = run_crop(gray, box)
        for v in range(1, versions):
            crops[i, v] = run_crop(gray, jitter(box, pad, rng))
    return stem, crops, thumbnail(image)


def prepare():
    from multiprocessing import Pool
    os.makedirs(CACHE, exist_ok=True)
    runs = json.load(open(f"{DATA}/runs.json"))
    for part in PARTS:
        stems = [l.strip() for l in open(f"{DATA}/splits/{part}.txt") if l.strip()]
        with Pool(20) as pool:
            done = pool.map(prepare_job, [(s, part, runs[s]) for s in stems], chunksize=8)
        np.save(f"{CACHE}/{part}_crops.npy", np.concatenate([c for _, c, _ in done]))
        np.save(f"{CACHE}/{part}_thumbs.npy", np.stack([t for _, _, t in done]))
        json.dump({"stems": stems, "runs": [[i, n] for i, s in enumerate(stems) for *_, n in runs[s]]},
                  open(f"{CACHE}/{part}.json", "w"))
        print(part, len(stems), "drawings,", sum(len(runs[s]) for s in stems), "runs")


def load_part(part):
    return (np.load(f"{CACHE}/{part}_crops.npy"), np.load(f"{CACHE}/{part}_thumbs.npy"),
            json.load(open(f"{CACHE}/{part}.json")))


class Net(torch.nn.Module):
    """ResNet-18 on one grey channel in 0..1."""

    def __init__(self, outputs, pretrained=False):
        super().__init__()
        import torchvision
        body = torchvision.models.resnet18(weights="IMAGENET1K_V1" if pretrained else None)
        first = torch.nn.Conv2d(1, 64, 7, 2, 3, bias=False)
        first.weight.data = body.conv1.weight.data.sum(1, keepdim=True)
        body.conv1 = first
        body.fc = torch.nn.Linear(512, outputs)
        self.body = body

    def forward(self, x):
        return self.body((x - 0.45) / 0.225)


def fit(model, x, y, epochs, batch, lr, device, square=False):
    """x: uint8 [N, versions, H, W]; one version is drawn per sample and step, then mirrored at random."""
    x, y = torch.from_numpy(x).to(device), torch.from_numpy(y).long().to(device)
    model = model.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.02)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=epochs * math.ceil(len(y) / batch), pct_start=0.15)
    for _ in range(epochs):
        model.train()
        order = torch.randperm(len(y), device=device)
        for i in range(0, len(y), batch):
            idx = order[i:i + batch]
            xb = x[idx, torch.randint(x.shape[1], (len(idx),), device=device)][:, None].float() / 255
            for axis in (-1, -2):
                flip = torch.rand(len(idx), device=device) < 0.5
                xb = torch.where(flip[:, None, None, None], xb.flip(axis), xb)
            if square:
                xb = torch.rot90(xb, int(torch.randint(4, (1,))), (-2, -1))
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss = torch.nn.functional.cross_entropy(model(xb), y[idx])
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
    return model.eval()


@torch.no_grad()
def predict(model, x, device, batch=256):
    """Class probabilities for uint8 [N, H, W]."""
    out = []
    for i in range(0, len(x), batch):
        xb = torch.from_numpy(np.ascontiguousarray(x[i:i + batch])).to(device)[:, None].float() / 255
        with torch.autocast(device.split(":")[0], dtype=torch.bfloat16, enabled=device.startswith("cuda")):
            out.append(model(xb).float().softmax(1).cpu())
    return torch.cat(out).numpy()


def auc(scores, positive):
    order = np.argsort(scores)
    ranks = np.empty(len(scores))
    ranks[order] = np.arange(1, len(scores) + 1)
    n_pos, n_neg = positive.sum(), (~positive).sum()
    return (ranks[positive].sum() - n_pos * (n_pos + 1) / 2) / max(1, n_pos * n_neg)


def drawings(meta, panes, conv, truth, p_pane):
    """One row per drawing that has the windows question: predicted panes summed, runs, answer, label."""
    rows = {s: {"stem": s, "panes": 0, "runs": 0} for s in meta["stems"]}
    for (i, _), p in zip(meta["runs"], panes):
        rows[meta["stems"][i]]["panes"] += int(p)
        rows[meta["stems"][i]]["runs"] += 1
    out = []
    for i, s in enumerate(meta["stems"]):
        if "windows" in truth[s]["stoa"]:
            out.append(dict(rows[s], truth=truth[s]["stoa"]["windows"], label=conv[s]["label"], p_pane=float(p_pane[i]),
                            det_count=conv[s]["det_count"], det_runs=conv[s]["det_runs"]))
    return out


RULES = {
    "runs": lambda r, tau: r["runs"],
    "panes": lambda r, tau: r["panes"],
    "classifier": lambda r, tau: r["panes"] if r["p_pane"] >= tau else r["runs"],
    "true convention": lambda r, tau: r["runs"] if r["label"] == "unit" else r["panes"],
    "better of the two": lambda r, tau: r["truth"] if r["truth"] in (r["runs"], r["panes"]) else -1,
}


def exact(rows, rule, tau=0.5):
    return sum(RULES[rule](r, tau) == r["truth"] for r in rows)


def best_tau(rows, value=lambda r, tau: RULES["classifier"](r, tau)):
    grid = [round(0.05 * i, 2) for i in range(1, 20)]
    return max(grid, key=lambda t: (sum(value(r, t) == r["truth"] for r in rows), -abs(t - 0.5)))


def train():
    device = "cuda"
    conv = json.load(open(f"{ROOT}/probe/convention.json"))
    truth = json.load(open("/data/yolo/truth.json"))
    parts = {p: load_part(p) for p in PARTS}
    os.makedirs(OUT, exist_ok=True)

    # Convention: pane-level against unit-level drawings, whole drawing as input.
    _, thumbs, meta = parts["train"]
    labels = [conv[s]["label"] for s in meta["stems"]]
    shown = [i for i, l in enumerate(labels) if l in ("pane", "unit")]
    torch.manual_seed(0)
    convention = fit(Net(2, pretrained=True), thumbs[shown][:, None], np.array([labels[i] == "pane" for i in shown]),
                     epochs=20, batch=32, lr=5e-4, device=device, square=True)
    torch.save(convention.state_dict(), f"{OUT}/convention.pt")
    p_pane = {p: predict(convention, parts[p][1], device, batch=64)[:, 1] for p in ("val", "dev")}
    print(f"convention classifier: trained on {len(shown)} train drawings "
          f"({sum(labels[i] == 'pane' for i in shown)} pane-level, {sum(labels[i] == 'unit' for i in shown)} unit-level)")
    for held in (("val",), ("dev",), ("val", "dev")):
        score = np.concatenate([p_pane[p] for p in held])
        label = np.array([conv[s]["label"] for p in held for s in parts[p][2]["stems"]])
        mask = np.isin(label, ["pane", "unit"])
        pane = label[mask] == "pane"
        accuracy = ((score[mask] >= 0.5) == pane).mean()
        print(f"   held out {'+'.join(held)}: {mask.sum()} pane-level or unit-level drawings, accuracy {accuracy:.1%} "
              f"(always the larger class {max(pane.mean(), 1 - pane.mean()):.1%}), AUC {auc(score[mask], pane):.3f}")

    # Panes per run: trained on drawings where annotations per run are panes (pane-level, no evidence), and on all.
    crops, _, meta = parts["train"]
    run_label = np.array([conv[meta["stems"][i]]["label"] for i, _ in meta["runs"]])
    y = np.array([min(n, MAX_PANES) - 1 for _, n in meta["runs"]])
    keep = {"clean": np.isin(run_label, ["pane", "none"]), "all": np.ones(len(y), bool)}
    rows, fitted = {}, {}
    for variant, mask in keep.items():
        torch.manual_seed(0)
        model = fit(Net(MAX_PANES, pretrained=True), crops[mask], y[mask], epochs=14, batch=256, lr=2e-3, device=device)
        torch.save(model.state_dict(), f"{OUT}/panes_{variant}.pt")
        print(f"\npanes classifier '{variant}': trained on {mask.sum()} runs of train "
              f"({(y[mask] > 0).sum()} with two or more annotations)")
        for part in ("val", "dev"):
            part_crops, _, part_meta = parts[part]
            panes = predict(model, part_crops[:, 0], device).argmax(1) + 1
            true = np.array([n for _, n in part_meta["runs"]])
            label = np.array([conv[part_meta["stems"][i]]["label"] for i, _ in part_meta["runs"]])
            clean = np.isin(label, ["pane", "none"])
            unit = label == "unit"
            print(f"   {part} runs: on pane-level and no-evidence drawings {(panes[clean] == true[clean]).mean():.2%} right "
                  f"({clean.sum()} runs; single read as several {(panes[clean & (true == 1)] > 1).mean():.2%}, "
                  f"several read exactly {(panes[clean & (true > 1)] == true[clean & (true > 1)]).mean():.1%} of {(clean & (true > 1)).sum()}); "
                  f"on unit-level drawings {(panes[unit] > 1).mean():.1%} of {unit.sum()} annotated windows read as several")
            rows[variant, part] = drawings(part_meta, panes, conv, truth, p_pane[part])
        tau = best_tau(rows[variant, "val"])
        print("   window counts exact with annotated runs (oracle boxes):")
        for part in ("val", "dev"):
            r = rows[variant, part]
            print(f"      {part} of {len(r)}: " + ", ".join(f"{rule} {exact(r, rule, tau)}" for rule in RULES if rule != "classifier")
                  + f", classifier at {tau} (fitted on val) {exact(r, 'classifier', tau)}, classifier at 0.5 {exact(r, 'classifier', 0.5)}")
            for label in ("pane", "unit", "both", "none"):
                mine = [x for x in r if x["label"] == label]
                print(f"         {label:5} {len(mine):4}: runs {exact(mine, 'runs'):4}, panes {exact(mine, 'panes'):4}, "
                      f"classifier {exact(mine, 'classifier', tau):4}")
        for rule in ("panes", "classifier"):
            fitted[variant, rule] = (exact(rows[variant, "val"], rule, tau), exact(rows[variant, "dev"], rule, tau), tau)

    # The same drawing-level decision on today's detections: boxes of the base model, or those boxes merged into runs.
    print("\nconvention applied to base detections (pane-level -> boxes, unit-level -> boxes merged into runs):")
    by_boxes = lambda r, tau: r["det_count"] if r["p_pane"] >= tau else r["det_runs"]  # noqa: E731
    tau_base = best_tau(rows["clean", "val"], by_boxes)
    for part in ("val", "dev"):
        r = rows["clean", part]
        print(f"   {part} of {len(r)}: today {sum(x['det_count'] == x['truth'] for x in r)}, all as runs "
              f"{sum(x['det_runs'] == x['truth'] for x in r)}, classifier at 0.5 {sum(by_boxes(x, 0.5) == x['truth'] for x in r)}, "
              f"classifier at {tau_base} (fitted on val) {sum(by_boxes(x, tau_base) == x['truth'] for x in r)}, true convention "
              f"{sum((x['det_runs'] if x['label'] == 'unit' else x['det_count']) == x['truth'] for x in r)}")

    # Counting runs has nothing fitted. A rule that reads panes replaces it only if it is better on val and on dev.
    variant = max(keep, key=lambda v: fitted[v, "panes"][0])
    chosen = {"variant": variant, "rule": "runs", "tau": None, "val_exact": exact(rows[variant, "val"], "runs"),
              "dev_exact": exact(rows[variant, "dev"], "runs")}
    for (v, rule), (val, dev, tau) in fitted.items():
        if val > chosen["val_exact"] and dev > chosen["dev_exact"]:
            chosen = {"variant": v, "rule": rule, "tau": tau, "val_exact": val, "dev_exact": dev}
    chosen.update(val_asked=len(rows[variant, "val"]), dev_asked=len(rows[variant, "dev"]),
                  panes_rule={f"{v} {rule}": {"val": val, "dev": dev, "tau": tau} for (v, rule), (val, dev, tau) in fitted.items()})
    json.dump(dict(chosen, max_panes=MAX_PANES, crop=[CROP_W, CROP_H], thumb=THUMB), open(f"{OUT}/rule.json", "w"), indent=1)
    print("saved:", chosen)


def pane_or_not():
    """The decision the count needs, 'is this drawing pane-level or not', from the image and from the plan number."""
    device = "cuda"
    conv = json.load(open(f"{ROOT}/probe/convention.json"))
    truth = json.load(open("/data/yolo/truth.json"))
    parts = {p: load_part(p) for p in PARTS}
    _, thumbs, meta = parts["train"]
    labels = [conv[s]["label"] for s in meta["stems"]]
    use = [i for i, l in enumerate(labels) if l != "nowin"]
    torch.manual_seed(0)
    model = fit(Net(2, pretrained=True), thumbs[use][:, None], np.array([labels[i] == "pane" for i in use]),
                epochs=12, batch=32, lr=5e-4, device=device, square=True)
    torch.save(model.state_dict(), f"{OUT}/pane_or_not.pt")

    def number(stem):
        return int(stem.rsplit("-", 1)[1])

    known = sorted((number(meta["stems"][i]), labels[i] == "pane") for i in use)

    def neighbours(stem, k=10):
        n = number(stem)
        return float(np.mean([pane for _, pane in sorted(known, key=lambda x: abs(x[0] - n))[:k]]))

    scores = {"image": {p: predict(model, parts[p][1], device, batch=64)[:, 1] for p in ("val", "dev")},
              "plan number (10 nearest train drawings)": {p: np.array([neighbours(s) for s in parts[p][2]["stems"]])
                                                          for p in ("val", "dev")}}
    readers = {v: load_net(f"{OUT}/panes_{v}.pt", MAX_PANES, device) for v in ("clean", "all")}
    read = {(v, p): predict(readers[v], parts[p][0][:, 0], device).argmax(1) + 1 for v in readers for p in ("val", "dev")}
    print(f"pane-level or not: trained on {len(use)} train drawings ({sum(labels[i] == 'pane' for i in use)} pane-level)")
    for name, score in scores.items():
        for held in (("val",), ("dev",)):
            label = np.array([conv[s]["label"] for p in held for s in parts[p][2]["stems"]])
            s = np.concatenate([score[p] for p in held])
            print(f"   {name}, {held[0]}: AUC pane-level against the rest {auc(s[label != 'nowin'], label[label != 'nowin'] == 'pane'):.3f}; "
                  f"against unit-level only {auc(s[np.isin(label, ['pane', 'unit'])], label[np.isin(label, ['pane', 'unit'])] == 'pane'):.3f}")
        for variant in readers:
            rows = {p: drawings(parts[p][2], read[variant, p], conv, truth, score[p]) for p in ("val", "dev")}
            tau = best_tau(rows["val"])
            print(f"      windows exact with annotated runs, '{variant}' reader, panes where the score >= {tau} (fitted on val): "
                  + ", ".join(f"{p} {exact(rows[p], 'classifier', tau)}/{len(rows[p])} (runs alone {exact(rows[p], 'runs')}, "
                              f"true pane-level or not {sum((r['panes'] if r['label'] == 'pane' else r['runs']) == r['truth'] for r in rows[p])})"
                              for p in ("val", "dev")))


def load_net(path, outputs, device):
    model = Net(outputs)
    model.load_state_dict(torch.load(path, map_location=device))
    return model.to(device).eval()


class WindowCounter:
    """Panes for each detected run of a drawing, as read and as counted under the drawing rule."""

    def __init__(self, model_dir=OUT, device=None):
        self.rule = json.load(open(f"{model_dir}/rule.json"))
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.panes = load_net(f"{model_dir}/panes_{self.rule['variant']}.pt", self.rule["max_panes"], self.device)
        self.convention = (load_net(f"{model_dir}/convention.pt", 2, self.device)
                           if self.rule["rule"] == "classifier" else None)

    def read(self, image_path, boxes):
        if not boxes:
            return []
        gray = np.asarray(Image.open(image_path).convert("L"))
        return [int(v) for v in predict(self.panes, np.stack([run_crop(gray, b) for b in boxes]), self.device).argmax(1) + 1]

    def weights(self, image_path, boxes, read=None):
        if not boxes or self.rule["rule"] == "runs":
            return [1] * len(boxes)
        if self.convention is not None:
            image = Image.open(image_path).convert("L")
            if predict(self.convention, thumbnail(image)[None], self.device)[0, 1] < self.rule["tau"]:
                return [1] * len(boxes)
        return self.read(image_path, boxes) if read is None else read


def count(path, part, threshold):
    truth = json.load(open("/data/yolo/truth.json"))
    counter = WindowCounter()
    right = asked = 0
    for stem, dets in json.load(open(path)).items():
        boxes = [d[2] for d in dets if d[0] == "window_run" and d[1] >= threshold]
        got = sum(counter.weights(f"{DATA}/images/{part}/{stem}.png", boxes))
        if "windows" in truth[stem]["stoa"]:
            asked += 1
            right += got == truth[stem]["stoa"]["windows"]
    print(f"{part}: windows exact {right}/{asked} at threshold {threshold}, rule {counter.rule['rule']}")


def export():
    import time

    import onnxruntime as ort
    rule = json.load(open(f"{OUT}/rule.json"))
    crops = load_part("val")[0][:64, 0]
    thumbs = load_part("val")[1][:8]
    spec = {"rule": rule, "count": "windows = sum over runs of panes; every run counts 1 where the drawing rule says so"}
    for name, weights, outputs, sample, shape in (("panes", f"panes_{rule['variant']}", rule["max_panes"], crops, [1, CROP_H, CROP_W]),
                                                  ("convention", "convention", 2, thumbs, [1, THUMB, THUMB])):
        model = load_net(f"{OUT}/{weights}.pt", outputs, "cpu")
        torch.onnx.export(model, (torch.zeros(2, *shape),), f"{OUT}/{name}.onnx", input_names=["image"], output_names=["logits"],
                          dynamic_axes={"image": {0: "n"}, "logits": {0: "n"}}, opset_version=17, dynamo=False)
        session = ort.InferenceSession(f"{OUT}/{name}.onnx", providers=["CPUExecutionProvider"])
        x = sample[:, None].astype(np.float32) / 255
        started = time.time()
        logits = session.run(None, {"image": x})[0]
        seconds = (time.time() - started) / len(x)
        same = (logits.argmax(1) == predict(model, sample, "cpu").argmax(1)).mean()
        spec[name] = {"model": f"{name}.onnx", "input": {"name": "image", "shape": ["n", *shape], "dtype": "float32", "range": "0..1 grey"},
                      "output": "logits [n, classes]; argmax", "onnx_vs_pytorch_argmax_agreement": float(same),
                      "cpu_seconds_per_item_on_instance": round(seconds, 4)}
        print(name, spec[name])
    spec["panes"]["classes"] = f"index k means k + 1 panes (1..{rule['max_panes']})"
    spec["panes"]["preprocess"] = (
        f"box [x0, y0, x1, y1] in image pixels; pad = {MIN_SIDE_SHARE} * max(width, height); widen each side shorter than pad to "
        f"pad about its centre; grow by {MARGIN} * pad on all four sides; round to integers; cut from the greyscale image, white "
        f"(255) outside it; if taller than wide rotate 90 degrees counter-clockwise; resize (bilinear, antialiased) to "
        f"{CROP_W} x {CROP_H}; divide by 255")
    spec["convention"]["classes"] = "index 1 = pane-level (use panes), index 0 = unit-level (every run counts 1); softmax, compare with rule.tau"
    spec["convention"]["preprocess"] = (f"greyscale drawing scaled by {THUMB} / max(width, height) (bilinear, antialiased), pasted "
                                        f"centred on a white {THUMB} x {THUMB} canvas; divide by 255")
    json.dump(spec, open(f"{OUT}/panes.json", "w"), indent=1)


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "count":
        count(sys.argv[2], sys.argv[3], float(sys.argv[4]))
    else:
        {"prepare": prepare, "train": train, "export": export, "pane-or-not": pane_or_not}[command]()
