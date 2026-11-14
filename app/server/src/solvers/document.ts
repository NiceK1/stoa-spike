/**
 * Drawing sheets with a text layer (schedules, notes, title blocks): the text is extracted with its position,
 * a language model answers from the text rows and names the rows it used, and those rows are boxed on the page.
 */
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { VisionModel } from "../models/vision.js";
import { rasterize } from "../rasterize.js";
import type { Answer, Mark, QuestionType } from "../types.js";

export interface Row {
  id: number;
  text: string;
  /** Bounding box in PDF points, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell { text: string; x: number; y: number; w: number; h: number }

/** Text of the first page as rows: cells on one baseline, left to right. */
export async function extractRows(pdfPath: string): Promise<{ rows: Row[]; pageWidth: number; pageHeight: number; pages: number }> {
  const mupdf = await import("mupdf");
  const document = mupdf.Document.openDocument(await readFile(pdfPath), "application/pdf");
  const page = document.loadPage(0);
  const [x0, y0, x1, y1] = page.getBounds();
  const structured = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());

  const cells: Cell[] = [];
  for (const block of structured.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const text = String(line.text ?? "").replace(/\s+/g, " ").trim();
      if (text) cells.push({ text, x: line.bbox.x - x0, y: line.bbox.y - y0, w: line.bbox.w, h: line.bbox.h });
    }
  }
  cells.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);

  const rows: Row[] = [];
  let current: Cell[] = [];
  const maxGap = (x1 - x0) * 0.05;
  const flush = () => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    // The box covers the first run of cells only: text far to the right on the same baseline
    // (a title block, another table) stays in the row's text but is not part of the highlight.
    let last = 0;
    while (last + 1 < current.length && current[last + 1].x - (current[last].x + current[last].w) <= maxGap) last++;
    const run = current.slice(0, last + 1);
    const left = run[0].x, top = Math.min(...run.map((c) => c.y));
    rows.push({
      id: rows.length + 1, text: current.map((c) => c.text).join(" | "), x: left, y: top,
      w: Math.max(...run.map((c) => c.x + c.w)) - left, h: Math.max(...run.map((c) => c.y + c.h)) - top,
    });
    current = [];
  };
  for (const cell of cells) {
    const middle = cell.y + cell.h / 2;
    const reference = current[0];
    // A cell joins the row when its middle falls inside the row's first cell.
    if (reference && (middle < reference.y || middle > reference.y + reference.h)) flush();
    current.push(cell);
  }
  flush();
  return { rows, pageWidth: x1 - x0, pageHeight: y1 - y0, pages: document.countPages() };
}

const SYSTEM =
  "You answer questions about one sheet of a construction drawing set, using the text extracted from the sheet. " +
  "Each line of the extract is one row of text on the sheet, written as `id<TAB>text`, with table cells separated by ` | `. " +
  "Schedules are tables: find the header row to learn the columns, then read the rows. " +
  "When the question asks how many items there are, add up a quantity column if the schedule has one, otherwise count the matching rows. " +
  "Return the answer, and in `rows` the ids of every row the answer is based on (each counted or summed row), so a person can check them on the sheet. " +
  "If the text does not contain the answer, set value to null and say what is missing.";

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    value: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
    rows: { type: "array", items: { type: "integer" } },
    explanation: { type: "string" },
  },
  required: ["answer", "value", "unit", "rows", "explanation"],
  additionalProperties: false,
};

/** Fewer text rows than this means the sheet is mostly graphics and the image pipeline should take it. */
export const MIN_ROWS = 12;

export async function solveDocument(
  pdfPath: string, question: string, qtype: QuestionType, deps: { text: VisionModel; fileUrl(path: string): string },
): Promise<Answer | null> {
  const { rows, pageWidth, pageHeight } = await extractRows(pdfPath);
  if (rows.length < MIN_ROWS) return null;

  const extract = rows.map((row) => `${row.id}\t${row.text}`).join("\n");
  const { output } = await deps.text.ask({ system: SYSTEM, schema: SCHEMA, prompt: `Question: ${question}\n\nSheet text:\n${extract}` });

  // A quantity the text cannot give has to be read from the drawing itself.
  if (qtype !== "text" && typeof output.value !== "number") return null;

  const image = await rasterize(pdfPath);
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const sx = width / pageWidth, sy = height / pageHeight;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const marks: Mark[] = (output.rows as number[])
    .map((id) => byId.get(id))
    .filter((row): row is Row => row !== undefined)
    .map((row, i) => ({ n: i + 1, x: row.x * sx, y: row.y * sy, w: row.w * sx, h: row.h * sy, label: row.text.slice(0, 120) }));

  const numeric = qtype !== "text" && typeof output.value === "number";
  return {
    value: numeric ? output.value : output.answer, unit: output.unit ?? undefined, pipeline: "sheet-text", exact: false, kind: `sheet_${qtype}`,
    method: `read from the sheet's text by ${deps.text.id}, ${marks.length} rows used`, note: output.explanation,
    evidence: { kind: "image", imageUrl: deps.fileUrl(image), width, height, marks, caption: "Each box is a row of the sheet the answer is based on" },
  };
}
