/**
 * Raster drawings. A vision model reads each drawing once into an inventory of located items
 * (windows, doors, fixtures, room types); every count question is then answered from that inventory.
 * A detector, when one is configured, replaces the model for the symbol classes it knows.
 * Either way the answer comes with numbered marks on the image, so a person can check each counted item.
 */
import sharp from "sharp";
import type { Detector } from "../models/detector.js";
import type { VisionModel } from "../models/vision.js";
import type { Answer, Mark, QuestionType } from "../types.js";

export interface RasterDeps {
  vision: VisionModel;
  detector: Detector | null;
  /** URL the browser can load the image from. */
  imageUrl: string;
  /** Use the detector for the classes it offers. Off to measure the vision model alone. */
  useDetector?: boolean;
}

interface Target {
  id: string;
  pattern: RegExp;
  /** Inventory categories that add up to this target. */
  categories: string[];
  /** Detector classes that add up to this target. */
  detectorClasses: string[];
  /** A drawn symbol, which a detector counts best, as opposed to a room type or a storey, which is read from labels. */
  symbol?: boolean;
}

// The target is the one whose words appear first in the question: later mentions are usually exclusions.
export const TARGETS: Target[] = [
  { id: "window", pattern: /\bwindows?\b|ikkuna/, categories: ["windows"], detectorClasses: ["window"], symbol: true },
  { id: "door", pattern: /\bdoors?\b|\bove[at]\b|\bovia\b/, categories: ["doors"], detectorClasses: ["door"], symbol: true },
  { id: "toilet", pattern: /toilet bowls?|wc seats?|wc-istuin/, categories: ["toilet_bowls"], detectorClasses: ["toilet"], symbol: true },
  { id: "sink", pattern: /\bsinks?\b|wash ?basins?|tiskiallas|pesuallas|allasta/, categories: ["sinks"], detectorClasses: ["sink"], symbol: true },
  { id: "shower_bathtub", pattern: /\bshowers?\b|\bbathtubs?\b|suihku|kylpyamme/, categories: ["showers", "bathtubs"], detectorClasses: ["shower", "bathtub"], symbol: true },
  { id: "sauna", pattern: /\bsauna/, categories: ["saunas"], detectorClasses: ["sauna"] },
  { id: "kitchen", pattern: /\bkitchens?\b|keittiö/, categories: ["kitchens"], detectorClasses: ["kitchen"] },
  { id: "bedroom", pattern: /\bbedrooms?\b|makuuhuone/, categories: ["bedrooms"], detectorClasses: ["bedroom"] },
  { id: "wc_room", pattern: /wc rooms?|toilet rooms?|wc-tila/, categories: ["wc_rooms"], detectorClasses: ["wc_room"] },
  { id: "bathroom", pattern: /\bbathrooms?\b|washrooms?|kylpy- tai pesuhuone/, categories: ["bathrooms"], detectorClasses: ["bathroom"] },
  { id: "balcony", pattern: /\bbalcon(y|ies)\b|parveke/, categories: ["balconies"], detectorClasses: ["balcony"] },
  { id: "floor", pattern: /\bfloors\b|\bstoreys?\b|kerrosta/, categories: [], detectorClasses: ["floor"] },
];

export function rasterTarget(question: string): Target | null {
  const lowered = question.toLowerCase();
  let best: { target: Target; index: number } | null = null;
  for (const target of TARGETS) {
    const match = target.pattern.exec(lowered);
    if (match && (best === null || match.index < best.index)) best = { target, index: match.index };
  }
  return best?.target ?? null;
}

const CATEGORIES = [...new Set(TARGETS.flatMap((t) => t.categories))];

const IN_DOMAIN_SCORE = 0.6;
const IN_DOMAIN_DETECTIONS = 3;

