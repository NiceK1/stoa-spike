/**
 * Rewords dataset questions in styles far from their templates, to measure how the app copes with free wording.
 * The reworded question keeps the original's answer, so it is scored against the dataset's expected value.
 */
import type { VisionModel } from "./models/vision.js";
import type { QuestionRow } from "./types.js";

export interface Style {
  id: string;
  /** Instruction for the rewriting model; `turn` counts the questions already given this style. */
  instruction(turn: number): string;
  /** Asking to be shown something only makes sense where the answer is a set of items. */
  countOnly?: boolean;
}

const LANGUAGES = ["Finnish", "German", "French", "Italian", "Swedish", "Spanish"];
const HELDOUT_LANGUAGES = ["Dutch", "Danish", "Portuguese", "Norwegian", "Polish", "Estonian"];

/** `dev` is the set the planner was developed against; verify with another set, so the planner is not fitted to it. */
export const STYLE_SETS: Record<string, Style[]> = {
  dev: [
    { id: "casual", instruction: () => "Casual spoken English, the way a site manager would ask a colleague. Not a textbook question." },
    {
      id: "locate", countOnly: true,
      instruction: () => "Ask to be shown the items instead of asking for their number: an instruction or a where-question (show me ..., mark ..., highlight ..., where are ..., point out ...).",
    },
    { id: "terse", instruction: () => "A terse keyword query of two to six words, as typed into a search box, without a question word." },
    { id: "language", instruction: (turn) => `A natural, freely worded question in ${LANGUAGES[turn % LANGUAGES.length]}, not a literal translation.` },
    { id: "typo", instruction: () => "Casual English with two realistic typing mistakes in ordinary words (swapped or missing letters), never in names, numbers or labels." },
  ],
  /** Only for the held-out test of the local interpreter (scripts/interp-pairs.ts): never train on these. */
  heldout: [
    { id: "formal", instruction: () => "A formal, complete written request, as in an e-mail to a consultant; one sentence." },
    { id: "spoken", instruction: () => "The way someone says it aloud to a voice assistant on site: short and spoken, with a filler word or a false start." },
    { id: "indirect", instruction: () => "An indirect question inside a statement of what the asker needs (I need to know ..., we are pricing ..., so ...)." },
    {
      id: "point-out", countOnly: true,
      instruction: () => "A polite request to be pointed to the items on the drawing, without the words show, mark, highlight or where (can you point me to ..., which ones are the ..., I would like to see ...).",
    },
    { id: "shorthand", instruction: () => "Shorthand as in a chat message between engineers: abbreviations (qty, no., apt, rm, flr, m2), no full sentence." },
    { id: "other-language", instruction: (turn) => `A natural, freely worded question in ${HELDOUT_LANGUAGES[turn % HELDOUT_LANGUAGES.length]}, not a literal translation.` },
  ],
};
// What the local interpreter is trained on: the development styles and more of their kind.
STYLE_SETS.train = [
  ...STYLE_SETS.dev,
  { id: "imperative", instruction: () => "An instruction instead of a question (count ..., give me ..., tell me ..., I need ...)." },
  { id: "chatty", instruction: () => "A longer, chatty question that first says in a few words who is asking or why, then asks." },
  { id: "texting", instruction: () => "Lowercase texting style without punctuation, with abbreviations such as pls, u, no. of, how many -> how mny." },
  { id: "language-terse", instruction: (turn) => `A terse keyword query of two to six words in ${LANGUAGES[(turn + 2) % LANGUAGES.length]}, without a question word.` },
  {
    id: "language-locate", countOnly: true,
    instruction: (turn) => `In ${LANGUAGES[(turn + 4) % LANGUAGES.length]}: ask to be shown the items instead of asking for their number (an instruction or a where-question).`,
  },
];

