"""Queue a batch of experiments and make sure every GPU has a worker.

    submit.py [<batch.json>] [--gpus 0,1,2]

Without a batch file it only restarts workers, for experiments left pending after a reboot.
The batch file is a JSON list; each experiment is
    {"name": "base", "weights": "yolo11l.pt", "imgsz": 1280, "epochs": 60, "batch": 16,
     "data": "/data/sweep/data/yolo_sym", "train": ["fliplr=0.5", "flipud=0.5"], "export": null}
"train" holds extra train.py key=value arguments; "export" is an ONNX export name, or null for no export.
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, "/data/sweep")
import status  # noqa: E402

ROOT = "/data/sweep"
QUEUE = f"{ROOT}/queue"
STATES = ("pending", "running", "done", "failed")


def main():
    batch_path = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else None
    if "--gpus" in sys.argv:
        gpus = sys.argv[sys.argv.index("--gpus") + 1].split(",")
    else:
        gpus = subprocess.run(["nvidia-smi", "--query-gpu=index", "--format=csv,noheader"],
                              capture_output=True, text=True).stdout.split()
    for d in (*(f"{QUEUE}/{s}" for s in STATES), f"{ROOT}/results", f"{ROOT}/logs", f"{ROOT}/batches"):
        os.makedirs(d, exist_ok=True)
    batch = json.load(open(batch_path)) if batch_path else []
    taken ={f[:-5] for s in STATES for f in os.listdir(f"{QUEUE}/{s}")}
    clash = [e["name"] for e in batch if e["name"] in taken]
    if clash or len({e["name"] for e in batch}) != len(batch):
        sys.exit(f"experiment names must be new and unique; already used: {clash}")
    for e in batch:
        missing = [k for k in ("name", "weights", "imgsz", "epochs", "batch", "data") if k not in e]
        if missing or not os.path.exists(f"{e['data']}/data.yaml"):
            sys.exit(f"{e.get('name')}: missing {missing or e['data'] + '/data.yaml'}")
    if batch_path and os.path.abspath(batch_path) != f"{ROOT}/batches/{os.path.basename(batch_path)}":
        shutil.copy(batch_path, f"{ROOT}/batches/{os.path.basename(batch_path)}")
    for i, e in enumerate(batch):
        json.dump(dict(e, submitted=time.time() + i * 1e-3), open(f"{QUEUE}/{e['name']}.tmp", "w"))
        os.replace(f"{QUEUE}/{e['name']}.tmp", f"{QUEUE}/pending/{e['name']}.json")
    started = []
    for gpu in gpus:
        pid_file = f"{QUEUE}/worker{gpu}.pid"
        if status.worker_alive(gpu):
            continue
        log = open(f"{ROOT}/logs/worker{gpu}.log", "a")
        p = subprocess.Popen(["/data/venv/bin/python", f"{ROOT}/worker.py", gpu], stdout=log, stderr=log,
                             stdin=subprocess.DEVNULL, start_new_session=True, cwd="/data")
        open(pid_file, "w").write(str(p.pid))
        started.append(gpu)
    print(f"queued {[e['name'] for e in batch]}; workers started on GPUs {started}, already running on "
          f"{[g for g in gpus if g not in started]}")


if __name__ == "__main__":
    main()
