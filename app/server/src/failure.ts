/**
 * What a failed answer says to a person: one sentence to act on. A provider's own message (a URL, a payload dump)
 * goes along as `detail`, cut short, for whoever looks into it.
 */
export interface Failure {
  error: string;
  detail?: string;
}

const OUTSIDE: [RegExp, string][] = [
  [/GoogleGenerativeAI|generativelanguage\.googleapis/i, "Gemini 4 Hydrogen (Google)"],
  [/anthropic|claude/i, "Claude (Anthropic)"],
];
const DETAIL = 300;
const SENTENCE = 200;

export function explainFailure(error: unknown): Failure {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  const outside = OUTSIDE.find(([pattern]) => pattern.test(raw))?.[1];
  if (outside) {
    return {
      error: `The outside model ${outside} did not answer this question. Ask again, or switch to Blueline only, which does not call it.`,
      detail: raw.slice(0, DETAIL),
    };
  }
  const first = raw.split("\n")[0];
  return first.length <= SENTENCE ? { error: first || "The question could not be answered." } : { error: `${first.slice(0, SENTENCE - 40).trimEnd()}…`, detail: raw.slice(0, DETAIL) };
}
