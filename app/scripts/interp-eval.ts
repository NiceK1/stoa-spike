/**
 * Scores an interpreter on the held-out pairs of scripts/interp-pairs.ts: exact match of the whole call, and of the
 * fields its operation reads, by drawing type, operation, language and family, with the time per question.
 * The interpreter is the one PLANNER_PROVIDER and PLANNER_MODEL name, asked with the request the app would send.
 *
 *   PLANNER_PROVIDER=gemma-local npx tsx scripts/interp-eval.ts --pairs <dir>/test.jsonl [--limit 200] [--concurrency 1] [--dump misses.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { loadEnv } from "../server/src/config.js";
import { createPlanner, type VisionRequest } from "../server/src/models/vision.js";

loadEnv();
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

interface Row {
  request: VisionRequest;
  call: Record<string, unknown>;
  asked: string;
  type: string;
  family: string;
  template: string;
  lang: string;
}

/** The call without what a correct reading may vary: the free-text reason, the order of lists, the case of free words. */
function normal(call: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call)) {
    if (key === "reason") continue;
    if (Array.isArray(value)) out[key] = value.map((each) => (key === "missing" ? String(each).toLowerCase() : String(each))).sort();
    else out[key] = key === "items" ? String(value).trim().toLowerCase() : value;
  }
  return out;
}

// The fields each operation reads; the app ignores the others (runTakeoff, planRaster and planIfc in planner.ts).
const USED: Record<string, Record<string, string[]>> = {
  dxf: {
    count_symbols: ["symbols", "labels", "room_numbers", "apartments", "missing", "locate"],
    count_apartments: ["locate"],
    rooms: ["labels", "room_numbers", "apartments", "pick", "measure", "missing", "broader_label", "locate", "answer_type"],
    area_apartment: ["apartments", "missing", "locate"],
    area_floor: ["locate"],
    compare: ["symbols", "labels", "room_numbers", "apartments", "measure", "missing"],
    none: [],
  },
  raster: { count_known: ["targets", "whole_drawing", "locate"], count_other: ["items", "locate"], read: ["answer_type"] },
  ifc: {
    count_elements: ["elements", "storey", "missing", "locate"],
    rooms: ["rooms", "storey", "pick", "measure", "missing", "locate", "answer_type"],
    storey_total: ["quantity", "storey", "missing"],
    model_facts: ["answer_type"],
    none: [],
  },
};

/** The call reduced to what its operation reads, with 'room 9.99' and '9.99' in missing taken as the same. */
function effective(call: Record<string, unknown>, type: string): Record<string, unknown> {
  const whole = normal(call);
  const fields = USED[type]?.[String(whole.operation)];
  if (!fields) return whole;
  const out: Record<string, unknown> = { operation: whole.operation };
  for (const field of fields) out[field] = whole[field];
  if (Array.isArray(out.missing)) out.missing = out.missing.map((word) => String(word).replace(/^(room|apartment) +/, "")).sort();
  return out;
}

const rows = readFileSync(option("pairs")!, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row).slice(0, Number(option("limit", "0")) || undefined);
const planner = createPlanner();
if (!planner) throw new Error("no interpreter: set PLANNER_PROVIDER and PLANNER_MODEL");

const groups = new Map<string, [number, number, number]>();
const misses: Record<string, unknown>[] = [];
const seconds: number[] = [];
let next = 0, failed = 0;
async function worker(): Promise<void> {
  while (next < rows.length) {
    const row = rows[next++];
    let output: Record<string, unknown> | null = null;
    try {
      const result = await planner!.ask(row.request);
      output = result.output;
      seconds.push(result.seconds);
    } catch (error) {
      failed++;
      misses.push({ asked: row.asked, error: String(error).slice(0, 200) });
    }
    const hit = output !== null && isDeepStrictEqual(normal(output), normal(row.call));
    const used = output !== null && isDeepStrictEqual(effective(output, row.type), effective(row.call, row.type));
    const keys = ["all", `type=${row.type}`, `family=${row.family}`, `type+family=${row.type}/${row.family}`, `op=${row.type}.${row.call.operation}`, `lang=${row.lang}`];
    if (row.family === "reworded") keys.push(`style=${row.template}`);
    for (const key of keys) {
      const [hits, usedHits, n] = groups.get(key) ?? [0, 0, 0];
      groups.set(key, [hits + (hit ? 1 : 0), usedHits + (used ? 1 : 0), n + 1]);
    }
    if (!hit && output) misses.push({ asked: row.asked, type: row.type, family: row.family, template: row.template, fieldsUsedMatch: used, want: row.call, got: output });
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: Number(option("concurrency", "1")) }, worker));

const sorted = [...seconds].sort((a, b) => a - b);
const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]?.toFixed(2);
console.log(`${planner.id}: ${rows.length} questions, ${failed} without a call, ${((Date.now() - started) / 1000).toFixed(0)} s wall`);
console.log(`seconds per question: mean ${(seconds.reduce((a, b) => a + b, 0) / Math.max(1, seconds.length)).toFixed(2)}, median ${at(0.5)}, p95 ${at(0.95)}`);
console.log(`  ${"group".padEnd(34)} whole call         fields the operation reads`);
for (const [key, [hits, usedHits, n]] of [...groups].sort()) {
  console.log(`  ${key.padEnd(34)} ${`${hits}/${n} (${((hits / n) * 100).toFixed(1)}%)`.padEnd(18)} ${usedHits}/${n} (${((usedHits / n) * 100).toFixed(1)}%)`);
}
if (option("dump")) writeFileSync(option("dump")!, JSON.stringify(misses, null, 1));
process.exit(0);
