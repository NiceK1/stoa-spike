import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { datasetRoot } from "./config.js";
import type { QuestionRow } from "./types.js";

let cache: Map<string, QuestionRow[]> | null = null;

/** Questions from questions.jsonl, grouped by drawing path. */
export function questionsByPath(): Map<string, QuestionRow[]> {
  if (cache) return cache;
  cache = new Map();
  const file = join(datasetRoot(), "questions.jsonl");
  if (!existsSync(file)) return cache;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as QuestionRow;
    if (!cache.has(row.path)) cache.set(row.path, []);
    cache.get(row.path)!.push(row);
  }
  return cache;
}

const TWINS = [".dxf", ".png", ".jpg", ".pdf", ".ifc"];

/** True when the drawing, a same-name twin, or the IFC model it was rendered from is on disk. */
export function isAvailable(path: string): boolean {
  const absolute = join(datasetRoot(), path);
  if (existsSync(absolute)) return true;
  const stem = absolute.slice(0, absolute.length - extname(absolute).length);
  return TWINS.some((ext) => existsSync(stem + ext)) || existsSync(`${stem.split("_plan-")[0]}.ifc`);
}
