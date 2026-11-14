"""Sweep worker: takes experiments from the queue one at a time and runs each on one GPU.

    worker.py <gpu index>

An experiment is run_all.sh on a sweep dataset (train -> score dev -> save detections), then results/<name>.json.
"part" in the experiment names the part scored instead of dev ("val" for a dataset on the original split, which has
no dev), "env" adds environment variables. An experiment with a "script" runs that script with the GPU set instead;
the script trains, scores and writes results/<name>.json itself.
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


def finish(f, name, result):
    json.dump(result, open(f"{ROOT}/results/{name}.json.tmp", "w"), indent=1)
    os.replace(f"{ROOT}/results/{name}.json.tmp", f"{ROOT}/results/{name}.json")
    os.rename(f"{QUEUE}/running/{f}", f"{QUEUE}/{'failed' if result['status'] == 'failed' else 'done'}/{f}")


def run_script(f, spec, gpu, env, started):
    name, log_path, result_path = spec["name"], f"{ROOT}/logs/job_{spec['name']}.log", f"{ROOT}/results/{spec['name']}.json"
    spec["run"] = {"gpu": gpu, "host": socket.gethostname(), "started": started}
    json.dump(spec, open(f"{QUEUE}/running/{f}", "w"))
    with open(log_path, "a") as log:
        code = subprocess.run(["bash", spec["script"], name], env=env, stdout=log, stderr=log).returncode
    if os.path.exists(result_path) and os.path.getmtime(result_path) >= started:
        result = json.load(open(result_path))
        result.setdefault("status", "ok")
    else:
        result = {"name": name, "status": "failed", "error": f"{spec['script']} exited {code} and wrote no result",
                  "log_tail": tail(log_path)}
    result.update(spec={k: v for k, v in spec.items() if k != "run"}, gpu=gpu, host=socket.gethostname())
    result.setdefault("minutes", {})["total"] = round((time.time() - started) / 60, 1)
    finish(f, name, result)


def run(f, gpu):
    spec = json.load(open(f"{QUEUE}/running/{f}"))
    name, started = spec["name"], time.time()
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu), **spec.get("env", {}))
    if "script" in spec:
        return run_script(f, spec, gpu, env, started)
    batch, part = spec["batch"], spec.get("part", "dev")
    run_dir, report_path, log_path = f"{ROOT}/runs/{name}", f"{ROOT}/eval/{name}/report.json", f"{ROOT}/logs/{name}.log"
    env.update(STOA_OUT=ROOT, STOA_PART=part, STOA_FLOOR="0.01")
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
              "detections": {p: f"{ROOT}/eval/{name}/{p}.json" for p in dict.fromkeys(("val", part))}}
    if rows:
        result["minutes"]["train"] = round(float(rows[-1]["time"]) / 60, 1)
        best = max(rows, key=lambda r: float(r.get("metrics/mAP50-95(B)") or 0))
        result["best_epoch"] = {"epoch": int(float(best["epoch"])), "mAP50": float(best.get("metrics/mAP50(B)") or 0),
                                "mAP50-95": float(best.get("metrics/mAP50-95(B)") or 0)}
    if os.path.exists(report_path):
        report = json.load(open(report_path))
        # "truncated": training stopped early (time limit or crash) and the best weights so far were scored.
        result.update(status="ok" if train_exit == 0 else "truncated", thresholds=report["thresholds"])
        for p in dict.fromkeys((part, "val")):
            result[p] = dict(kinds(report[p]), correct=report[p]["correct"], total=report[p]["total"])
        if "count_weights" in report:
            result["count_weights"] = report["count_weights"]
    else:
        result.update(status="failed", error=error or f"no {part} report",
                      log_tail={"train": tail(log_path), "eval": tail(f"{ROOT}/logs/eval_{name}.log")})
    finish(f, name, result)


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
