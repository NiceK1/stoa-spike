/**
 * Picks the pipeline for a drawing: exact geometry when a vector twin exists, a model otherwise.
 * In the dataset, files with the same name and a different extension are the same drawing,
 * and `<model>_plan-<level>.pdf` was rendered from `<model>.ifc`.
 */
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { renderPlanSvg } from "./evidence.js";
import type { Detector } from "./models/detector.js";
import type { VisionModel } from "./models/vision.js";
import { inferType, parseTakeoff } from "./questions.js";
import { rasterize, upright } from "./rasterize.js";
import { toEnglish } from "./rewrite.js";
import { isLayeredPlan, loadPlan } from "./solvers/dxf.js";
import { solveRaster } from "./solvers/raster.js";
import type { Answer, AskInput } from "./types.js";

export interface Deps {
  vision: VisionModel;
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

export async function ask(input: AskInput, deps: Deps): Promise<Answer> {
  const qtype = input.type ?? inferType(input.question);
  const extension = extname(input.file).toLowerCase();

  const ifc = extension === ".ifc" ? input.file : ifcModelOf(input.file);
  if (ifc) {
    // Loaded on demand: the IFC engine is heavy and the other pipelines should not wait for it.
    const { solveIfc } = await import("./solvers/ifc.js");
    let answer = await solveIfc(ifc, input.question, qtype);
    if (!answer && qtype !== "text") {
      const english = await toEnglish(input.question, deps.vision);
      if (english) answer = await solveIfc(ifc, english, qtype);
    }
    if (answer && qtype !== "text") return answer;
    if (extension === ".ifc") {
      // A free-text question: the fixed rules give a fact sheet on the topic at best, so a language model
      // writes the answer to the actual question from the model's extracted facts.
      const { answerFromDigest } = await import("./solvers/ifc/digest.js");
      const related = typeof answer?.value === "string" ? answer.value : undefined;
      return { ...(await answerFromDigest(ifc, input.question, qtype, deps.vision, related)), evidence: answer?.evidence };
    }
    if (answer) return answer;
  }

  const dxf = extension === ".dxf" ? input.file : twin(input.file, ".dxf");
  if (dxf) {
    const plan = await loadPlan(dxf);
    const intent = isLayeredPlan(plan) ? parseTakeoff(input.question, qtype) : null;
    const result = intent ? plan.answer(intent) : null;
    if (result) {
      return {
        value: result.value, unit: qtype === "area" ? "m2" : "count", pipeline: "dxf-geometry", exact: true, method: result.method,
        evidence: {
          kind: "svg", caption: `Highlighted: ${result.method}`,
          svg: renderPlanSvg({ solid: plan.walls, outlines: plan.roomOutlines, highlights: result.highlights }, result.cutouts),
        },
      };
    }
  }

  if (extension === ".pdf" && existsSync(input.file)) {
    // Schedules and notes are answered from the sheet's text layer; drawings without enough text go to the image pipeline.
    const { solveDocument } = await import("./solvers/document.js");
    const answer = await solveDocument(input.file, input.question, qtype, { text: deps.vision, fileUrl: deps.fileUrl });
    if (answer) return answer;
  }

  let image: string | null = null;
  if (IMAGE.has(extension) && existsSync(input.file)) image = input.file;
  else if (RENDERABLE.has(extension) && existsSync(input.file)) image = await rasterize(input.file);
  else image = twin(input.file, ".png") ?? twin(input.file, ".jpg") ?? (twin(input.file, ".pdf") ? await rasterize(twin(input.file, ".pdf")!) : null);
  if (image) {
    image = await upright(image);
    return solveRaster(image, input.question, qtype, { vision: deps.vision, detector: deps.detector, imageUrl: deps.fileUrl(image), useDetector: deps.useDetector });
  }

  return {
    value: null, pipeline: "none", exact: false,
    method: ifc || dxf ? "the question was not understood for this vector drawing" : `no pipeline for ${extension || "this"} files`,
  };
}
