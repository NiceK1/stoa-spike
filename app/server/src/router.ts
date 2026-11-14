/**
 * Picks the pipeline for a drawing: exact geometry when a vector twin exists, a model otherwise.
 * In the dataset, files with the same name and a different extension are the same drawing,
 * and `<model>_plan-<level>.pdf` was rendered from `<model>.ifc`.
 */
import { existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { renderPlanSvg } from "./evidence.js";
import type { Detector } from "./models/detector.js";
import type { VisionModel } from "./models/vision.js";
import { markedSentence, planTakeoff } from "./planner.js";
import { inferType, isLocate, parseTakeoff } from "./questions.js";
import { rasterize, upright } from "./rasterize.js";
import { toEnglish } from "./rewrite.js";
import { isLayeredPlan, loadPlan, type Plan, type TakeoffResult } from "./solvers/dxf.js";
import { solveRaster } from "./solvers/raster.js";
import sharp from "sharp";
import type { Answer, AskInput, Evidence } from "./types.js";

export interface Deps {
  vision: VisionModel;
  /** Understands questions the fixed parsers do not: the vision model when left out, nobody when null. */
  planner?: VisionModel | null;
  detector: Detector | null;
  /** URL the browser can load a file from, for image evidence. */
  fileUrl(path: string): string;
  useDetector?: boolean;
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const RENDERABLE = new Set([".pdf", ".svg"]);

function twin(file: string, extension: string): string | null {
  const candidate = file.slice(0, file.length - extname(file).length) + extension;
  return existsSync(candidate) ? candidate : null;
}

function ifcModelOf(file: string): string | null {
  const stem = file.slice(0, file.length - extname(file).length).split("_plan-")[0];
  return existsSync(`${stem}.ifc`) ? `${stem}.ifc` : null;
}

function planEvidence(plan: Plan, result: Pick<TakeoffResult, "highlights" | "cutouts"> & { labels?: string[] }, caption: string): Answer["evidence"] {
  const drawing = { solid: plan.walls, outlines: plan.roomOutlines, highlights: result.highlights, labels: result.labels };
  return { kind: "svg", caption, svg: renderPlanSvg(drawing, result.cutouts) };
}

/**
 * The drawing as it looks before any question, so it can be shown as soon as it is chosen.
 * Null when there is no cheap flat view (an IFC model without a rendered sheet).
 */
export async function preview(file: string, deps: Pick<Deps, "fileUrl">): Promise<Evidence | null> {
  const extension = extname(file).toLowerCase();
  const dxf = extension === ".dxf" ? file : twin(file, ".dxf");
  if (dxf) {
    const plan = await loadPlan(dxf);
    if (isLayeredPlan(plan)) {
      return { kind: "svg", caption: "The drawing", svg: renderPlanSvg({ solid: plan.walls, outlines: plan.roomOutlines, highlights: [] }) };
    }
  }
  let image: string | null = null;
  if (IMAGE.has(extension) && existsSync(file)) image = file;
  else if (RENDERABLE.has(extension) && existsSync(file)) image = await rasterize(file);
  else {
    const pdf = twin(file, ".pdf");
    image = twin(file, ".png") ?? twin(file, ".jpg") ?? (pdf ? await rasterize(pdf) : null);
  }
  if (!image) {
    // No sheet to show: draw the plan from the building model it belongs to, loaded on demand like in ask().
    const ifc = extension === ".ifc" ? file : ifcModelOf(file);
    if (!ifc) return null;
    const { previewIfc } = await import("./solvers/ifc.js");
    return previewIfc(ifc, basename(file, extname(file)).split("_plan-")[1]);
  }
  image = await upright(image);
  const { width = 1, height = 1 } = await sharp(image).metadata();
  return { kind: "image", caption: "The drawing", imageUrl: deps.fileUrl(image), width, height, marks: [] };
}

export async function ask(input: AskInput, deps: Deps): Promise<Answer> {
  const asked = input.type ?? inferType(input.question);
  // A request to be shown something is answered like the count of that thing, which comes with the marks.
  const locate = input.type === undefined && isLocate(input.question);
  const qtype = locate ? "count" : asked;
  const planner = deps.planner === undefined ? deps.vision : deps.planner;
  const extension = extname(input.file).toLowerCase();

  const ifc = extension === ".ifc" ? input.file : ifcModelOf(input.file);
  if (ifc) {
    // Loaded on demand: the IFC engine is heavy and the other pipelines should not wait for it.
    const { solveIfc } = await import("./solvers/ifc.js");
    let answer = await solveIfc(ifc, input.question, qtype);
    let numeric = qtype !== "text";
    // A typed question that reads as free text may still be a take-off in loose wording, so the rewrite gets a try.
    if (numeric ? !answer : input.type === undefined && planner) {
      const english = await toEnglish(input.question, deps.vision);
      const type = numeric ? qtype : english ? inferType(english) : "text";
      const rewritten = english && type !== "text" ? await solveIfc(ifc, english, type) : null;
      if (rewritten) {
        answer = { ...rewritten, method: `understood as "${english}" by ${deps.vision.id}; ${rewritten.method}` };
        numeric = true;
      }
    }
    if (answer && numeric) {
      const shown = locate && typeof answer.value === "number" && answer.evidence !== undefined;
      return shown ? { ...answer, note: answer.note ?? `The ${answer.value} counted items are highlighted on the drawing.` } : answer;
    }
    if (extension === ".ifc") {
      // A free-text question: the fixed rules give a fact sheet on the topic at best, so a language model
      // writes the answer to the actual question from the model's extracted facts.
      const { answerFromDigest } = await import("./solvers/ifc/digest.js");
      const related = typeof answer?.value === "string" ? answer.value : undefined;
      return { ...(await answerFromDigest(ifc, input.question, asked, deps.vision, related)), evidence: answer?.evidence };
    }
    if (answer) return answer;
  }

  const dxf = extension === ".dxf" ? input.file : twin(input.file, ".dxf");
  if (dxf) {
    const plan = await loadPlan(dxf);
    if (isLayeredPlan(plan)) {
      const intent = parseTakeoff(input.question, qtype);
      const result = intent ? plan.answer(intent) : null;
      if (result) {
        return {
          value: result.value, unit: qtype === "area" ? "m2" : "count", pipeline: "dxf-geometry", exact: true, method: result.method,
          note: locate && result.subject ? markedSentence(result.value, result.subject) : undefined,
          evidence: planEvidence(plan, result, `Highlighted: ${result.method}`),
        };
      }
      // The templates did not fit: a language model picks the call, and the geometry still gives the numbers.
      const planned = planner ? await planTakeoff(input.question, plan, planner) : null;
      if (planned) {
        const marked = (locate || planned.locate) && typeof planned.value === "number" && planned.unit === "count" && planned.subject;
        return {
          value: planned.value, unit: planned.unit, pipeline: planned.exact ? "dxf-geometry" : "dxf-facts", exact: planned.exact,
          method: `understood as "${planned.understood}" by ${planner!.id}; ${planned.method}`,
          note: marked ? markedSentence(planned.value as number, marked) : undefined,
          evidence: planEvidence(plan, planned, `Highlighted: ${planned.method}`),
        };
      }
    }
  }

  if (extension === ".pdf" && existsSync(input.file)) {
    // Schedules and notes are answered from the sheet's text layer; drawings without enough text go to the image pipeline.
    const { solveDocument } = await import("./solvers/document.js");
    const answer = await solveDocument(input.file, input.question, asked, { text: deps.vision, fileUrl: deps.fileUrl });
    if (answer) return answer;
  }

  let image: string | null = null;
  if (IMAGE.has(extension) && existsSync(input.file)) image = input.file;
  else if (RENDERABLE.has(extension) && existsSync(input.file)) image = await rasterize(input.file);
  else image = twin(input.file, ".png") ?? twin(input.file, ".jpg") ?? (twin(input.file, ".pdf") ? await rasterize(twin(input.file, ".pdf")!) : null);
  if (image) {
    image = await upright(image);
    // A caller who states that the question is not a count knows better than the planner.
    const understands = input.type === undefined || input.type === "count" ? planner : null;
    const raster = { vision: deps.vision, detector: deps.detector, imageUrl: deps.fileUrl(image), useDetector: deps.useDetector, planner: understands };
    return solveRaster(image, input.question, qtype, raster, locate);
  }

  return {
    value: null, pipeline: "none", exact: false,
    method: ifc || dxf ? "the question was not understood for this vector drawing" : `no pipeline for ${extension || "this"} files`,
  };
}
