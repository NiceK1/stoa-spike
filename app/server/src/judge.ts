/**
 * Grades a free-text answer against the dataset's reference answer. The dataset scores numbers by rule;
 * for text there is no rule, so a language model compares the facts, with the same 2% tolerance on numbers.
 */
import type { VisionModel } from "./models/vision.js";

export type Verdict = "correct" | "partly" | "wrong";

const SYSTEM =
  "You grade an answer to a question about a building model against a reference answer. " +
  "Compare the facts, not the wording, the order or the level of detail. Numbers agree when they are within 2% of each " +
  "other after converting units; a rounded number agrees with its unrounded form.\n" +
  "- correct: every fact the question asks for is in the answer and agrees with the reference. Extra detail that does not contradict the reference is fine.\n" +
  "- partly: the answer gets the main fact right but leaves out or gets wrong part of what was asked.\n" +
  "- wrong: the main fact is missing or contradicts the reference, or the answer says it cannot be determined when the reference gives it.";

const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["correct", "partly", "wrong"] }, reason: { type: "string" } },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

export async function judge(question: string, reference: string, answer: string, model: VisionModel): Promise<{ verdict: Verdict; reason: string }> {
  const { output } = await model.ask({
    system: SYSTEM, schema: SCHEMA,
    prompt: `Question:\n${question}\n\nReference answer:\n${reference}\n\nAnswer to grade:\n${answer}`,
  });
  return { verdict: output.verdict, reason: output.reason };
}
