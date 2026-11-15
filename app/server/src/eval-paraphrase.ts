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
 * --original asks the same sample in the dataset's wording, as the reference,
 * --interpreter templates has the keyword parsers read the questions instead of the interpreter model,
 * --mode blueline|best|custom answers with the line-up of that mode of the app (custom takes --engine-interpreter and
 * --reader); the rewording stays with the environment's vision model, which is not part of what is measured,
 * --other-languages samples the dataset's questions that are not in English (to be used with --original).
 * Rewrites and answers are cached like every other model call, so a repeated run costs nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetRoot, loadEnv } from "./config.js";
import { isAvailable, questionsByPath } from "./dataset.js";
import { createDetector } from "./models/detector.js";
import { createPlanner, createVision, type VisionModel } from "./models/vision.js";
import { lineupOfRun, lineupSentence } from "./modes.js";
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

/** Calls that reached the model, as opposed to the disk cache, and what the calls took, cached or not. */
interface Calls {
  made: number;
  cached: number;
  seconds: number;
  costUsd: number;
}
function counted(model: VisionModel, tally: Calls): VisionModel {
  return {
    id: model.id,
    ask: async (request) => {
      const result = await model.ask(request);
      if (result.cached) tally.cached++;
      else tally.made++;
      tally.seconds += result.seconds;
      tally.costUsd += result.costUsd;
      return result;
    },
  };
}
const calls: Calls = { made: 0, cached: 0, seconds: 0, costUsd: 0 };
const interpretations: Calls = { made: 0, cached: 0, seconds: 0, costUsd: 0 };

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
      if (/^(How|What) /.test(row.question) === args.includes("--other-languages") || isCorrect(row.type, row.answer, row.answer) === null) continue;
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

const detector = createDetector();
const lineup = lineupOfRun(option, detector);
const rewriter = counted(createVision(), calls);
const vision = lineup ? counted(lineup.deps.vision, calls) : rewriter;
function fail(message: string): never {
  throw new Error(message);
}

const interpreter = option("interpreter", process.env.INTERPRETER === "templates" ? "templates" : "model");
if (interpreter !== "templates" && interpreter !== "model") fail(`--interpreter is 'templates' or 'model', not '${interpreter}'`);
const interpreting = lineup ? lineup.deps.planner : createPlanner();
const planner = interpreter === "templates" ? null : counted(interpreting ?? fail("eval-paraphrase measures the interpreter, and this line-up has none"), interpretations);
const deps: Deps = { ...lineup?.deps, vision, planner, interpreter, detector, fileUrl: () => "" };

// --limit N keeps the first N sampled questions: a short run whose calls a full run then finds in the cache.
const rows = sample().slice(0, Number(option("limit", "0")) || undefined);
// --original asks the sampled questions in the dataset's wording: the score free wording is measured against.
const rewritten = args.includes("--original") ? rows.map((row) => ({ row, style: "original", question: row.question })) : await paraphrase(rows, styles, rewriter);
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
console.log(`${source}, style set '${styleSet}': ${percent(correctTotal, rewritten.length)} correct; ${answered} answered; ${viaPlanner} understood by the interpreter`);
console.log(`${new Set(rewritten.map((r) => r.row.path)).size} drawings, ${rows.length} questions sampled, ${rewritten.length} reworded`);
for (const [name, table] of [["style", byStyle], ["pipeline", byPipeline]] as const) {
  console.log(`\nby ${name}`);
  for (const [key, s] of [...table].sort()) console.log(`  ${key.padEnd(16)} ${percent(s.correct, s.n)}`);
}
console.log(`\nmodel calls made: ${rewriteCalls} to reword, ${calls.made - rewriteCalls} to answer; ${calls.cached} served from the cache; ${((Date.now() - started) / 1000).toFixed(0)}s`);
const interpreted = interpretations.made + interpretations.cached;
if (interpreted > 0) {
  console.log(`interpretation calls: ${interpretations.made} made, ${interpretations.cached} served from the cache; ${(interpretations.seconds / interpreted).toFixed(1)} s and $${(interpretations.costUsd / interpreted).toFixed(4)} per call on average`);
}
console.log(`vision ${vision.id}; questions read by ${planner ? `the interpreter ${planner.id}` : "the keyword parsers (bulk mode)"}`);
if (lineup) console.log(`mode ${lineupSentence(lineup)}`);
const wrong = results.filter((r) => !r.correct).slice(0, Number(option("show", "12")));
if (wrong.length) console.log("\nwrong:");
for (const r of wrong) console.log(`  [${r.style}] ${r.question} | expected ${r.expected}, got ${String(r.value).slice(0, 60)} | ${r.pipeline}: ${String(r.method).slice(0, 90)}`);
