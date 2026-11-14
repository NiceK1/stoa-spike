"""Sweep worker: takes experiments from the queue one at a time and runs each on one GPU.

    worker.py <gpu index>

An experiment is run_all.sh on a sweep dataset (train -> score dev -> save detections), then results/<name>.json.
A run that fails still gets a result file and the worker moves on. The worker exits when nothing is pending.
"""
import csv
import json
import os
import socket
import subprocess
import sys
import time

ROOT = "/data/sweep"
QUEUE = f"{ROOT}/queue"
# Holds the time (epoch seconds) at which training must stop so that scoring and copying finish before teardown.
DEADLINE_FILE = f"{ROOT}/DEADLINE"


def claim():
    pending = []
    for f in os.listdir(f"{QUEUE}/pending"):
        try:
            pending.append((json.load(open(f"{QUEUE}/pending/{f}"))["submitted"], f))
        except (OSError, ValueError):
            continue
    for _, f in sorted(pending):
        try:
            os.rename(f"{QUEUE}/pending/{f}", f"{QUEUE}/running/{f}")
        except OSError:
            continue
        return f
    return None


def tail(path, lines=15):
    try:
        return open(path, errors="replace").read().replace("\r", "\n").splitlines()[-lines:]
    except OSError:
        return []


def epochs_of(run_dir):
    try:
        return [{k.strip(): v.strip() for k, v in r.items()} for r in csv.DictReader(open(f"{run_dir}/results.csv"))]
    except OSError:
        return []


def kinds(scored):
    return {kind: {"exact": ok, "asked": n, "within_one": near} for kind, (ok, n, near) in scored["per_kind"].items()}


def run(f, gpu):
    spec = json.load(open(f"{QUEUE}/running/{f}"))
    name, batch, started = spec["name"], spec["batch"], time.time()
    run_dir, report_path, log_path = f"{ROOT}/runs/{name}", f"{ROOT}/eval/{name}/report.json", f"{ROOT}/logs/{name}.log"
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu), STOA_OUT=ROOT, STOA_PART="dev", STOA_FLOOR="0.01")
    error, train_exit = None, None
    for attempt in range(3):
        if os.path.exists(DEADLINE_FILE):
            left = int(float(open(DEADLINE_FILE).read()) - time.time())
            if left < 300:
                error = "no time left before teardown"
                break
            env["STOA_TRAIN_SECONDS"] = str(left)
        spec["run"] = {"gpu": gpu, "host": socket.gethostname(), "started": started, "batch": batch, "attempt": attempt}
        json.dump(spec, open(f"{QUEUE}/running/{f}", "w"))
        subprocess.run(["bash", "/data/run_all.sh", name, spec["weights"], str(spec["imgsz"]), str(spec["epochs"]),
                        str(batch), spec["data"], spec.get("export") or "-", *spec.get("train", [])], env=env)
        log = open(log_path, errors="replace").read() if os.path.exists(log_path) else ""
        exits = [l.split()[1] for l in log.splitlines() if l.startswith("TRAIN_EXIT ")]
        train_exit = int(exits[-1]) if exits else None
        if not os.path.exists(f"{run_dir}/weights/best.pt") and "out of memory" in log.lower() and batch > 2:
            batch //= 2
            continue
        break

    rows = epochs_of(run_dir)
    result = {"name": name, "spec": {k: v for k, v in spec.items() if k != "run"}, "gpu": gpu,
              "host": socket.gethostname(), "batch_used": batch, "epochs_planned": spec["epochs"], "epochs_run": len(rows),
              "train_exit": train_exit, "minutes": {"total": round((time.time() - started) / 60, 1)},
              "weights": f"{run_dir}/weights/best.pt",
              "detections": {p: f"{ROOT}/eval/{name}/{p}.json" for p in ("val", "dev")}}
    if rows:
        result["minutes"]["train"] = round(float(rows[-1]["time"]) / 60, 1)
        best = max(rows, key=lambda r: float(r.get("metrics/mAP50-95(B)") or 0))
        result["best_epoch"] = {"epoch": int(float(best["epoch"])), "mAP50": float(best.get("metrics/mAP50(B)") or 0),
                                "mAP50-95": float(best.get("metrics/mAP50-95(B)") or 0)}
    if os.path.exists(report_path):
        report = json.load(open(report_path))
        # "truncated": training stopped early (time limit or crash) and the best weights so far were scored.
        result.update(status="ok" if train_exit == 0 else "truncated", thresholds=report["thresholds"],
                      dev=dict(kinds(report["dev"]), correct=report["dev"]["correct"], total=report["dev"]["total"]),
                      val=dict(kinds(report["val"]), correct=report["val"]["correct"], total=report["val"]["total"]))
    else:
        result.update(status="failed", error=error or "no dev report",
                      log_tail={"train": tail(log_path), "eval": tail(f"{ROOT}/logs/eval_{name}.log")})
    json.dump(result, open(f"{ROOT}/results/{name}.json.tmp", "w"), indent=1)
    os.replace(f"{ROOT}/results/{name}.json.tmp", f"{ROOT}/results/{name}.json")
    os.rename(f"{QUEUE}/running/{f}", f"{QUEUE}/{'failed' if result['status'] == 'failed' else 'done'}/{f}")


def main():
    gpu = int(sys.argv[1])
    while True:
        f = claim()
        if f is None:
            return
        try:
            run(f, gpu)
        except Exception as e:  # one broken experiment must not stop the queue
            name = f[:-5]
            json.dump({"name": name, "status": "failed", "error": repr(e), "gpu": gpu},
                      open(f"{ROOT}/results/{name}.json", "w"), indent=1)
            if os.path.exists(f"{QUEUE}/running/{f}"):
                os.rename(f"{QUEUE}/running/{f}", f"{QUEUE}/failed/{f}")


if __name__ == "__main__":
    main()
