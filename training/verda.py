"""Small Verda Cloud API client for the training run.

Credentials are read from ~/.ssh/verda_stoa_api.json ({"client_id": ..., "client_secret": ...}); nothing secret lives in the repo.

    python verda.py types            # GPU instance types with price and current availability
    python verda.py images           # OS images
    python verda.py keys             # SSH keys
    python verda.py list             # instances, volumes and trashed volumes in the project
    python verda.py create <type> <image> <location> [--disk GB] [--name NAME] [--spot]
    python verda.py wait <instance-id>         # blocks until the instance runs, prints its IP
    python verda.py delete <instance-id> [volume-id ...]
                                     # deletes the instance and its volumes permanently; prints DELETED_OK and exits 0
                                     # only when a fresh listing shows none of them. Safe to repeat.
    python verda.py balance
    python verda.py raw <METHOD> <path>        # in Git Bash write the path without the leading slash
"""
import argparse
import http.client
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

BASE = "https://api.verda.com/v1"
CREDENTIALS = os.path.expanduser("~/.ssh/verda_stoa_api.json")
TRANSIENT = {429, 500, 502, 503, 504}

_getaddrinfo = socket.getaddrinfo


def ipv4_first(*args, **kwargs):
    """Where IPv6 resolves but does not route, every call would first wait out two connect timeouts (about 40 s)."""
    return sorted(_getaddrinfo(*args, **kwargs), key=lambda info: info[0] != socket.AF_INET)


socket.getaddrinfo = ipv4_first


class ApiError(Exception):
    def __init__(self, method, path, code, text):
        super().__init__(f"{method} {path} -> HTTP {code}: {text}")
        self.code = code


