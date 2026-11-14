/**
 * Scores the pipelines against questions.jsonl with the dataset's rules.
 *
 *   npm run eval -- --source swiss_dwellings
 *   npm run eval -- --source cubicasa5k --no-detector
 *   npm run eval -- --source ifc_bench --per-file 2 --judge
 *
 * Raster drawings are limited to the list in raster-sample.txt and to English questions unless --all-languages is set,
 * because every raster answer costs a model call (answers are cached).
 * --judge has a language model grade free-text answers against the reference; --per-file N takes N evenly spaced questions of each file,
 * and --shift 0.5 moves that selection half a step, which gives a second sample that shares no question with the first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, datasetRoot, loadEnv } from "./config.js";
import { isAvailable, questionsByPath } from "./dataset.js";
import { judge } from "./judge.js";
import { createDetector } from "./models/detector.js";
import { createVision } from "./models/vision.js";
import { parseTakeoff } from "./questions.js";
import { ask, type Deps } from "./router.js";
import { isCorrect } from "./scoring.js";
import { rasterTarget } from "./solvers/raster.js";
import type { QuestionRow, QuestionType } from "./types.js";

loadEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback?: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

const source = option("source", "all")!;
const concurrency = Number(option("concurrency", "3"));
const limit = Number(option("limit", "0"));
const perFile = Number(option("per-file", "0"));
const shift = Number(option("shift", "0"));
const sampleFile = option("sample", join(REPO_ROOT, "raster-sample.txt"))!;
const rasterSample = new Set(existsSync(sampleFile) ? readFileSync(sampleFile, "utf8").split(/\s+/).filter(Boolean) : []);

const deps: Deps = { vision: createVision(), detector: createDetector(), fileUrl: () => "", useDetector: !flag("no-detector") };

function kindOf(row: QuestionRow, sourceName: string): string {
  if (sourceName === "cubicasa5k") return rasterTarget(row.question)?.id ?? "other";
  if (sourceName === "swiss_dwellings") return parseTakeoff(row.question, row.type as QuestionType)?.kind ?? "unparsed";
  return row.type;
}

const perDrawing: { row: QuestionRow; source: string }[][] = [];
for (const [path, rows] of questionsByPath()) {
  const sourceName = path.split("/")[1];
  if (source !== "all" && source !== sourceName) continue;
  if (!isAvailable(path)) continue;
  if (sourceName === "cubicasa5k" && !rasterSample.has(path)) continue;
  const wanted = rows.filter((row) => sourceName !== "cubicasa5k" || flag("all-languages") || /^(How|What) /.test(row.question));
  const taken = perFile && wanted.length > perFile ? Array.from({ length: perFile }, (_, i) => wanted[Math.floor(((i + shift) * wanted.length) / perFile)]) : wanted;
  perDrawing.push(taken.map((row) => ({ row, source: sourceName })));
}
// One question of every drawing, then the next of each: questions of one drawing share a model call,
// so taking them in file order would leave the workers waiting on the same call.
const jobs: { row: QuestionRow; source: string }[] = [];
for (let i = 0; perDrawing.some((questions) => i < questions.length); i++) {
  for (const questions of perDrawing) if (i < questions.length) jobs.push(questions[i]);
}
if (limit) jobs.length = Math.min(jobs.length, limit);

const dumped: { path: string; question: string; kind: string; expected: number | string; value: number | string | null }[] = [];
const stats = new Map<string, { n: number; answered: number; correct: number; scorable: number; partly: number }>();
const failures = new Map<string, string[]>();
let next = 0;
const started = Date.now();

async function worker(): Promise<void> {
  while (next < jobs.length) {
    const { row, source: sourceName } = jobs[next++];
    let value: number | string | null = null;
    let kind = kindOf(row, sourceName);
    let failure: string | null = null;
    try {
      const answer = await ask({ file: join(datasetRoot(), row.path), question: row.question, type: row.type === "other" ? undefined : row.type }, deps);
      value = answer.value;
      kind = answer.kind ?? kind;
    } catch (error) {
      failure = `ERROR ${row.path}: ${error instanceof Error ? error.message : error}`;
    }
    dumped.push({ path: row.path, question: row.question, kind, expected: row.answer, value });
    const key = `${sourceName}\t${kind}`;
    if (!stats.has(key)) stats.set(key, { n: 0, answered: 0, correct: 0, scorable: 0, partly: 0 });
    const s = stats.get(key)!;
    s.n++;
    if (failure) {
      if (!failures.has(key)) failures.set(key, []);
      if (failures.get(key)!.length < 3) failures.get(key)!.push(failure);
      continue;
    }
    if (value === null) continue;
    s.answered++;
    let correct = isCorrect(row.type, row.answer, value);
    let reason = "";
    if (correct === null && flag("judge")) {
      const graded = await judge(row.question, String(row.answer), String(value), deps.vision);
      correct = graded.verdict === "correct";
      reason = ` | ${graded.verdict}: ${graded.reason.slice(0, 160)}`;
      if (graded.verdict === "partly") s.partly++;
    }
    if (correct === null) continue;
    s.scorable++;
    if (correct) s.correct++;
    else {
      if (!failures.has(key)) failures.set(key, []);
      if (failures.get(key)!.length < Number(option("show", "3"))) failures.get(key)!.push(`expected ${String(row.answer).slice(0, 120)}, got ${String(value).slice(0, 120)} | ${row.path} | ${row.question.slice(0, 80)}${reason}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
// --dump <file> keeps every answer, for comparing configurations offline.
if (option("dump")) writeFileSync(option("dump")!, JSON.stringify(dumped));

console.log(`${"source".padEnd(17)} ${"kind".padEnd(24)} ${"n".padStart(6)} ${"answered".padStart(9)} ${"correct".padStart(8)} ${"accuracy".padStart(9)}`);
const totals = new Map<string, { n: number; correct: number }>();
for (const [key, s] of [...stats].sort()) {
  const [sourceName, kind] = key.split("\t");
  console.log(`${sourceName.padEnd(17)} ${kind.padEnd(24)} ${String(s.n).padStart(6)} ${String(s.answered).padStart(9)} ${String(s.correct).padStart(8)} ${((s.correct / s.n) * 100).toFixed(1).padStart(8)}%`);
  const t = totals.get(sourceName) ?? { n: 0, correct: 0 };
  totals.set(sourceName, { n: t.n + s.n, correct: t.correct + s.correct });
}
console.log();
for (const [sourceName, t] of totals) console.log(`${sourceName.padEnd(17)} ${t.correct}/${t.n} correct (${((t.correct / t.n) * 100).toFixed(1)}%)`);
const partly = [...stats.values()].reduce((sum, s) => sum + s.partly, 0);
if (flag("judge")) console.log(`graded by ${deps.vision.id}; ${partly} more answers were partly right`);
console.log(`\n${jobs.length} questions in ${((Date.now() - started) / 1000).toFixed(0)}s; vision ${deps.vision.id}; detector ${deps.useDetector === false ? "off" : deps.detector?.id ?? "none"}`);
for (const [key, lines] of [...failures].sort()) {
  console.log(`\nwrong: ${key.replace("\t", " / ")}`);
  for (const line of lines) console.log(`  ${line}`);
}
