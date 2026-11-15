// Seconds per answer for each pipeline with the keyword parsers reading the question (no model call):
// the first question on a drawing, which loads and parses it, and the later ones.
//   STOA_DATASET=../dataset-full npx tsx scripts/measure-latency.ts <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetRoot, loadEnv, REPO_ROOT } from "../server/src/config.js";
import { createDetector } from "../server/src/models/detector.js";
import { createVision } from "../server/src/models/vision.js";
import { ask } from "../server/src/router.js";

loadEnv();
process.env.VISION_PROVIDER = "none";
const deps = { vision: createVision(), planner: null, interpreter: "templates", detector: createDetector(), fileUrl: () => "" } as any;

interface Row { path: string; question: string; type: string }
const byPath = new Map<string, Row[]>();
for (const line of readFileSync(join(datasetRoot(), "questions.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line) as Row;
  if (!byPath.has(row.path)) byPath.set(row.path, []);
  byPath.get(row.path)!.push(row);
}
const spread = <T,>(items: T[], n: number) => Array.from({ length: Math.min(n, items.length) }, (_, i) => items[Math.floor((i * items.length) / Math.min(n, items.length))]);
const of = (source: string, keep: (path: string) => boolean = () => true) => [...byPath.keys()].filter((p) => p.split("/")[1] === source && keep(p));
const sampleA = readFileSync(join(REPO_ROOT, "raster-test100.txt"), "utf8").split(/\r?\n/).filter(Boolean);

const plans: { name: string; paths: string[]; perDrawing: number; cold?: boolean }[] = [
  { name: "Swiss apartment floors (DXF)", paths: spread(of("swiss_dwellings"), 30), perDrawing: 4 },
  { name: "IFC models (numeric)", paths: spread(of("ifc_models", (p) => p.endsWith(".ifc")), 12), perDrawing: 4 },
  { name: "Raster floor plans (detectors)", paths: sampleA.slice(60, 80), perDrawing: 4, cold: true },
];

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, mean: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(3), median: +at(0.5).toFixed(3), p90: +at(0.9).toFixed(3), max: +sorted.at(-1)!.toFixed(3) };
};

const report: Record<string, unknown> = {};
for (const plan of plans) {
  const first: number[] = [];
  const later: number[] = [];
  let answered = 0;
  let asked = 0;
  for (const path of plan.paths) {
    const rows = (byPath.get(path) ?? []).filter((row) => /^(How|What) /.test(row.question) || !path.includes("cubicasa5k"));
    const taken = spread(rows, plan.perDrawing);
    for (const [i, row] of taken.entries()) {
      if (plan.cold) process.env.DETECTOR_CACHE = i === 0 ? "off" : "";
      const started = performance.now();
      try {
        const answer: any = await ask({ file: join(datasetRoot(), path), question: row.question, type: row.type as any }, deps);
        if (answer.value !== null && answer.value !== undefined) answered++;
      } catch (e) {
        console.error(`${path}: ${(e as Error).message.slice(0, 200)}`);
      }
      asked++;
      (i === 0 ? first : later).push((performance.now() - started) / 1000);
    }
  }
  report[plan.name] = { drawings: plan.paths.length, asked, answered, first: stats(first), later: stats(later) };
  console.log(plan.name, JSON.stringify(report[plan.name]));
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
