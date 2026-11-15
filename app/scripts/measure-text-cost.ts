// Seconds and reported cost of the model calls behind text answers (IFC facts, sheet text), with the keyword parsers reading the question.
//   VISION_PROVIDER=anthropic-api STOA_DATASET=../dataset-full npx tsx scripts/measure-text-cost.ts <source> <files> <per file>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { datasetRoot, loadEnv } from "../server/src/config.js";
import { createDetector } from "../server/src/models/detector.js";
import { createVision } from "../server/src/models/vision.js";
import { ask } from "../server/src/router.js";

loadEnv();
const [source, files, perFile] = [process.argv[2], Number(process.argv[3] ?? 4), Number(process.argv[4] ?? 1)];
const vision = createVision();
const calls: { seconds: number; costUsd: number; cached: boolean }[] = [];
const original = vision.ask.bind(vision);
(vision as any).ask = async (request: any) => {
  const result: any = await original(request);
  calls.push({ seconds: result.seconds, costUsd: result.costUsd, cached: !!result.cached });
  return result;
};
const deps = { vision, planner: null, interpreter: "templates", detector: createDetector(), fileUrl: () => "" } as any;

const byPath = new Map<string, any[]>();
for (const line of readFileSync(join(datasetRoot(), "questions.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.path.split("/")[1] !== source || row.type !== "text") continue;
  if (!byPath.has(row.path)) byPath.set(row.path, []);
  byPath.get(row.path)!.push(row);
}
const paths = [...byPath.keys()];
let answered = 0;
let asked = 0;
for (let i = 0; i < Math.min(files, paths.length); i++) {
  const path = paths[Math.floor((i * paths.length) / Math.min(files, paths.length))];
  const rows = byPath.get(path)!;
  for (let j = 0; j < Math.min(perFile, rows.length); j++) {
    const row = rows[Math.floor(((j + 0.37) * rows.length) / perFile) % rows.length];
    asked++;
    try {
      const answer: any = await ask({ file: join(datasetRoot(), path), question: row.question, type: row.type }, deps);
      if (answer.value !== null && answer.value !== undefined) answered++;
    } catch (e) {
      console.error(`${path}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}
const fresh = calls.filter((c) => !c.cached);
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
console.log(`${vision.id} on ${source}: ${asked} questions, ${answered} answered, ${calls.length} model calls (${fresh.length} fresh)`);
console.log(`per fresh call: ${mean(fresh.map((c) => c.seconds)).toFixed(1)} s, $${mean(fresh.map((c) => c.costUsd)).toFixed(4)} (min $${Math.min(...fresh.map((c) => c.costUsd)).toFixed(4)}, max $${Math.max(...fresh.map((c) => c.costUsd)).toFixed(4)})`);
console.log(`per question: ${(calls.length / Math.max(1, asked)).toFixed(2)} calls`);
