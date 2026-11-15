#!/usr/bin/env node
// Load generator for one Blueline server: N users, each asking the dataset's own questions through POST /api/ask.
//
//   node deploy/verda/loadtest.mjs --url http://127.0.0.1:18790 --dataset /srv/blueline/dataset --users 8 --seconds 120
//
// Options: --per-drawing 3 (questions a user asks before moving to the next drawing), --kinds raster,dxf,ifc (leave
// kinds out to load one pipeline alone), --seed 1, --timeout 180 (seconds per request), --no-warmup,
// --pid <server pid> (Linux: reports the CPU the server used), --json <file>, --label <text>.
//
// Closed loop: a user sends the next question as soon as the last one is answered, so the answer rate at N users is
// what the server can carry with N questions in flight. Drawings come from one shared queue in the proportions of the
// dataset, and no drawing is handed out twice: the first question on a drawing is always real work (a detector scan,
// a parse), never a cache hit left by another user. The run ends early when the queue is empty.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8787" },
    dataset: { type: "string" },
    users: { type: "string", default: "4" },
    seconds: { type: "string", default: "120" },
    "per-drawing": { type: "string", default: "3" },
    kinds: { type: "string", default: "raster,dxf,ifc" },
    seed: { type: "string", default: "1" },
    timeout: { type: "string", default: "180" },
    "no-warmup": { type: "boolean", default: false },
    pid: { type: "string" },
    json: { type: "string" },
    label: { type: "string", default: "" },
  },
});
if (!args.dataset) {
  console.error("usage: loadtest.mjs --url <server> --dataset <folder with questions.jsonl> --users <n> --seconds <s>");
  process.exit(2);
}
const users = Number(args.users), seconds = Number(args.seconds), perDrawing = Number(args["per-drawing"]);
const timeoutMs = Number(args.timeout) * 1000;