const INVENTORY_BASE = [
  "You take an inventory of an architectural floor plan. Open the image with the Read tool before answering.",
  "Go through the plan room by room and record every item of each category exactly once, with the position of its centre:",
  "x and y in thousandths of the image width and height (0 to 1000, origin at the top-left corner).",
  "",
  "Categories and their rules:",
  "- floors: how many separate storeys the image shows (each storey is its own plan drawing); an integer, not a list.",
  "- windows: every window drawn in an outer or inner wall.",
  "- doors: every doorway fitted with a door leaf (usually drawn with a swing arc or a leaf line). Open doorways without a leaf do not count.",
  "- toilet_bowls: every toilet seat symbol.",
  "- sinks: every sink or wash basin, in kitchens and bathrooms alike. A double-bowl sink is one item.",
  "- showers: every shower. bathtubs: every bathtub.",
  "- saunas: every sauna room (often marked S or SAUNA).",
  "- kitchens: every kitchen, including kitchenettes, open kitchens and utility kitchens (marked K, KT, KK, KEITTIÖ, TUPAKEITTIÖ, APUKEITTIÖ).",
  "- bedrooms: every bedroom (marked MH or makuuhuone).",
  "- wc_rooms: every separate toilet room marked WC.",
  "- bathrooms: every bathroom or washroom (marked KH, KPH, PH, PESUH or SH). A separate WC room is not a bathroom.",
  "- balconies: every balcony, including glazed balconies (parveke, lasitettu parveke). Terraces are not balconies.",
  "",
  "Use an empty list for a category with no items.",
].join("\n");

const SCOPE_RULE =
  "Scope: many images show one apartment inside a larger building plan, with parts of neighbouring apartments or shared " +
  "spaces visible around it. When a hand-drawn outline, the labels (for example an apartment name with its area) or the " +
  "framing single out one apartment, record only that apartment's items. Ignore everything in neighbouring apartments, " +
  "above all rooms and fixtures that are cut off at the edge of the image.";

const FIXTURE_RULES =
  "Fixtures: a shower is often drawn only as a small shower-head symbol (a small circle with a short curved hose or " +
  "spray lines) in a corner of a bathroom, with no tray; record each one as a shower. " +
  "A sink is a basin with a bowl outline; a stove (four circles), a washing machine, a floor drain or a water heater is not a sink.";

/** Prompt versions, kept so that measured results stay reproducible. Selected with INVENTORY_PROMPT. */
export const INVENTORY_PROMPTS: Record<string, string> = {
  v1: INVENTORY_BASE,
  v2: `${INVENTORY_BASE}\n\n${SCOPE_RULE}`,
  v3: `${INVENTORY_BASE}\n\n${SCOPE_RULE}\n\n${FIXTURE_RULES}`,
};
const DEFAULT_PROMPT = "v3";

function inventorySystem(): string {
  return INVENTORY_PROMPTS[process.env.INVENTORY_PROMPT ?? DEFAULT_PROMPT] ?? INVENTORY_PROMPTS[DEFAULT_PROMPT];
}

const POINTS = {
  type: "array",
  items: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"], additionalProperties: false },
};

export const INVENTORY_SCHEMA = {
  type: "object",
  properties: { floors: { type: "integer" }, ...Object.fromEntries(CATEGORIES.map((c) => [c, POINTS])) },
  required: ["floors", ...CATEGORIES],
  additionalProperties: false,
};

const COUNT_SYSTEM =
  "You read architectural floor plans and count what is drawn on them. Open the image with the Read tool before answering. " +
  "Work through the plan room by room and list every item the question asks about, exactly once. " +
  "For each item give the position of its centre as x and y in thousandths of the image width and height " +
  "(0 to 1000, origin at the top-left corner). The answer is the number of items you list.";

const COUNT_SCHEMA = {
  type: "object",
  properties: { items: POINTS, count: { type: "integer" } },
  required: ["items", "count"],
  additionalProperties: false,
};

const FREE_SYSTEM =
  "You read architectural drawings. Open the image with the Read tool before answering. " +
  "Answer from what is drawn or written on the drawing; if it cannot be determined, say so in the explanation and leave value empty.";

const FREE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    value: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
    explanation: { type: "string" },
  },
  required: ["answer", "value", "unit", "explanation"],
  additionalProperties: false,
};

type Located = { x: number; y: number };

