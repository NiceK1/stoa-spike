/**
 * Questions arrive in many languages; the take-off parsers know a few. When a parser does not understand a question,
 * a language model rewrites it into the English wording the parsers expect, keeping every quoted name untouched.
 */
import type { VisionModel } from "./models/vision.js";

const SYSTEM = [
  "You rewrite a question about a building model or floor plan into English.",
  "When one of these templates expresses the question, use it word for word:",
  "- How many <items> are shown on the floor plan of '<storey>'?",
  "- How many <items> are there in the model '<model>'?",
  "- What is the net floor area of the room '<room>' on '<storey>', in m²?",
  "- What is the total net floor area of all rooms (spaces) on '<storey>', in m²?",
  "- What is the total length of all walls on '<storey>', in metres?",
  "- What is the total net side area of all walls on '<storey>', in m²?",
  "- What is the total net volume of all walls on '<storey>', in m³?",
  "- What is the total net volume of all slabs on '<storey>', in m³?",
  "<items> is one of: doors, windows, walls, columns, stairs, beams, slabs, rooms (spaces), sanitary fixtures, railings, roofs, ramps.",
  "Floor slabs are 'slabs'; rooms, spaces and premises are 'rooms (spaces)'.",
  "Copy every quoted name exactly as it is written, character for character, in its own language, and put it in straight single quotes.",
  "If no template fits, translate the question literally, still copying the quoted names exactly.",
].join("\n");

export const SCHEMA = {
  type: "object",
  properties: { question: { type: "string" } },
  required: ["question"],
  additionalProperties: false,
};

export async function toEnglish(question: string, text: VisionModel): Promise<string | null> {
  // Local-only mode has no model to translate with; the question is then tried as written.
  if (text.id === "none") return null;
  const { output } = await text.ask({ system: SYSTEM, schema: SCHEMA, prompt: question });
  const rewritten = String(output.question ?? "").trim();
  return rewritten && rewritten !== question ? rewritten : null;
}
