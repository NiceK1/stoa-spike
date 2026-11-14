// Checks that every raster question maps to a counting target, and that the English and Finnish questions of one
// drawing that map to the same target also share their answer: STOA_DATASET=../dataset-full npx tsx scripts/raster-targets.ts
import { questionsByPath } from "../server/src/dataset.js";
import { rasterTarget } from "../server/src/solvers/raster.js";

const perTarget = new Map<string, number>();
const unmatched = new Map<string, number>();
let total = 0, conflicts = 0;
for (const [path, rows] of questionsByPath()) {
  if (!path.includes("/cubicasa5k/")) continue;
  const answers = new Map<string, number | string>();
  for (const row of rows) {
    total++;
    const target = rasterTarget(row.question);
    if (!target) {
      unmatched.set(row.question.slice(0, 90), (unmatched.get(row.question.slice(0, 90)) ?? 0) + 1);
      continue;
    }
    perTarget.set(target.id, (perTarget.get(target.id) ?? 0) + 1);
    if (answers.has(target.id) && answers.get(target.id) !== row.answer) conflicts++;
    answers.set(target.id, row.answer);
  }
}
console.log(`${total} raster questions; per target:`, Object.fromEntries([...perTarget].sort((a, b) => b[1] - a[1])));
console.log(`unmatched: ${[...unmatched.values()].reduce((a, b) => a + b, 0)}`, [...unmatched].slice(0, 8));
console.log(`drawings where two questions on one target disagree: ${conflicts}`);
