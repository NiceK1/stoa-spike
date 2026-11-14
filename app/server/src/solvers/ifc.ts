import type { Answer, QuestionType } from "../types.js";

/** Answers a take-off question from an IFC model, or returns null when the question is not understood. */
export async function solveIfc(_ifcPath: string, _question: string, _qtype: QuestionType): Promise<Answer | null> {
  return null;
}
