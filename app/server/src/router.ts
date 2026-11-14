/**
 * Picks the pipeline for a drawing: exact geometry when a vector twin exists, our detectors on an image, and an
 * external model only for what neither can do.
 * In the dataset, files with the same name and a different extension are the same drawing,
 * and `<model>_plan-<level>.pdf` was rendered from `<model>.ifc`.
 *
 * Every question is first read by the interpreter model (planner.ts), which returns one structured call that the
 * pipelines then compute. The keyword parsers read a question on their own only in bulk mode (INTERPRETER=templates),
 * without an interpreter model, or when its call fails; the method text and the source of every answer say who read the question.
 */
import { existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { renderPlanSvg } from "./evidence.js";
import type { Detector } from "./models/detector.js";
import type { VisionModel } from "./models/vision.js";
import { markedSentence, planIfc, planRaster, planTakeoff, type RasterReading } from "./planner.js";
import { countKindPattern, describeIntent, inferType, isLocate, isPlainRequest, parseTakeoff } from "./questions.js";
import { rasterize, upright } from "./rasterize.js";
import { toEnglish } from "./rewrite.js";
import { SCRIPTS, model as modelSource, tierOf } from "./source.js";
import { isLayeredPlan, loadPlan, takeoffSource, type Plan, type TakeoffResult } from "./solvers/dxf.js";
import { describeIfcIntent, elementWords, parseIfcQuestion } from "./solvers/ifc/question.js";
import { RASTER_KINDS, TARGETS, rasterTarget, readByKeywords, solveRaster } from "./solvers/raster.js";
import sharp from "sharp";
import type { Answer, AskInput, Evidence, QuestionType, Solved, Understanding } from "./types.js";

export interface Deps {
  vision: VisionModel;
  /** Reads every question into a structured call: the vision model when left out, nobody when null. */
  planner?: VisionModel | null;
  /**
   * "templates" has the keyword parsers read the questions alone, which costs nothing: for scoring the dataset's own
   * wording in bulk. Left out, INTERPRETER decides, and without it the interpreter model reads every question.
   */
  interpreter?: "model" | "templates";
  detector: Detector | null;
  /** URL the browser can load a file from, for image evidence. */
  fileUrl(path: string): string;
  useDetector?: boolean;
}

/** Who reads the question: the interpreter model, or the keyword parsers, with the reason the model is not asked. */
interface Reader {
  model: VisionModel | null;
  why: string;
}

function readerOf(deps: Deps): Reader {
  if ((deps.interpreter ?? process.env.INTERPRETER) === "templates") return { model: null, why: "bulk mode, INTERPRETER=templates" };
  const planner = deps.planner === undefined ? deps.vision : deps.planner;
  return planner && planner.id !== "none" ? { model: planner, why: "" } : { model: null, why: "no interpreter model is configured" };
}

/** The interpreter's call, or null when the keyword parsers have to read the question: no model, a failed call, an unusable answer. */
async function interpret<T>(reader: Reader, run: (model: VisionModel) => Promise<T>): Promise<T | null> {
  if (!reader.model) return null;
  try {
    return await run(reader.model);
  } catch (error) {
    reader.why = `the interpreter ${reader.model.id} gave no usable call: ${error instanceof Error ? error.message : String(error)}`.slice(0, 240);
    reader.model = null;
    return null;
  }
}

/** Who understood the question, as the start of the method sentence and as the first part of the answer's source. */
interface How {
  text: string;
  by: Understanding;
}

const byModel = (reading: string, model: VisionModel): How => ({
  text: `understood as "${reading}" by ${model.id}`,
  by: { by: "model", name: model.id, tier: tierOf(model.id), reading },
});
const byKeywords = (reader: Reader): How => ({
  text: `read by the keyword parser (${reader.why})`,
  by: { by: "keyword-parser", name: SCRIPTS.keywords, tier: "script", why: reader.why },
});
const joined = (...notes: (string | undefined | false)[]) => notes.filter(Boolean).join(" ") || undefined;

/** A pipeline's answer with who understood the question put in front of its method and into its source. */
const understood = (how: How, answer: Solved): Answer => ({ ...answer, method: `${how.text}; ${answer.method}`, source: { understoodBy: how.by, ...answer.source } });

/** An answer with no value: `needed` says why nothing was calculated and what it would have taken, `file` is the drawing that was looked at. */
function noAnswer(how: How, file: string, needed: string, rest: Partial<Answer> = {}): Answer {
  return { value: null, pipeline: "none", exact: false, method: how.text, source: { understoodBy: how.by, calculatedBy: [], needed, from: { file: basename(file), used: "nothing" } }, ...rest };
}

/** A question about a building model's facts, which a language model writes the answer to, when none is configured. */
const factsUnanswered = (how: How, ifc: string, evidence?: Evidence): Answer =>
  noAnswer(how, ifc, "an external language model is needed to write the answer from the model's facts; none is configured (VISION_PROVIDER=none)", {
    evidence,
    method: `${how.text}; not answered: only an external language model could write the answer from the model's facts, and none is configured`,
    note: "No answer: this question is about the building model's facts, not a count or a measure our code computes, so it needs an external language model, and the app is running with our local models only (VISION_PROVIDER=none).",
  });
const highlighted = (count: number) => `The ${count} counted item${count === 1 ? " is" : "s are"} highlighted on the drawing.`;

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

/** The keyword parser's reading of a question about a layered plan, in words, as the interpreter gets it; null when it has none. */
export function takeoffHint(question: string, plan: Plan, type?: QuestionType): string | null {
  const guess = parseTakeoff(question, type ?? inferType(question));
  if (guess) return describeIntent(guess);
  // Without a template reading, the keyword parser still spots the plan's room numbers in the question.
  const named = plan.vocabulary().numbers.filter((number) => new RegExp(String.raw`(?<![\w.])${number.replace(/\./g, "\\.")}(?![\w]|\.\d)`).test(question));
  return named.length > 0 ? `a question about room${named.length > 1 ? "s" : ""} ${named.join(", ")}` : null;
}

export function rasterHint(question: string): string | null {
  const target = rasterTarget(question);
  return target ? `count the ${target.plural} on the whole drawing` : null;
}

export function ifcHint(question: string, type?: QuestionType): string | null {
  const guess = parseIfcQuestion(question, type ?? inferType(question));
  return guess ? describeIfcIntent(guess) : null;
}

export async function ask(input: AskInput, deps: Deps): Promise<Answer> {
  const reader = readerOf(deps);
  const extension = extname(input.file).toLowerCase();
  // What a vector pipeline could not answer, said at the end when no later pipeline answers either.
  let unanswered: Answer | null = null;
  // A reading handed on to the image pipeline, so that one question costs one interpretation.
  let carried: RasterReading | null = null;

  const ifc = extension === ".ifc" ? input.file : ifcModelOf(input.file);
  if (ifc) {
    const outcome = (await askIfcByModel(ifc, input, deps, reader)) ?? (reader.model ? null : await askIfcByKeywords(ifc, input, deps, reader));
    if (outcome && (outcome.value !== null || extension === ".ifc" || outcome.pipeline !== "none")) return outcome;
    if (outcome) {
      unanswered = outcome;
      carried = { call: { operation: "read" }, locate: false, type: input.type ?? "text" };
    }
  }

  const dxf = extension === ".dxf" ? input.file : twin(input.file, ".dxf");
  // A DXF without the layers the CAD script reads is taken by no vector pipeline, so nothing reads the question for it.
  let unlayered = false;
  if (dxf) {
    const plan = await loadPlan(dxf);
    unlayered = !isLayeredPlan(plan);
    if (!unlayered) {
      const hint = takeoffHint(input.question, plan, input.type);
      const planned = await interpret(reader, (model) => planTakeoff(input.question, plan, model, hint));
      if (planned) {
        const how = byModel(planned.understood, reader.model!);
        const method = `${how.text}; ${planned.method}`;
        const shown =
          !planned.locate ? undefined
          : typeof planned.value === "number" && planned.unit === "count" && planned.subject ? markedSentence(planned.value, planned.subject)
          : planned.highlights.length > 0 ? `${planned.highlights.length} marked on the drawing.`
          : "Nothing is marked on the drawing.";
        if (planned.value !== null) {
          return {
            value: planned.value, unit: planned.unit, pipeline: "dxf-geometry", exact: planned.exact, method, note: joined(planned.note, shown),
            evidence: planEvidence(plan, planned, `Highlighted: ${planned.method}`),
            source: { understoodBy: how.by, ...takeoffSource(dxf, plan, planned.method, planned.compared ?? planned.highlights) },
          };
        }
        unanswered = noAnswer(how, dxf, planned.note ?? "the drawing's CAD data does not hold what was asked", { method, note: joined(planned.note, planned.locate && "Nothing is marked on the drawing.") });
        carried = { call: { operation: "read" }, locate: planned.locate, type: input.type ?? planned.type };
      } else {
        const asked = input.type ?? inferType(input.question);
        const requested = input.type === undefined && isLocate(input.question);
        const counted = requested ? parseTakeoff(input.question, "count") : null;
        // A show-request with a qualifier ("the doors of apartment A") is not the plain count the keywords would make of it.
        const pattern = counted ? countKindPattern(counted.kind) : undefined;
        const locate = counted !== null && (!pattern || isPlainRequest(input.question, pattern));
        const intent = locate ? counted : parseTakeoff(input.question, asked);
        const result = intent ? plan.answer(intent) : null;
        if (result) {
          const how = byKeywords(reader);
          return {
            value: result.value, unit: (locate ? "count" : asked) === "area" ? "m2" : "count", pipeline: "dxf-geometry", exact: true,
            method: `${how.text}; ${result.method}`,
            source: { understoodBy: how.by, ...takeoffSource(dxf, plan, result.method, result.highlights) },
            note: locate && result.subject ? markedSentence(result.value, result.subject) : undefined,
            evidence: planEvidence(plan, result, `Highlighted: ${result.method}`),
          };
        }
      }
    }
  }

  const pdf = extension === ".pdf" && existsSync(input.file);
  let image: string | null = null;
  // The drawing the image shows, which the image itself may be a rendering of.
  let drawn = input.file;
  if (IMAGE.has(extension) && existsSync(input.file)) image = input.file;
  else if (RENDERABLE.has(extension) && existsSync(input.file)) image = await rasterize(input.file);
  else {
    drawn = twin(input.file, ".png") ?? twin(input.file, ".jpg") ?? twin(input.file, ".pdf") ?? input.file;
    image = twin(input.file, ".png") ?? twin(input.file, ".jpg") ?? (twin(input.file, ".pdf") ? await rasterize(twin(input.file, ".pdf")!) : null);
  }

  if (pdf || image) {
    // A caller who states that the answer is not a count leaves one route, the free reading; the model that reads the
    // drawing then reads the question as well.
    const fixed: RasterReading | null = input.type !== undefined && input.type !== "count" ? { call: { operation: "read" }, locate: false, type: input.type } : null;
    const target = rasterTarget(input.question);
    const read = carried ?? fixed ?? (await interpret(reader, (model) => planRaster(input.question, RASTER_KINDS, model, rasterHint(input.question))));
    let reading: RasterReading;
    let how: How;
    let asked = input.type ?? read?.type;
    if (read && reader.model) {
      reading = { ...read, type: input.type ?? read.type };
      how =
        unanswered ? { text: unanswered.method, by: unanswered.source.understoodBy }
        : read === fixed ? {
          text: `read as a free question, the answer type '${input.type}' being stated`,
          by: { by: "stated-type", name: "Stated answer type", tier: "script", why: `the caller stated the answer type '${input.type}', which leaves the free reading; the model that reads the drawing reads the question as well` },
        }
        : byModel(describeReading(read), reader.model);
    } else {
      asked ??= inferType(input.question);
      const requested = input.type === undefined && isLocate(input.question);
      // A show-request with a qualifier ("the kitchen sink") is not the plain count the keywords would make of it.
      const locate = requested && (!target || isPlainRequest(input.question, target.pattern));
      reading = read ?? readByKeywords(input.question, locate ? "count" : asked, locate);
      how = byKeywords(reader);
    }

    if (pdf && deps.vision.id !== "none") {
      // Schedules and notes are answered from the sheet's text layer; drawings without enough text go to the image pipeline.
      const { solveDocument } = await import("./solvers/document.js");
      const answer = await solveDocument(input.file, input.question, asked ?? reading.type, { text: deps.vision, fileUrl: deps.fileUrl });
      if (answer) return understood(how, answer);
    }
    if (image) {
      image = await upright(image);
      const raster = { vision: deps.vision, detector: deps.detector, imageUrl: deps.fileUrl(image), useDetector: deps.useDetector, file: basename(drawn) };
      return understood(how, await solveRaster(image, input.question, reading, raster));
    }
  }

  if (unanswered) return unanswered;
  if (ifc || (dxf && !unlayered)) {
    const how = byKeywords(reader);
    return noAnswer(how, ifc ?? dxf!, "the keyword parser does not know this wording for a vector drawing; an interpreter model is needed to read it", {
      method: `${how.text}; it does not know this wording for a vector drawing`,
    });
  }
  const unread = (text: string): How => ({ text, by: { by: "nobody", name: "Not read", tier: "script", why: "no pipeline took the drawing, so nothing read the question" } });
  if (dxf) {
    const lacking = "the DXF file has no labelled room outlines on the layers ROOM_OUTLINE and ROOM_TEXT, which the CAD geometry script reads";
    return noAnswer(unread(`no pipeline for this DXF file: ${lacking}`), dxf, lacking);
  }
  return noAnswer(
    unread(`no pipeline for ${extension || "this"} files`), input.file,
    existsSync(input.file) ? `no pipeline reads ${extension || "this kind of"} files` : "the drawing file was not found, and no vector or image file of the same name either",
  );
}

function describeReading({ call }: RasterReading): string {
  if (call.operation === "read") return "a question to read from the drawing";
  if (call.operation === "count_other") return `count ${call.items}`;
  const plurals = call.targets.map((id) => TARGETS.find((t) => t.id === id)?.plural ?? id).join(" and ");
  return `count ${plurals}${call.whole ? "" : " in the part of the drawing the question names"}`;
}

/**
 * The interpreter's call on a building model, computed. Null when the keyword parsers have to read the question.
 * An answer with pipeline "none" says why the model cannot answer.
 */
async function askIfcByModel(ifc: string, input: AskInput, deps: Deps, reader: Reader): Promise<Answer | null> {
  if (!reader.model) return null;
  // Loaded on demand: the IFC engine is heavy and the other pipelines should not wait for it.
  const { ifcMenu, solveIfc, solveIfcCall } = await import("./solvers/ifc.js");
  const read = await interpret(reader, async (model) => planIfc(input.question, await ifcMenu(ifc), model, ifcHint(input.question, input.type)));
  if (!read) return null;
  const how = byModel(read.understood, reader.model!);
  const type = input.type ?? read.type;
  const { call } = read;

  if (call.operation === "none") return noAnswer(how, ifc, call.reason, { note: joined(call.reason, read.locate && "Nothing is marked on the drawing.") });
  if (read.missing.length > 0 && call.operation !== "model_facts") {
    const { storeys } = await ifcMenu(ifc);
    const lacking = `The building model does not have ${read.missing.map((word) => `'${word}'`).join(", ")}.`;
    return noAnswer(how, ifc, lacking, { note: `${lacking} Its storeys are ${storeys.map((storey) => `'${storey.name}'`).join(", ") || "not named"}.` });
  }

  const answer = await solveIfcCall(ifc, call, type, input.question);
  if (answer) {
    const shown =
      !read.locate ? undefined
      : answer.evidence === undefined ? `Nothing is marked: ${answer.value === null ? "the question could not be answered" : "the model holds no plan geometry for these items"}.`
      : typeof answer.value === "number" && answer.unit === "count" ? highlighted(answer.value)
      : "The items behind the answer are highlighted on the drawing.";
    return { ...understood(how, answer), note: joined(answer.note, shown) };
  }

  // A question about the model's facts: a fixed rule gives a fact sheet on the topic at best, so a language model
  // writes the answer to the actual question from the model's extracted facts.
  const sheet = await solveIfc(ifc, input.question, "text");
  // A sheet rendered from the model may hold the answer itself; the pipelines that read the sheet come next.
  if (extname(input.file).toLowerCase() !== ".ifc" && existsSync(input.file)) {
    return sheet ? understood(how, sheet) : noAnswer(how, input.file, "the building model's rules do not cover this question; the sheet itself has to be read");
  }
  if (deps.vision.id === "none") return factsUnanswered(how, ifc, sheet?.evidence);
  const { answerFromDigest } = await import("./solvers/ifc/digest.js");
  const written = await answerFromDigest(ifc, input.question, type, deps.vision, typeof sheet?.value === "string" ? sheet.value : undefined);
  return {
    ...understood(how, written), evidence: sheet?.evidence,
    note: joined(written.note, read.locate && !sheet?.evidence && "Nothing is marked: the answer was written from the model's facts, not from items on a plan."),
  };
}

/** The rule parser's reading of a question about a building model, with the rewrite into its English templates as second try. */
async function askIfcByKeywords(ifc: string, input: AskInput, deps: Deps, reader: Reader): Promise<Answer | null> {
  const { ifcMenu, solveIfc } = await import("./solvers/ifc.js");
  let how = byKeywords(reader);
  const asked = input.type ?? inferType(input.question);
  let locate = input.type === undefined && isLocate(input.question);
  if (locate) {
    // "Where is the living room?" names one room; counting every room would answer another question.
    const counted = parseIfcQuestion(input.question, "count");
    const storeys = counted?.kind === "count" ? (await ifcMenu(ifc)).storeys.map((storey) => storey.name) : [];
    locate = counted?.kind === "count" && isPlainRequest(input.question, elementWords(counted.element), storeys);
  }
  const qtype = locate ? "count" : asked;
  let answer = await solveIfc(ifc, input.question, qtype);
  const numeric = qtype !== "text";
  if (numeric && !answer) {
    const english = await toEnglish(input.question, deps.vision);
    const rewritten = english ? await solveIfc(ifc, english, qtype) : null;
    if (rewritten) {
      answer = { ...rewritten, method: `rewritten as "${english}" by ${deps.vision.id}; ${rewritten.method}` };
      how = { text: how.text, by: { ...how.by, helper: modelSource(deps.vision.id, `rewrote the question in English as "${english}" for the keyword parser`) } };
    }
  }
  if (answer && numeric) {
    const shown = locate && typeof answer.value === "number" && answer.evidence !== undefined;
    return { ...understood(how, answer), note: shown ? (answer.note ?? highlighted(answer.value as number)) : answer.note };
  }
  if (extname(input.file).toLowerCase() === ".ifc") {
    // A free-text question: the fixed rules give a fact sheet on the topic at best, so a language model
    // writes the answer to the actual question from the model's extracted facts.
    if (deps.vision.id === "none") return factsUnanswered(how, ifc, answer?.evidence);
    const { answerFromDigest } = await import("./solvers/ifc/digest.js");
    const related = typeof answer?.value === "string" ? answer.value : undefined;
    const written = await answerFromDigest(ifc, input.question, asked, deps.vision, related);
    return { ...understood(how, written), evidence: answer?.evidence };
  }
  return answer ? understood(how, answer) : null;
}
