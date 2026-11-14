/**
 * Scores the app on reworded dataset questions: a language model rewrites each sampled question far from its template
 * (styles in paraphrase.ts), the app answers the rewrite without being told the answer type, and the original
 * expected answer decides, with the dataset's rules.
 *
 *   npm run eval:paraphrase -- --source swiss_dwellings --drawings 24 --per-file 5
 *   npm run eval:paraphrase -- --source cubicasa5k --sample ../raster-dev.txt --per-file 3
 *   npm run eval:paraphrase -- --source ifc_models --drawings 20 --per-file 2
 *
 * --styles picks the style set (default dev), --dump <file> keeps every question with how it was understood,
 * --original asks the same sample in the dataset's wording, as the reference.
 * Rewrites and answers are cached like every other model call, so a repeated run costs nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetRoot, loadEnv } from "./config.js";
import { isAvailable, questionsByPath } from "./dataset.js";
import { createDetector } from "./models/detector.js";
import { createPlanner, createVision, type VisionModel } from "./models/vision.js";
import { STYLE_SETS, paraphrase } from "./paraphrase.js";
import { ask, type Deps } from "./router.js";
import { isCorrect } from "./scoring.js";
import type { QuestionRow } from "./types.js";

loadEnv();
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

const source = option("source", "swiss_dwellings")!;
const drawings = Number(option("drawings", "24"));
const perFile = Number(option("per-file", "5"));
const concurrency = Number(option("concurrency", "4"));
const styleSet = option("styles", "dev")!;
const styles = STYLE_SETS[styleSet];
if (!styles) throw new Error(`unknown style set '${styleSet}'; known: ${Object.keys(STYLE_SETS).join(", ")}`);
const sampleFile = option("sample");
const only = sampleFile && existsSync(sampleFile) ? new Set(readFileSync(sampleFile, "utf8").split(/\s+/).filter(Boolean)) : null;

/** Calls that reached the model, as opposed to the disk cache. */
const calls = { made: 0, cached: 0 };
function counted(model: VisionModel): VisionModel {
  return {
    id: model.id,
    ask: async (request) => {
      const result = await model.ask(request);
      if (result.cached) calls.cached++;
      else calls.made++;
      return result;
    },
  };
}

/** The question with its names and numbers blanked, which identifies the template it was generated from. */
function template(question: string): string {
  return question
    .replace(/'[^']*'|«[^»]*»/g, "_")
    .replace(/\(_\)/g, "")
    .replace(/\b[A-Z]?\d+(?:\.\d+)?\b/g, "N")
    .replace(/\bapartment [A-Z]\b/g, "apartment X");
}

/** Evenly spaced drawings, and on each a few questions, rotating through the templates so that every kind is covered. */
function sample(): QuestionRow[] {
  const paths = [...questionsByPath().keys()]
    .filter((path) => path.split("/")[1] === source && isAvailable(path) && (!only || only.has(path)))
    .sort();
  const count = Math.min(drawings, paths.length);
  const chosen = Array.from({ length: count }, (_, i) => paths[Math.floor((i * paths.length) / count)]);
  const rows: QuestionRow[] = [];
  chosen.forEach((path, d) => {
    const groups = new Map<string, QuestionRow[]>();
    for (const row of questionsByPath().get(path)!) {
      if (!/^(How|What) /.test(row.question) || isCorrect(row.type, row.answer, row.answer) === null) continue;
      const key = template(row.question);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }
    const keys = [...groups.keys()].sort();
    for (let j = 0; j < Math.min(perFile, keys.length); j++) {
      const group = groups.get(keys[(d * perFile + j) % keys.length])!;
      rows.push(group[d % group.length]);
    }
  });
  return rows;
}

const vision = counted(createVision());
const planner = counted(createPlanner());
const deps: Deps = { vision, planner, detector: createDetector(), fileUrl: () => "" };

const rows = sample();
// --original asks the sampled questions in the dataset's wording: the score free wording is measured against.
const rewritten = args.includes("--original") ? rows.map((row) => ({ row, style: "original", question: row.question })) : await paraphrase(rows, styles, vision);
const rewriteCalls = calls.made;

const results: Record<string, unknown>[] = [];
const byStyle = new Map<string, { n: number; correct: number }>();
const byPipeline = new Map<string, { n: number; correct: number }>();
let next = 0, correctTotal = 0, answered = 0, viaPlanner = 0;
const started = Date.now();

async function worker(): Promise<void> {
  while (next < rewritten.length) {
    const { row, style, question } = rewritten[next++];
    let value: number | string | null = null, pipeline = "error", method = "";
    try {
      const answer = await ask({ file: join(datasetRoot(), row.path), question }, deps);
      ({ value, pipeline, method } = answer);
    } catch (error) {
      method = error instanceof Error ? error.message : String(error);
    }
    const correct = isCorrect(row.type, row.answer, value) === true;
    if (value !== null) answered++;
    if (correct) correctTotal++;
    if (method.includes("understood as")) viaPlanner++;
    for (const [table, key] of [[byStyle, style], [byPipeline, pipeline]] as const) {
      const s = table.get(key) ?? { n: 0, correct: 0 };
      table.set(key, { n: s.n + 1, correct: s.correct + (correct ? 1 : 0) });
    }
    results.push({ path: row.path, style, original: row.question, question, type: row.type, expected: row.answer, value, correct, pipeline, method });
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
if (option("dump")) writeFileSync(option("dump")!, JSON.stringify(results, null, 1));

const percent = (correct: number, n: number) => `${correct}/${n} (${n ? ((correct / n) * 100).toFixed(1) : "0.0"}%)`;
console.log(`${source}, style set '${styleSet}': ${percent(correctTotal, rewritten.length)} correct; ${answered} answered; ${viaPlanner} understood by the planner`);
console.log(`${new Set(rewritten.map((r) => r.row.path)).size} drawings, ${rows.length} questions sampled, ${rewritten.length} reworded`);
for (const [name, table] of [["style", byStyle], ["pipeline", byPipeline]] as const) {
  console.log(`\nby ${name}`);
  for (const [key, s] of [...table].sort()) console.log(`  ${key.padEnd(16)} ${percent(s.correct, s.n)}`);
}
console.log(`\nmodel calls made: ${rewriteCalls} to reword, ${calls.made - rewriteCalls} to answer; ${calls.cached} served from the cache; ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`vision ${vision.id}; planner ${planner.id}`);
const wrong = results.filter((r) => !r.correct).slice(0, Number(option("show", "12")));
if (wrong.length) console.log("\nwrong:");
for (const r of wrong) console.log(`  [${r.style}] ${r.question} | expected ${r.expected}, got ${String(r.value).slice(0, 60)} | ${r.pipeline}: ${String(r.method).slice(0, 90)}`);