export async function solveRaster(imagePath: string, question: string, qtype: QuestionType, deps: RasterDeps): Promise<Answer> {
  const { width = 0, height = 0 } = await sharp(imagePath).metadata();
  const image = (marks: Mark[], caption: string) => ({ kind: "image" as const, imageUrl: deps.imageUrl, width, height, marks, caption });
  const toMarks = (items: Located[]): Mark[] => items.map((item, i) => ({ n: i + 1, x: (item.x / 1000) * width, y: (item.y / 1000) * height }));

  if (qtype !== "count") {
    const { output } = await deps.vision.ask({ imagePath, system: FREE_SYSTEM, prompt: question, schema: FREE_SCHEMA });
    return {
      value: qtype === "text" ? output.answer : (output.value ?? output.answer), unit: output.unit ?? undefined, pipeline: "vision-model", exact: false,
      method: `read from the drawing by ${deps.vision.id}`, note: output.explanation, evidence: image([], "Source drawing"),
    };
  }

  const target = rasterTarget(question);
  // RASTER_DETECTOR_TARGETS: "symbols" (default) lets the detector count drawn symbols and leaves room types and
  // storeys to the vision model; "all" gives the detector everything it knows; "none" switches it off.
  const scope = deps.useDetector === false ? "none" : (process.env.RASTER_DETECTOR_TARGETS ?? "symbols");
  const detector = deps.detector;
  const detections =
    detector && target && scope !== "none" && (scope === "all" || target.symbol) &&
    target.detectorClasses.every((cls) => cls in detector.thresholds)
      ? await detector.detect(imagePath)
      : null;
  // The detector knows one drawing style. On a drawing where it recognises almost nothing with confidence
  // (an elevation, a historic scan), its count would be a confident zero, so the vision model answers instead.
  if (detector && target && detections && detections.filter((d) => d.score >= IN_DOMAIN_SCORE).length >= IN_DOMAIN_DETECTIONS) {
    const found = detections
      .filter((d) => target.detectorClasses.includes(d.cls) && d.score >= detector.thresholds[d.cls])
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const marks = found.map((d, i) => ({
      n: i + 1, x: d.x, y: d.y, w: d.w, h: d.h, label: `${d.cls.replace("_", " ")}, ${Math.round(d.score * 100)}% confidence`,
    }));
    const names = target.detectorClasses.map((cls) => cls.replace("_", " ")).join(" and ");
    return {
      value: found.length, unit: "count", pipeline: "detector", exact: false, kind: target.id,
      method: `${names} symbols found by the detector ${detector.id.split(":")[1]}`,
      evidence: image(marks, `Each box is one counted ${names}`),
    };
  }

  if (target) {
    // Several independent readings, answered by the middle one: a single reading is off by one too often.
    const votes = Math.max(1, Number(process.env.INVENTORY_VOTES ?? 1));
    const readings = await Promise.all(
      Array.from({ length: votes }, (_, pass) =>
        deps.vision.ask({
          imagePath, system: inventorySystem(), schema: INVENTORY_SCHEMA,
          prompt: pass === 0 ? "Take the inventory of this floor plan." : `Take the inventory of this floor plan. (Independent reading ${pass + 1}.)`,
        }),
      ),
    );
    const itemsOf = (output: Record<string, any>): Located[] => target.categories.flatMap((c) => output[c] ?? []);
    const countOf = (output: Record<string, any>): number => (target.id === "floor" ? output.floors : itemsOf(output).length);
    const middle = readings.map((r) => countOf(r.output)).sort((a, b) => a - b)[Math.floor(votes / 2)];
    const chosen = readings.find((r) => countOf(r.output) === middle)!.output;
    const by = votes > 1 ? `${deps.vision.id}, middle of ${votes} readings` : deps.vision.id;

    if (target.id === "floor") {
      return {
        value: middle, unit: "count", pipeline: "vision-model", exact: false, kind: target.id,
        method: `storeys counted by ${by}`, evidence: image([], "Source drawing"),
      };
    }
    return {
      value: middle, unit: "count", pipeline: "vision-model", exact: false, kind: target.id,
      method: `${target.categories.join(" and ").replaceAll("_", " ")} located by ${by}`,
      evidence: image(toMarks(itemsOf(chosen)), "Each number is one counted item; positions are the model's estimate"),
    };
  }

  const { output } = await deps.vision.ask({ imagePath, system: COUNT_SYSTEM, prompt: question, schema: COUNT_SCHEMA });
  const items: Located[] = output.items ?? [];
  return {
    value: items.length > 0 ? items.length : output.count, unit: "count", pipeline: "vision-model", exact: false, kind: "other",
    method: `items listed by ${deps.vision.id}`,
    evidence: image(toMarks(items), "Each number is one counted item; positions are the model's estimate"),
  };
}
