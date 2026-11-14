/**
 * Free-form questions about an IFC model that no fixed rule covers: the model's facts are written out as text
 * (storeys, rooms with areas, element counts and types) and a language model answers from that text only.
 */
import type { VisionModel } from "../../models/vision.js";
import type { Answer, QuestionType } from "../../types.js";
import { loadModel, roomLabel, type IfcModel } from "./model.js";
import type { ElementKind } from "./question.js";

const COUNTED: ElementKind[] = ["door", "window", "wall", "column", "stair", "beam", "slab", "railing", "roof", "ramp", "covering", "furniture"];
const MAX_ROOMS_LISTED = 400;

const round = (value: number) => Math.round(value * 100) / 100;

function roomArea(model: IfcModel, id: number): number | null {
  const stored = model.quantity(id, "NetFloorArea");
  if (stored !== null && stored > 0) return stored;
  const shape = model.shape(id);
  return shape && shape.area > 0 ? shape.area : null;
}

export function buildDigest(model: IfcModel): string {
  const lines = [
    `IFC schema: ${model.schema}`,
    `Project: ${model.projectName || "(unnamed)"}; building: ${model.buildingName || "(unnamed)"}; site: ${model.siteName || "(unnamed)"}`,
    `Storeys, lowest first: ${model.storeys.map((s) => `${s.name} (elevation ${round(s.elevation)} m)`).join("; ")}`,
    "",
    "Whole model:",
    ...COUNTED.map((kind) => [kind, model.elements(kind).length] as const).filter(([, n]) => n > 0).map(([kind, n]) => `- ${kind}: ${n}`),
  ];

  let listed = 0;
  for (const storey of model.storeys) {
    const rooms = model.elements("space", storey);
    const areas = rooms.map((id) => roomArea(model, id));
    const total = areas.reduce<number>((sum, a) => sum + (a ?? 0), 0);
    const counts = COUNTED.map((kind) => [kind, model.elements(kind, storey).length] as const).filter(([, n]) => n > 0);
    lines.push("", `Storey ${storey.name}: ${rooms.length} rooms, total room area ${round(total)} m2; ${counts.map(([k, n]) => `${n} ${k}`).join(", ") || "no counted elements"}`);
    rooms.forEach((id, i) => {
      if (listed++ >= MAX_ROOMS_LISTED) return;
      lines.push(`- room ${roomLabel(model.space(id)) || id}: ${areas[i] === null ? "area unknown" : `${round(areas[i]!)} m2`}`);
    });
  }
  if (listed > MAX_ROOMS_LISTED) lines.push("", `(${listed - MAX_ROOMS_LISTED} more rooms are not listed)`);

  for (const kind of ["door", "window", "wall", "slab"] as ElementKind[]) {
    const types = new Map<string, number>();
    for (const id of model.elements(kind)) {
      const name = model.typeName(id);
      if (name) types.set(name, (types.get(name) ?? 0) + 1);
    }
    if (types.size > 0) {
      lines.push("", `${kind} types: ${[...types].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, n]) => `${name} x${n}`).join("; ")}`);
    }
  }
  return lines.join("\n");
}

const SYSTEM =
  "You answer questions about a building from facts extracted from its IFC model. Use only the facts given. " +
  "If they do not contain the answer, say what is missing and set value to null. Keep the answer short and concrete; " +
  "when the answer is a single number, also give it in value with its unit.";

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    value: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
  },
  required: ["answer", "value", "unit"],
  additionalProperties: false,
};

export async function answerFromDigest(ifcPath: string, question: string, qtype: QuestionType, text: VisionModel, related?: string): Promise<Answer> {
  const model = await loadModel(ifcPath);
  const facts = related ? `${buildDigest(model)}\n\nFacts on the question's topic:\n${related}` : buildDigest(model);
  const { output } = await text.ask({ system: SYSTEM, schema: SCHEMA, prompt: `Question: ${question}\n\nModel facts:\n${facts}` });
  const numeric = qtype !== "text" && typeof output.value === "number";
  return {
    value: numeric ? output.value : output.answer, unit: output.unit ?? undefined, pipeline: "ifc-facts", exact: false, kind: `ifc_facts_${qtype}`,
    method: `answered by ${text.id} from facts extracted from the building model (storeys, rooms, areas, element counts and types)`,
  };
}
