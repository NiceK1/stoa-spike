// Lists IFC questions the rule-based parser does not understand: STOA_DATASET=../dataset-full npx tsx scripts/unparsed-ifc.ts
import { questionsByPath } from "../server/src/dataset.js";
import { parseIfcQuestion } from "../server/src/solvers/ifc/question.js";
import type { QuestionType } from "../server/src/types.js";

const seen = new Map<string, { n: number; example: string }>();
let total = 0, unparsed = 0;
for (const [path, rows] of questionsByPath()) {
  if (!path.includes("/ifc_models/")) continue;
  for (const row of rows) {
    total++;
    if (row.type === "text" || parseIfcQuestion(row.question, row.type as QuestionType)) continue;
    unparsed++;
    const template = row.question.replace(/['‘’“”«»„"][^'‘’“”«»„"]{1,80}['‘’“”«»„"]/g, "<NAME>").replace(/\d+/g, "<N>");
    const entry = seen.get(template) ?? { n: 0, example: row.question };
    entry.n++;
    seen.set(template, entry);
  }
}
console.log(`${unparsed} of ${total} ifc_models questions unparsed, ${seen.size} templates`);
for (const [, { n, example }] of [...seen].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) console.log(`${String(n).padStart(4)}  ${example.slice(0, 150)}`);
