/**
 * Measures every count source (each detector, the vision model) on raster questions, to choose who votes on what.
 *
 *   npx tsx scripts/voters.ts count ../raster-test100.txt a.json     one row per question with each source's count
 *   npx tsx scripts/voters.ts report a.json [b.json]                 rules chosen on a.json, checked on b.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetRoot, loadEnv } from "../server/src/config.js";
import { questionsByPath } from "../server/src/dataset.js";
import { createDetector } from "../server/src/models/detector.js";
import { createVision } from "../server/src/models/vision.js";
import { countSources, rasterTarget } from "../server/src/solvers/raster.js";

interface Row {
  path: string;
  kind: string;
  expected: number;
  counts: Record<string, number>;
}

const [mode, ...files] = process.argv.slice(2);

async function count(sampleFile: string, out: string): Promise<void> {
  loadEnv();
  // Every detector reports on every target it knows, room types included.
  process.env.RASTER_DETECTOR_TARGETS = "all";
  const deps = { vision: createVision(), detector: createDetector(), imageUrl: "" };
  const sample = new Set(readFileSync(sampleFile, "utf8").split(/\s+/).filter(Boolean));
  const drawings = [...questionsByPath()].filter(([path]) => sample.has(path));
  const rows: Row[] = [];
  let next = 0;
  const worker = async () => {
    while (next < drawings.length) {
      const [path, questions] = drawings[next++];
      for (const row of questions) {
        const target = /^(How|What) /.test(row.question) ? rasterTarget(row.question) : null;
        if (!target) continue;
        const { sources } = await countSources(join(datasetRoot(), path), target, deps);
        const tallies = await Promise.all(sources.map(async (s) => [s.kind === "vision" ? "vision" : s.name, (await s.tally()).count] as const));
        rows.push({ path, kind: target.id, expected: Number(row.answer), counts: Object.fromEntries(tallies) });
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.CONCURRENCY ?? 4) }, worker));
  writeFileSync(out, JSON.stringify(rows));
  console.log(`${rows.length} questions on ${drawings.length} drawings -> ${out}`);
}

interface Rule {
  voters: string[];
  upper: boolean;
}

/** The answer a rule gives: the middle count of its voters, or of every source when none of them counted this drawing. */
function decide(rule: Rule, row: Row): number {
  const listed = rule.voters.filter((name) => name in row.counts);
  const counts = (listed.length > 0 ? listed : Object.keys(row.counts)).map((name) => row.counts[name]).sort((a, b) => a - b);
  return counts[rule.upper ? Math.floor(counts.length / 2) : Math.floor((counts.length - 1) / 2)];
}

const score = (rule: Rule, rows: Row[]) => rows.filter((row) => decide(rule, row) === row.expected).length;
const label = (rule: Rule) => `${rule.voters.join(" + ")}${rule.voters.length % 2 === 0 ? (rule.upper ? " (upper)" : " (lower)") : ""}`;

function report(chosenOn: Row[], checkedOn: Row[] | null): void {
  let totals = { chosen: 0, baseline: 0, checkedChosen: 0, checkedBaseline: 0, n: 0, m: 0 };
  for (const kind of [...new Set(chosenOn.map((r) => r.kind))].sort()) {
    const rows = chosenOn.filter((r) => r.kind === kind);
    const check = checkedOn?.filter((r) => r.kind === kind) ?? null;
    const names = [...new Set(rows.flatMap((r) => Object.keys(r.counts)))].sort();
    const rules: Rule[] = [];
    for (let mask = 1; mask < 1 << names.length; mask++) {
      const voters = names.filter((_, i) => mask & (1 << i));
      rules.push({ voters, upper: false });
      if (voters.length % 2 === 0) rules.push({ voters, upper: true });
    }
    // Fewer voters win a tie: a rule that needs less is cheaper to run.
    rules.sort((a, b) => score(b, rows) - score(a, rows) || a.voters.length - b.voters.length);
    const everyone: Rule = { voters: names, upper: false };
    console.log(`\n${kind} (${rows.length}${check ? `, check ${check.length}` : ""})`);
    for (const rule of [...rules.slice(0, 4), everyone]) {
      const tag = rule === rules[0] ? "best" : rule === everyone ? "all " : "    ";
      console.log(`  ${tag} ${String(score(rule, rows)).padStart(4)}${check ? `  check ${String(score(rule, check)).padStart(4)}` : ""}  ${label(rule)}`);
    }
    for (const name of names) {
      const single: Rule = { voters: [name], upper: false };
      console.log(`  one  ${String(score(single, rows)).padStart(4)}${check ? `  check ${String(score(single, check)).padStart(4)}` : ""}  ${name}`);
    }
    totals = {
      chosen: totals.chosen + score(rules[0], rows), baseline: totals.baseline + score(everyone, rows), n: totals.n + rows.length,
      checkedChosen: totals.checkedChosen + (check ? score(rules[0], check) : 0), checkedBaseline: totals.checkedBaseline + (check ? score(everyone, check) : 0),
      m: totals.m + (check?.length ?? 0),
    };
  }
  console.log(`\nchosen on: best rules ${totals.chosen}/${totals.n}, everyone votes ${totals.baseline}/${totals.n}`);
  if (checkedOn) console.log(`checked on: best rules ${totals.checkedChosen}/${totals.m}, everyone votes ${totals.checkedBaseline}/${totals.m}`);
}

const load = (file: string): Row[] => JSON.parse(readFileSync(file, "utf8"));
if (mode === "count" && files.length === 2) await count(files[0], files[1]);
else if (mode === "report" && files.length >= 1) report(load(files[0]), files[1] ? load(files[1]) : null);
else console.log("usage: voters.ts count <sample.txt> <out.json> | report <chosen-on.json> [checked-on.json]");
