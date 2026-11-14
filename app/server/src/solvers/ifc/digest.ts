/**
 * Free-form questions about an IFC model that no fixed rule covers. The model's facts are written out as text by the
 * catalogue; a first call picks the sections the question needs when the whole does not fit, a second one answers
 * from those sections only.
 */
import { basename } from "node:path";
import type { VisionModel } from "../../models/vision.js";
import { SCRIPTS, model, script } from "../../source.js";
import type { QuestionType, Solved } from "../../types.js";
import { loadCatalogue, type Selection } from "./catalogue.js";

const FACTS_LIMIT = 50_000;
const FACTS = "header and project records, element inventory, types, materials, quantities, spaces and systems";
const MAX_CLASSES = 8;

const SELECT_SYSTEM =
  "You prepare the answer to a question about a building's IFC model. You see the model's overview and decide which further " +
  "fact sections are needed. Sections: 'spaces' lists every room with storey, area, height and volume; 'systems' lists the " +
  "systems, zones and groups with their members. A class detail lists, for one element class of the overview, every type with " +
  "its count per storey, external and load-bearing flags, material layers with thicknesses, totals of length, area and " +
  "volume, dimensions, element names and property values. Name the classes exactly as the overview writes them, most " +
  "relevant first. Take every class that may hold the answer: a ceiling can be a covering or a slab, a fixture can be a flow " +
  "terminal, a furnishing element or a proxy, an installation is spread over segments, fittings, terminals and devices. " +
  "Ask for nothing when the overview already answers the question.";

const SELECT_SCHEMA = {
  type: "object",
  properties: {
    sections: { type: "array", items: { type: "string", enum: ["spaces", "systems"] } },
    classes: { type: "array", items: { type: "string" } },
  },
  required: ["sections", "classes"],
  additionalProperties: false,
};

const ANSWER_SYSTEM =
  "You answer a question about a building from facts extracted from its IFC model. Use only the facts given. " +
  "Answer the question directly and concretely: name the types, give counts and numbers with units, and list every item " +
  "of a breakdown the question asks for. The inventory of element classes is complete, so when something is not in it, " +
  "say that the model contains none instead of saying it cannot be determined. When the model stores no explicit value " +
  "but the facts allow a grounded figure (a sum of room areas, a count from the inventory, a thickness from a layer set), " +
  "give that figure and say in a few words how it was derived. Say that information is not available in the model only " +
  "when the facts hold neither the value nor a basis for it. Keep type and room names as the model writes them. " +
  "When the answer is a single number, also give it in value with its unit.";

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    value: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
  },
  required: ["answer", "value", "unit"],
  additionalProperties: false,
};

/** The facts a question is answered from: the whole catalogue when it is small, otherwise the sections a language model asked for. */
export async function factsFor(ifcPath: string, question: string, text: VisionModel, limit = FACTS_LIMIT): Promise<string> {
  let catalogue = await loadCatalogue(ifcPath);
  const named = catalogue.lookups(question);
  const whole = catalogue.everything(limit - named.length);
  let facts = whole;
  if (facts === null) {
    const overview = [catalogue.project(), catalogue.inventory()].join("\n\n");
    const { output } = await text.ask({ system: SELECT_SYSTEM, schema: SELECT_SCHEMA, prompt: `Question: ${question}\n\nModel overview:\n${overview}` });
    const selection: Selection = {
      sections: Array.isArray(output.sections) ? output.sections.map(String) : [],
      classes: (Array.isArray(output.classes) ? output.classes.map(String) : []).slice(0, MAX_CLASSES),
    };
    // The model may have been closed while the call ran.
    catalogue = await loadCatalogue(ifcPath);
    facts = catalogue.assemble(selection, limit - named.length);
  }
  return named ? `${facts}\n\nRecords of the objects the question names:\n${named}` : facts;
}

export async function answerFromDigest(ifcPath: string, question: string, qtype: QuestionType, text: VisionModel, related?: string): Promise<Solved> {
  const facts = await factsFor(ifcPath, question, text);
  const prompt = `Question: ${question}\n\nModel facts:\n${facts}${related ? `\n\nFacts on the question's topic, from a fixed rule:\n${related}` : ""}`;
  const { output } = await text.ask({ system: ANSWER_SYSTEM, schema: ANSWER_SCHEMA, prompt });
  const numeric = qtype !== "text" && typeof output.value === "number";
  return {
    value: numeric ? output.value : output.answer, unit: output.unit ?? undefined, pipeline: "ifc-facts", exact: false, kind: `ifc_facts_${qtype}`,
    method: `answered by ${text.id} from facts extracted from the building model (${FACTS})`,
    source: {
      calculatedBy: [script(SCRIPTS.ifcFacts, "extracted the model's facts as text"), model(text.id, "wrote the answer from those facts")],
      from: { file: basename(ifcPath), used: FACTS },
    },
  };
}
