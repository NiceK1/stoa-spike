# Blueline on a Verda instance

The demo as a plain service on an Ubuntu instance, open to anyone over HTTPS, with local models only: our ONNX
detectors answer image plans, geometry code answers DXF and IFC, and the fine-tuned Gemma reads the question.
No cloud model is called and none can be: there are no API keys on the instance and the service can only talk to
the machine it runs on.

The Hugging Face Space in `deploy/hf-space` is the same deployment in a container. Both use the same bundle:
`setup.sh` builds the dataset subset with `deploy/hf-space/build_bundle.py` and the service runs with the
environment of that Dockerfile, plus `PLANNER_PROVIDER=gemma-local`.

## What runs where

Everything is under `/srv/blueline` and belongs to the unprivileged user `blueline`.

| Path | What |
|---|---|
| `repo/` | a shallow clone of `main` (https), with `app/node_modules` and the built client in `app/web/dist` |
| `models/` | the two detector weights and `interpreter/interpreter-q8_0.gguf`; hard-linked into `repo/models`, where the app looks. The weights in the repository are Git LFS pointers, and a detector file is accepted only when its SHA-256 is the one the pointer names |
| `dataset/` | the demo subset: 100 held-out image plans, 60 Swiss apartment floors, the IFC models up to 20 MB with their plan sheets (224 drawings, 6,596 questions, 286 MB), with the dataset README and the per-source `LICENSE.md` |
| `node/` | Node 22 from nodejs.org, with npm 11.6.2 (see below) |
| `repo/app/.cache` | the app's cache and the uploads: a tmpfs of 2 GB, so that uploads cannot fill the disk |

| Unit | What |
|---|---|
| `blueline.service` | `node --import tsx server/src/server.ts` on `127.0.0.1:18787`, restarted when it stops |
| `blueline-clean.timer` | every 15 minutes: uploads older than a day are deleted, and when the cache is 80% full its oldest files go |
| `caddy.service` | Caddy from its apt repository: the certificate from Let's Encrypt, http redirected to https, a request body limit of 30 MB, reverse proxy to the app |
| the mount unit of `repo/app/.cache` | the tmpfs |

An instance with the address `a.b.c.d` is served as `https://a-b-c-d.sslip.io`; a name of your own can be given to
`setup.sh` once it points at the instance.

Limits, because the instance also trains models: `Nice=10`, `CPUWeight=20`, `CPUQuota=600%` (six cores),
`MemoryMax=12G`. Measured with the cap: the service uses 3.0 GB of memory with both detectors and the interpreter
loaded; while it answers, a training run on the same instance kept its GPU at 99% and lost 2 to 6% of its CPU share.

What the cap costs: the first question about an image plan runs both detectors on it, 7 to 8 seconds under the cap
(3 seconds without it). The result is cached, and a later question about that plan takes about 0.6 seconds.
`redeploy.sh --warm` asks one question per image plan of the demo, so visitors only wait on a drawing they upload.
The first question after a restart also loads the models (12 seconds, measured cold).

Access: the service sees the repository, the models and the dataset read-only and writes to its cache only. `/data`
(other people's work on the instance), `/root` and `/home` do not exist for it, and the user `blueline` is also
denied `/data` by an ACL entry (`setfacl -x u:blueline /data` removes it). `PRIVATE_PATHS` names other folders.

Logs: `journalctl -u blueline`, `journalctl -u caddy`. State: `systemctl status blueline caddy blueline-clean.timer`.

## Redeploy

```bash
deploy/verda/redeploy.sh <ssh destination>            # main, npm ci if the lock file changed, client build, restart
deploy/verda/redeploy.sh <ssh destination> --models   # also takes the weights and the interpreter again
deploy/verda/redeploy.sh <ssh destination> --warm     # also fills the detectors' cache (a minute when it is filled)
```

The ssh destination is `user@address`, with a user that is root; `SSH_OPTS='-i <key>'` passes options to ssh.
`--models` copies from where the files are produced on the instance: `DETECTORS_SRC` (default `/data/export`) and
`INTERPRETER_SRC` (default `/data/gemma/gguf/fg270m-real-q8_0.gguf`). An interpreter file that is still being
written is left alone and the old one stays in use.

`npm ci` needs the npm that wrote `package-lock.json`. With the lock file of 14 November 2026 that is npm 11.6:
npm 10.9 (which comes with Node 22) and npm 11.21 both refuse it as out of sync. `setup.sh` installs
`NPM_VERSION` (default 11.6.2); when `npm ci` refuses all the same, `redeploy.sh` falls back to `npm install`.

## Move it to another Verda instance

1. Start an Ubuntu 24.04 instance with a public IPv4 address, root access over ssh and ports 80 and 443 open.
2. Put the inputs on it: the detector weights (`*.onnx`, from `models/` on a teammate's machine or `/srv/blueline/models`
   on the old instance), the interpreter GGUF file, and the dataset, unzipped or as the zip.
3. Run `setup.sh` with their places:

   ```bash
   DETECTORS_SRC=/root/models INTERPRETER_SRC=/root/models/interpreter/interpreter-q8_0.gguf DATASET_ZIP=/root/stoa.zip \
     deploy/verda/setup.sh <ssh destination> [site host name]
   ```

   It is safe to run again: it installs what is missing, rewrites the units and the Caddyfile, and ends with
   `redeploy.sh --models --warm`. `REBUILD_DATASET=1` builds the subset again.
4. The address follows the instance (`a-b-c-d.sslip.io`), so links to the old one stop working.
5. On the old instance, if it stays: `systemctl disable --now blueline blueline-clean.timer caddy`, then
   `rm -rf /srv/blueline` after unmounting `repo/app/.cache`.

## What it costs

Nothing on top of the instance it runs on. Today that is the GPU instance we train on, 2.14 EUR per hour whether or
not the demo runs (see `training/README.md`), and the demo stops when that instance is deleted. On its own the demo
needs no GPU: 3 GB of memory, about 3 GB of disk, and as many cores as the first question about a drawing should be
fast (six give 7 to 8 seconds). A small CPU instance would carry it; none was available on Verda when this was set
up, so its price is not measured here. The certificate and the sslip.io name are free.
