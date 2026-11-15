// Gemini reading the drawings alone at a given thinking level: right answers per kind, tokens, seconds and cost per reading.
//   STOA_DATASET=../dataset-full npx tsx scripts/measure-gemini-reading.ts <level> <sample.txt> <from> <count> <concurrency> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GenerativeModel } from "@google/generative-ai";
import { datasetRoot, loadEnv, REPO_ROOT } from "../server/src/config.js";
import { GeminiApiVision } from "../server/src/models/vision.js";
import { ask } from "../server/src/router.js";
import { isCorrect } from "../server/src/scoring.js";
import { rasterTarget } from "../server/src/solvers/raster.js";

loadEnv();
const [level, sample, from, count, concurrency, out] = [process.argv[2], process.argv[3], Number(process.argv[4]), Number(process.argv[5]), Number(process.argv[6] ?? 4), process.argv[7]];
const MODEL = "gemini-4-hydrogen";

const usages: { seconds: number; prompt: number; output: number; thinking: number }[] = [];
const generate = GenerativeModel.prototype.generateContent;
GenerativeModel.prototype.generateContent = async function (...args: any[]) {
  const started = Date.now();
  const result = await (generate as any).apply(this, args);
  const u: any = result.response.usageMetadata ?? {};
  usages.push({ seconds: (Date.now() - started) / 1000, prompt: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0 });
  return result;
};

// "default" leaves the level to the model.
const vision = new GeminiApiVision(MODEL, level === "default" ? undefined : level);
const deps = { vision, planner: null, interpreter: "templates", detector: null, useDetector: false, fileUrl: () => "" } as any;

const byPath = new Map<string, any[]>();
for (const line of readFileSync(join(datasetRoot(), "questions.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (!row.path.includes("/cubicasa5k/") || !/^(How|What) /.test(row.question)) continue;
  if (!byPath.has(row.path)) byPath.set(row.path, []);
  byPath.get(row.path)!.push(row);
}
const paths = readFileSync(join(REPO_ROOT, sample), "utf8").split(/\r?\n/).filter(Boolean).slice(from, from + count);
const rows: any[] = [];
let failed = 0;
async function drawing(path: string) {
  for (const row of byPath.get(path) ?? []) {
    let value: unknown = null;
    try {
      value = (await ask({ file: join(datasetRoot(), path), question: row.question, type: row.type }, deps)).value;
    } catch (e) {
      failed++;
      console.error(`${path}: ${(e as Error).message.slice(0, 160)}`);
    }
    rows.push({ path, question: row.question, kind: rasterTarget(row.question)?.id ?? "other", expected: row.answer, value, right: isCorrect(row.type, row.answer, value as any) === true });
  }
}
const queue = [...paths];
await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) await drawing(queue.shift()!); }));

const kinds: Record<string, [number, number]> = {};
for (const r of rows) { (kinds[r.kind] ??= [0, 0])[0]++; if (r.right) kinds[r.kind][1]++; }
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
const cost = usages.map((u) => u.prompt * 1.5e-6 + (u.output + u.thinking) * 7.5e-6);
console.log(`${(vision as any).id}: ${paths.length} drawings, ${rows.length} questions, ${rows.filter((r) => r.right).length} right, ${failed} failed`);
console.log(Object.entries(kinds).map(([k, [n, right]]) => `${k} ${right}/${n}`).join(" | "));
console.log(`${usages.length} fresh readings: ${mean(usages.map((u) => u.seconds)).toFixed(1)} s mean, ${median(usages.map((u) => u.seconds)).toFixed(1)} s median | prompt ${mean(usages.map((u) => u.prompt)).toFixed(0)} | output ${mean(usages.map((u) => u.output)).toFixed(0)} | thinking ${mean(usages.map((u) => u.thinking)).toFixed(0)} mean, ${median(usages.map((u) => u.thinking)).toFixed(0)} median | cost $${mean(cost).toFixed(4)} mean, $${median(cost).toFixed(4)} median`);
if (out) writeFileSync(out, JSON.stringify(rows.map(({ right, ...r }) => r)));
