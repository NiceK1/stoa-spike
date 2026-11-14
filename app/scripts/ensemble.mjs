// Compares answer sources per question kind and tries simple combinations, from `eval --dump` files.
//   node scripts/ensemble.mjs vision.json detectorA.json detectorB.json
import { readFileSync } from "node:fs";

const [vision, detA, detB] = process.argv.slice(2).map((f) => new Map(JSON.parse(readFileSync(f, "utf8")).map((r) => [`${r.path}|${r.question}`, r])));
const kinds = new Map();
for (const [key, v] of vision) {
  const a = detA.get(key), b = detB.get(key);
  if (!a || !b) continue;
  if (!kinds.has(v.kind)) kinds.set(v.kind, { n: 0, vision: 0, detA: 0, detB: 0, median3: 0, agreeAB: 0, agreeABright: 0, oracle: 0 });
  const k = kinds.get(v.kind);
  const truth = Number(v.expected), values = [v.value, a.value, b.value].map(Number);
  const median = [...values].sort((x, y) => x - y)[1];
  k.n++;
  k.vision += values[0] === truth;
  k.detA += values[1] === truth;
  k.detB += values[2] === truth;
  k.median3 += median === truth;
  k.agreeAB += values[1] === values[2];
  k.agreeABright += values[1] === values[2] && values[1] === truth;
  k.oracle += values.includes(truth);
}
console.log("kind            n   vision  detA  detB  median3  A=B (right)  any right");
for (const [kind, k] of [...kinds].sort()) {
  console.log(`${kind.padEnd(14)} ${String(k.n).padStart(3)}  ${String(k.vision).padStart(6)} ${String(k.detA).padStart(5)} ${String(k.detB).padStart(5)} ${String(k.median3).padStart(8)}  ${String(k.agreeAB).padStart(4)} (${k.agreeABright})  ${String(k.oracle).padStart(8)}`);
}
