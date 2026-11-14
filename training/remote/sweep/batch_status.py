"""Progress of a batch across machines, read on the instance that outlives the sweep.

    batch_status.py <name> [<name> ...]

Results arrive in /data/sweep/results from this machine's queue and, through push.sh, from the burst instance,
whose queue state is mirrored in status8.json. Prints ALL_DONE once every named run has a result or can no longer
get one because its machine stopped reporting.
"""
import json
import os
import sys
import time

sys.path.insert(0, "/data/sweep")
import status  # noqa: E402

ROOT = "/data/sweep"
STALE_SECONDS = 900


def main():
    names = sys.argv[1:]
    local = status.collect()
    remote, age = {}, None
    if os.path.exists(f"{ROOT}/status8.json"):
        mirror = json.load(open(f"{ROOT}/status8.json"))
        remote, age = mirror["runs"], time.time() - mirror["written"]
    print(f"burst instance last reported {age / 60:.1f} min ago" if age is not None else "burst instance has not reported")
    open_runs = []
    for name in names:
        if os.path.exists(f"{ROOT}/results/{name}.json"):
            result = json.load(open(f"{ROOT}/results/{name}.json"))
            print(f"{name:12} {result.get('status', '?'):9} epochs {result.get('epochs_run')}/{result.get('epochs_planned')}  "
                  f"{result.get('minutes', {}).get('total')} min  {status.summary(result)}")
        elif name in local and local[name]["state"] in ("pending", "running"):
            print(status.line(name, local[name]) + " (this instance)")
            open_runs.append(name)
        elif name in local:
            print(status.line(name, local[name]) + " (this instance, worker died)")
        elif name in remote and age < STALE_SECONDS:
            print(status.line(name, remote[name]) + " (burst instance)")
            open_runs.append(name)
        elif name in remote:
            print(f"{name:12} lost      burst instance stopped reporting at epoch "
                  f"{remote[name].get('epoch')}/{remote[name]['epochs']}")
        else:
            print(f"{name:12} removed   not in any queue")
    running = any(e["state"] == "running" for e in local.values()) or (age is not None and age < STALE_SECONDS)
    print(status.verdict(open_runs, running))


if __name__ == "__main__":
    main()
