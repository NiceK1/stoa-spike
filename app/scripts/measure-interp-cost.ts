// Seconds and reported cost per interpretation for the interpreter PLANNER_PROVIDER and PLANNER_MODEL name, on held-out pairs.
//   PLANNER_PROVIDER=anthropic-api PLANNER_MODEL=claude-haiku-5-5 npx tsx scripts/measure-interp-cost.ts <test.jsonl> <from> <count>
import { readFileSync } from "node:fs";
import { loadEnv } from "../server/src/config.js";
import { createPlanner } from "../server/src/models/vision.js";

loadEnv();
const planner = createPlanner()!;
const [file, from, count] = [process.argv[2], Number(process.argv[3] ?? 0), Number(process.argv[4] ?? 30)];
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(from, from + count).map((line) => JSON.parse(line));
const seconds: number[] = [];
const costs: number[] = [];
const byType: Record<string, number[]> = {};
let cached = 0;
let failed = 0;
for (const row of rows) {
  try {
    const result: any = await planner.ask(row.request);
    if (result.cached) { cached++; continue; }
    seconds.push(result.seconds);
    costs.push(result.costUsd);
    (byType[row.type] ??= []).push(result.costUsd);
  } catch (e) {
    failed++;
    console.error((e as Error).message.slice(0, 200));
  }
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const sorted = [...seconds].sort((a, b) => a - b);
console.log(`${planner.id}: ${seconds.length} fresh calls, ${cached} cached, ${failed} failed`);
console.log(`seconds: mean ${mean(seconds).toFixed(2)}, median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(2)}, p90 ${sorted[Math.floor(sorted.length * 0.9)]?.toFixed(2)}`);
console.log(`cost per call: mean $${mean(costs).toFixed(5)} | ${Object.entries(byType).map(([t, v]) => `${t} $${mean(v).toFixed(5)} (${v.length})`).join(", ")}`);