// The pipeline a drawing goes to follows from its source: the Swiss PDFs are answered from their DXF twins and the
// IFC plan sheets from the model they were rendered from.
const KIND_OF_SOURCE = { cubicasa5k: "raster", swiss_dwellings: "dxf", ifc_models: "ifc" };
const kindOf = (path) => KIND_OF_SOURCE[path.split("/")[1]] ?? "other";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(Number(args.seed));
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const wanted = new Set(args.kinds.split(","));
const questionsByDrawing = new Map();
for (const line of readFileSync(join(args.dataset, "questions.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (!wanted.has(kindOf(row.path))) continue;
  if (!questionsByDrawing.has(row.path)) questionsByDrawing.set(row.path, []);
  questionsByDrawing.get(row.path).push(row.question);
}

// One queue with every kind spread evenly along it, so any stretch of the run has the dataset's mix.
const byKind = new Map();
for (const path of questionsByDrawing.keys()) {
  const kind = kindOf(path);
  if (!byKind.has(kind)) byKind.set(kind, []);
  byKind.get(kind).push(path);
}
for (const list of byKind.values()) shuffle(list.sort());
const queue = [];
const taken = new Map([...byKind.keys()].map((kind) => [kind, 0]));
for (let i = 0; i < questionsByDrawing.size; i++) {
  let next = null;
  for (const [kind, list] of byKind) {
    const done = taken.get(kind);
    if (done < list.length && (next === null || done / list.length < taken.get(next) / byKind.get(next).length)) next = kind;
  }
  queue.push(byKind.get(next)[taken.get(next)]);
  taken.set(next, taken.get(next) + 1);
}
const mix = Object.fromEntries([...byKind].map(([kind, list]) => [kind, list.length]));

async function ask(path, question) {
  const started = performance.now();
  try {
    const response = await fetch(`${args.url}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, question }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    const ms = performance.now() - started;
    if (!response.ok) return { ms, error: `HTTP ${response.status}: ${String(body?.error ?? "").slice(0, 120)}` };
    const value = body?.answer?.value;
    return { ms, hasValue: value !== null && value !== undefined, correct: body?.expected?.correct === true };
  } catch (error) {
    return { ms: performance.now() - started, error: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code ?? error?.message ?? error) };
  }
}

function pickQuestions(path) {
  return shuffle([...questionsByDrawing.get(path)]).slice(0, perDrawing);
}

/** CPU seconds the server process has used so far (user and system), from /proc; null where there is no /proc. */
function cpuSeconds(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    return null;
  }
}

const health = await fetch(`${args.url}/api/health`).then((r) => r.json());

// The first question after a start loads the models. It is timed apart and its drawings are not used again.
const warmup = {};
if (!args["no-warmup"]) {
  for (const kind of byKind.keys()) {
    const at = queue.findIndex((path) => kindOf(path) === kind);
    const [path] = queue.splice(at, 1);
    const result = await ask(path, pickQuestions(path)[0]);
    warmup[kind] = result.error ? result.error : Math.round(result.ms);
  }
}

const samples = [];
let cursor = 0, drawingsStarted = 0, drawingsFinished = 0;
const begin = performance.now();
const deadline = begin + seconds * 1000;
const cpuBefore = args.pid ? cpuSeconds(args.pid) : null;

async function user() {
  while (performance.now() < deadline && cursor < queue.length) {
    const path = queue[cursor++];
    const kind = kindOf(path);
    drawingsStarted++;
    const questions = pickQuestions(path);
    for (let i = 0; i < questions.length; i++) {
      if (performance.now() >= deadline) return;
      const result = await ask(path, questions[i]);
      samples.push({ kind, first: i === 0, end: performance.now(), ...result });
    }
    drawingsFinished++;
  }
}
await Promise.all(Array.from({ length: users }, user));
const lastEnd = performance.now();
const cpuAfter = args.pid ? cpuSeconds(args.pid) : null;

// Answers that arrived inside the window count for the rate; the ones in flight at the deadline only for latency.
const windowMs = Math.min(lastEnd, deadline) - begin;
const inWindow = samples.filter((s) => s.end <= deadline && !s.error);
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
function latency(rows) {
  const ms = rows.filter((s) => !s.error).map((s) => s.ms).sort((a, b) => a - b);
  return { n: ms.length, p50: round(percentile(ms, 0.5)), p95: round(percentile(ms, 0.95)), max: round(ms.at(-1) ?? null) };
}
function round(ms) {
  return ms === null ? null : Number((ms / 1000).toFixed(ms < 1000 ? 3 : 2));
}

const errors = {};
for (const s of samples) if (s.error) errors[s.error] = (errors[s.error] ?? 0) + 1;
const kinds = {};
for (const kind of byKind.keys()) {
  const rows = samples.filter((s) => s.kind === kind);
  kinds[kind] = {
    first: latency(rows.filter((s) => s.first)),
    later: latency(rows.filter((s) => !s.first)),
    answersPerMinute: Number(((inWindow.filter((s) => s.kind === kind).length * 60000) / windowMs).toFixed(1)),
    withValue: rows.filter((s) => s.hasValue).length,
    correct: rows.filter((s) => s.correct).length,
    errors: rows.filter((s) => s.error).length,
  };
}
const report = {
  label: args.label,
  server: health,
  users,
  perDrawing,
  secondsAsked: seconds,
  secondsRun: Number((windowMs / 1000).toFixed(1)),
  queueExhausted: cursor >= queue.length,
  mix,
  warmupMs: warmup,
  answers: inWindow.length,
  answersPerMinute: Number(((inWindow.length * 60000) / windowMs).toFixed(1)),
  drawingsStarted,
  drawingsPerMinute: Number(((drawingsFinished * 60000) / windowMs).toFixed(1)),
  all: latency(samples),
  kinds,
  errors,
  serverCores: cpuBefore !== null && cpuAfter !== null ? Number(((cpuAfter - cpuBefore) / ((lastEnd - begin) / 1000)).toFixed(2)) : null,
};
if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));

const s = (value) => (value === null ? "-" : `${value} s`);
console.log(`${args.label ? `${args.label}: ` : ""}${users} users, ${report.secondsRun} s${report.queueExhausted ? " (every drawing used)" : ""}, ${perDrawing} questions per drawing, drawings ${JSON.stringify(mix)}`);
if (Object.keys(warmup).length) console.log(`  first question after start, ms: ${JSON.stringify(warmup)}`);
console.log(`  ${report.answersPerMinute} answers/min, ${report.drawingsPerMinute} drawings/min, median ${s(report.all.p50)}, p95 ${s(report.all.p95)}${report.serverCores === null ? "" : `, server used ${report.serverCores} cores`}`);
for (const [kind, k] of Object.entries(kinds)) {
  console.log(`  ${kind.padEnd(6)} first question on a drawing: n ${k.first.n}, median ${s(k.first.p50)}, p95 ${s(k.first.p95)}; later: n ${k.later.n}, median ${s(k.later.p50)}, p95 ${s(k.later.p95)}; ${k.answersPerMinute}/min, ${k.withValue} with a value, ${k.correct} correct, ${k.errors} errors`);
}
console.log(`  errors: ${Object.keys(errors).length ? JSON.stringify(errors) : "none"}`);
