"""State of the sweep queue on this machine: one line per experiment, then ALL_DONE when nothing is pending or running.

    status.py [--write SUFFIX]        # --write also saves status<SUFFIX>.txt and status<SUFFIX>.json in /data/sweep
"""
import csv
import json
import os
import socket
import sys
import time

ROOT = "/data/sweep"
QUEUE = f"{ROOT}/queue"
SCORE_MINUTES = 4  # scoring val and dev after training


def worker_alive(gpu):
    try:
        pid = int(open(f"{QUEUE}/worker{gpu}.pid").read())
        return "worker.py" in open(f"/proc/{pid}/cmdline").read()
    except (OSError, ValueError):
        return False


def any_worker_alive():
    return any(worker_alive(f[6:-4]) for f in os.listdir(QUEUE) if f.startswith("worker") and f.endswith(".pid"))


def verdict(open_runs, running):
    """Last line of a status report; open_runs are the experiments without a result yet."""
    if not open_runs:
        return "ALL_DONE"
    if not running and not any_worker_alive():
        return f"STALLED {len(open_runs)} pending and no worker alive: run submit.py without a batch file"
    return f"ACTIVE {len(open_runs)}: {' '.join(open_runs)}"


def progress(name):
    try:
        rows = [{k.strip(): v.strip() for k, v in r.items()}
                for r in csv.DictReader(open(f"{ROOT}/runs/{name}/results.csv"))]
    except OSError:
        rows = []
    return len(rows), (float(rows[-1]["time"]) / len(rows) if rows else None)


def summary(result):
    if "summary" in result:
        return str(result["summary"])[:200]
    part = next((p for p in ("dev", "val") if p in result), None)
    if part is None:
        return str(result.get("error", ""))[:80]
    kinds = [f"{k} {v['exact']}/{v['asked']}" for k, v in result[part].items() if isinstance(v, dict)]
    return f"{part} {result[part]['correct']}/{result[part]['total']}: " + ", ".join(kinds)


def collect():
    runs = {}
    for state in ("pending", "running", "done", "failed"):
        if not os.path.isdir(f"{QUEUE}/{state}"):
            continue
        for f in sorted(os.listdir(f"{QUEUE}/{state}")):
            try:
                spec = json.load(open(f"{QUEUE}/{state}/{f}"))
            except (OSError, ValueError):
                continue
            name, run = spec["name"], spec.get("run", {})
            entry = {"state": state, "gpu": run.get("gpu"), "epochs": spec.get("epochs"), "submitted": spec["submitted"]}
            if state == "running":
                done, per_epoch = progress(name)
                entry.update(epoch=done, minutes=round((time.time() - run.get("started", time.time())) / 60, 1))
                if per_epoch and spec.get("epochs"):
                    entry["eta_minutes"] = round((spec["epochs"] - done) * per_epoch / 60 + SCORE_MINUTES)
                if not worker_alive(run.get("gpu")):
                    entry["state"] = "lost"  # its worker died, e.g. in a reboot
            elif state != "pending" and os.path.exists(f"{ROOT}/results/{name}.json"):
                result = json.load(open(f"{ROOT}/results/{name}.json"))
                entry.update(state=result.get("status", state), epoch=result.get("epochs_run"),
                             minutes=result.get("minutes", {}).get("total"), summary=summary(result))
            runs[name] = entry
    return runs


def line(name, e):
    text = f"{name:12} {e['state']:9} gpu {e['gpu'] if e['gpu'] is not None else '-':<2} "
    if "epoch" in e:
        text += f"epoch {e['epoch']}/{e['epochs']}  {e.get('minutes')} min  "
    if "eta_minutes" in e:
        text += f"about {e['eta_minutes']} min left  "
    return text + e.get("summary", "")


def main():
    runs = collect()
    active = [n for n, e in runs.items() if e["state"] in ("pending", "running")]
    lines = [line(n, e) for n, e in sorted(runs.items(), key=lambda kv: kv[1]["submitted"])]
    lines.append(verdict(active, any(e["state"] == "running" for e in runs.values())))
    text = f"{socket.gethostname()} {time.strftime('%Y-%m-%d %H:%M:%S')}\n" + "\n".join(lines)
    print(text)
    if "--write" in sys.argv:
        suffix = sys.argv[sys.argv.index("--write") + 1]
        with open(f"{ROOT}/status{suffix}.txt.tmp", "w") as f:
            f.write(text + "\n")
        os.replace(f"{ROOT}/status{suffix}.txt.tmp", f"{ROOT}/status{suffix}.txt")
        json.dump({"written": time.time(), "host": socket.gethostname(), "runs": runs, "all_done": not active},
                  open(f"{ROOT}/status{suffix}.json.tmp", "w"))
        os.replace(f"{ROOT}/status{suffix}.json.tmp", f"{ROOT}/status{suffix}.json")


if __name__ == "__main__":
    main()