def call(method, path, body=None, token=None, attempts=4):
    """One API call. Transport failures and 5xx are retried, except for POSTs that create something."""
    repeatable = method != "POST" or path == "/oauth2/token"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    for attempt in range(attempts):
        last = attempt + 1 == attempts or not repeatable
        request = urllib.request.Request(BASE + path, method=method, headers=headers,
                                         data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
        except urllib.error.HTTPError as e:
            text = e.read()[:500].decode("utf-8", "replace")
            if e.code in TRANSIENT and not last:
                time.sleep(5 * (attempt + 1))
                continue
            raise ApiError(method, path, e.code, text) from None
        except (urllib.error.URLError, http.client.HTTPException, OSError) as e:
            if not last:
                time.sleep(5 * (attempt + 1))
                continue
            raise ApiError(method, path, 0, repr(e)) from None
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return raw.decode("utf-8", "replace")


def login():
    with open(CREDENTIALS, encoding="utf-8") as f:
        c = json.load(f)
    return call("POST", "/oauth2/token", {"grant_type": "client_credentials", **c})["access_token"]


def snapshot(token):
    """Instances, live volumes and trashed volumes, each keyed by id."""
    instances = {i["id"]: i for i in call("GET", "/instances", token=token)}
    volumes = {v["id"]: v for v in call("GET", "/volumes", token=token)}
    trash = {v["id"]: v for v in call("GET", "/volumes/trash", token=token) if not v.get("is_permanently_deleted")}
    return instances, volumes, trash


def delete(token, instance_id, extra_volumes=(), wait=600):
    """Delete an instance, then every volume it had, permanently. Returns True when a listing shows nothing left."""
    instances, volumes, trash = snapshot(token)
    instance = instances.get(instance_id)
    targets = set(extra_volumes)
    targets.update(v for v, d in volumes.items() if d.get("instance_id") == instance_id)
    if instance:
        # The OS volume is repeated in volume_ids; the API answers 404 "Volume ID doesn't exist" to a duplicate.
        targets.update(filter(None, [instance.get("os_volume_id"), *(instance.get("volume_ids") or [])]))
    print("instance:", instance_id, instance["status"] if instance else "not listed", "| volumes:", sorted(targets))

    if instance:
        body = {"id": instance_id, "action": "delete", "volume_ids": sorted(targets), "delete_permanently": True}
        try:
            print("delete instance with volumes:", call("PUT", "/instances", body, token))
        except ApiError as e:
            print("delete with volumes refused:", e)
            # An empty list detaches the volumes; they are removed below.
            print("delete instance alone:", call("PUT", "/instances", dict(body, volume_ids=[]), token))

    deadline = time.time() + wait
    while True:
        instances, volumes, trash = snapshot(token)
        for v in targets:
            holder = volumes.get(v) or trash.get(v)
            if holder and (instance_id not in instances or holder.get("instance_id") != instance_id):
                try:
                    print("delete volume", v, call("DELETE", "/volumes/" + v, {"is_permanent": True}, token))
                except ApiError as e:
                    print("volume", v, "not deleted yet:", e)
        left = [instance_id] * (instance_id in instances) + [v for v in targets if v in volumes or v in trash]
        if not left:
            print("DELETED_OK", instance_id, "and volumes", sorted(targets))
            return True
        if time.time() > deadline:
            print("STILL_PRESENT", left)
            return False
        time.sleep(15)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["types", "images", "keys", "list", "create", "wait", "delete", "balance", "raw"])
    p.add_argument("args", nargs="*")
    p.add_argument("--disk", type=int, default=200)
    p.add_argument("--name", default="stoa-train")
    p.add_argument("--spot", action="store_true")
    a = p.parse_args()
    token = login()

    if a.command == "balance":
        print(call("GET", "/balance", token=token))
    elif a.command == "raw":
        print(json.dumps(call(a.args[0], "/" + a.args[1].lstrip("/"), token=token), indent=1)[:6000])
    elif a.command == "types":
        available = {}
        for entry in call("GET", "/instance-availability", token=token):
            for t in entry["availabilities"]:
                available.setdefault(t, []).append(entry["location_code"])
        rows = []
        for t in call("GET", "/instance-types", token=token):
            gpu = t.get("gpu", {})
            if not gpu.get("number_of_gpus"):
                continue
            rows.append((float(t["price_per_hour"]), t["instance_type"], gpu["number_of_gpus"], gpu["description"],
                         t["gpu_memory"]["size_in_gigabytes"], t["cpu"]["number_of_cores"],
                         t["memory"]["size_in_gigabytes"], ",".join(available.get(t["instance_type"], [])) or "-"))
        for price, name, n, desc, vram, cores, ram, where in sorted(rows):
            print(f"{price:7.3f}/h  {name:16} {n}x {desc[:34]:34} vram {vram:4} GB  cpu {cores:3}  ram {ram:4} GB  avail: {where}")
    elif a.command == "images":
        for image in call("GET", "/images", token=token):
            print(image["image_type"], "|", image["name"])
    elif a.command == "keys":
        for key in call("GET", "/sshkeys", token=token):
            print(key["id"], key["name"])
    elif a.command == "list":
        instances, volumes, trash = snapshot(token)
        for i in instances.values():
            print("instance", i["id"], i["hostname"], i["instance_type"], i["status"], i.get("ip"), i.get("location"),
                  f"{i.get('price_per_hour')}/h", "created", i.get("created_at"))
        for v in volumes.values():
            print("volume", v["id"], v["name"], v["size"], "GB", v["status"], "attached to", v.get("instance_id"))
        for v in trash.values():
            print("trashed volume", v["id"], v["name"], v["size"], "GB", "deleted", v.get("deleted_at"))
    elif a.command == "create":
        instance_type, image, location = a.args
        keys = [k["id"] for k in call("GET", "/sshkeys", token=token)]
        body = {"instance_type": instance_type, "image": image, "ssh_key_ids": keys, "hostname": a.name,
                "description": "stoa floor-plan detector training", "location_code": location,
                "os_volume": {"name": a.name + "-os", "size": a.disk}, "is_spot": a.spot}
        try:
            print("created instance id:", call("POST", "/instances", body, token))
        except ApiError as e:
            sys.exit(f"{e}\nThe request is not repeated automatically: run `list` to see whether the instance exists.")
    elif a.command == "wait":
        deadline = time.time() + 1200
        while True:
            i = call("GET", "/instances/" + a.args[0], token=token)
            print(time.strftime("%H:%M:%S"), i["status"], i.get("ip"), flush=True)
            if i["status"] == "running" and i.get("ip"):
                print("RUNNING", i["id"], i["ip"], "os_volume", i.get("os_volume_id"), "created", i.get("created_at"))
                return
            if i["status"] in ("error", "no_capacity", "installation_failed", "discontinued") or time.time() > deadline:
                sys.exit(f"instance {a.args[0]} is {i['status']}")
            time.sleep(15)
    elif a.command == "delete":
        if not delete(token, a.args[0], a.args[1:]):
            sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except ApiError as e:
        sys.exit(str(e))