const SYSTEM = [
  "You reword questions that people ask about construction drawings (floor plans and building models), to test whether software understands free wording.",
  "For every item you get the original question and a style. Write one new question in that style.",
  "Rules:",
  "- The new question asks for exactly the same thing, so its correct answer on the same drawing is the same value: the same items, the same scope (this floor, one apartment, one storey, the whole model) and, for a measure, the same quantity.",
  "- Explanations in the original of what counts and what is left out may be dropped where a person would assume them anyway.",
  "- Room numbers (7.01, U1.02), apartment letters, storey names and model names identify what is asked about: copy them exactly; their quotes may be dropped.",
  "- A room label given in quotes may be copied, or replaced by the everyday word for that kind of room in the language of the new question when the meaning stays unmistakable (for example 'Schlafzimmer' becomes bedrooms). Copy a label that has no obvious everyday word.",
  "- Stay far from the original's wording and sentence structure.",
  "- Do not mention the style and do not add explanations.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    rewrites: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" }, question: { type: "string" } }, required: ["id", "question"], additionalProperties: false },
    },
  },
  required: ["rewrites"],
  additionalProperties: false,
};

const BATCH = 20;

export interface Paraphrase {
  row: QuestionRow;
  style: string;
  question: string;
}

/** One reworded question per row, with the styles of `styles` taken in turn. Rows the model skipped are left out. */
export async function paraphrase(rows: QuestionRow[], styles: Style[], model: VisionModel): Promise<Paraphrase[]> {
  const turns = new Map<string, number>();
  const assigned = rows.map((row, i) => {
    const fitting = styles.filter((s) => !s.countOnly || row.type === "count");
    const style = fitting[i % fitting.length];
    const turn = turns.get(style.id) ?? 0;
    turns.set(style.id, turn + 1);
    return { row, style: style.id, instruction: style.instruction(turn) };
  });

  const batches = Array.from({ length: Math.ceil(assigned.length / BATCH) }, (_, i) => assigned.slice(i * BATCH, (i + 1) * BATCH));
  const answers = await Promise.all(
    batches.map((batch) =>
      model.ask({ system: SYSTEM, schema: SCHEMA, prompt: JSON.stringify(batch.map((item, i) => ({ id: i, style: item.instruction, question: item.row.question })), null, 1) }),
    ),
  );
  const result: Paraphrase[] = [];
  answers.forEach(({ output }, b) => {
    for (const rewrite of output.rewrites ?? []) {
      const item = batches[b][rewrite.id];
      const question = String(rewrite.question ?? "").trim();
      if (item && question) result.push({ row: item.row, style: item.style, question });
    }
  });
  return result;
}

export interface Rewording {
  /** Index into the questions given. */
  index: number;
  style: string;
  /** The style asks to be shown the items, so the reading changes from a count to a request to locate. */
  locate: boolean;
  question: string;
}

const MANY_SYSTEM = SYSTEM.replace(
  "For every item you get the original question and a style. Write one new question in that style.",
  "For every item you get the original question and several styles, each under a key. Write one new question per style, and return it with the item's id and the style's key.",
);

const MANY_SCHEMA = {
  type: "object",
  properties: {
    rewrites: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, style: { type: "string" }, question: { type: "string" } },
        required: ["id", "style", "question"],
        additionalProperties: false,
      },
    },
  },
  required: ["rewrites"],
  additionalProperties: false,
};

/**
 * One rewording of every question in every fitting style, `perCall` questions to a model call and `concurrency`
 * calls at a time. A call that fails leaves its questions out.
 */
export async function rewordInStyles(
  questions: { question: string; countable: boolean }[], styles: Style[], model: VisionModel, perCall = 5, concurrency = 8,
): Promise<Rewording[]> {
  const batches = Array.from({ length: Math.ceil(questions.length / perCall) }, (_, b) => questions.slice(b * perCall, (b + 1) * perCall).map((each, i) => ({ ...each, index: b * perCall + i })));
  const result: Rewording[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < batches.length) {
      const batch = batches[next++];
      const items = batch.map((each, id) => ({
        id, question: each.question,
        styles: Object.fromEntries(styles.filter((style) => !style.countOnly || each.countable).map((style) => [style.id, style.instruction(each.index)])),
      }));
      try {
        const { output } = await model.ask({ system: MANY_SYSTEM, schema: MANY_SCHEMA, prompt: JSON.stringify(items, null, 1) });
        for (const rewrite of output.rewrites ?? []) {
          const source = batch[rewrite.id];
          const style = styles.find((each) => each.id === rewrite.style);
          const question = String(rewrite.question ?? "").trim();
          if (source && style && question && (!style.countOnly || source.countable)) result.push({ index: source.index, style: style.id, locate: style.countOnly === true, question });
        }
      } catch {
        // left out
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}
