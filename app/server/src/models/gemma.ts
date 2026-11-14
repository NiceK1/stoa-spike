/**
 * A small open model as the interpreter, run on the CPU inside this process: FunctionGemma 270M fine-tuned on this
 * app's own question-to-call pairs (training/gemma), loaded from a GGUF file with node-llama-cpp.
 *
 * The prompt is rendered here and nowhere else; scripts/interp-pairs.ts writes the training pairs with the same
 * functions, so that inference sees the tokens the model was trained on.
 */
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { REPO_ROOT } from "../config.js";
import type { VisionModel, VisionRequest, VisionResult } from "./vision.js";

export const DEFAULT_GEMMA_PATH = join(REPO_ROOT, "models", "interpreter", "interpreter-q8_0.gguf");

type Schema = Record<string, any>;

// Longer lists are the drawing's own vocabulary, which the menu already shows.
const HINT_VALUES = 16;

const values = (options: unknown[]) => options.map((option) => (option === "" ? "''" : String(option))).join("|");

/** The fields of the call in the order the model writes them, with the fixed choices of each. */
export function schemaHint(schema: Schema): string {
  const fields = Object.entries<Schema>(schema.properties ?? {}).map(([name, field]) => {
    const choices = field.enum ?? field.items?.enum;
    const listed = Array.isArray(choices) && choices.length <= HINT_VALUES ? values(choices) : choices ? "from the menu" : "";
    if (field.type === "array") return `${name} [${listed}]`;
    if (field.type === "boolean") return `${name} true|false`;
    return listed ? `${name} ${listed}` : `${name} text`;
  });
  return `Call: ${fields.join("; ")}`;
}

export interface Turns {
  developer: string;
  user: string;
}

/**
 * The two turns of a request. A tuned model has learnt the operations from examples, so of the instruction it gets
 * the opening line, which says what kind of drawing the call is for. The menu, the last paragraph of the prompt,
 * goes in front of the question: questions about one drawing then share everything up to the question itself.
 */
export function turns(request: Pick<VisionRequest, "system" | "prompt" | "schema">): Turns {
  const cut = request.prompt.lastIndexOf("\n\n");
  const menu = cut < 0 ? "" : request.prompt.slice(cut + 2);
  const developer = [request.system.split("\n")[0], schemaHint(request.schema), ...(menu ? ["", menu] : [])].join("\n");
  return { developer, user: cut < 0 ? request.prompt : request.prompt.slice(0, cut) };
}

/** FunctionGemma's chat template without the leading <bos>, which the runtime adds when it tokenizes. */
export function renderPrompt({ developer, user }: Turns): string {
  return `<start_of_turn>developer\n${developer}<end_of_turn>\n<start_of_turn>user\n${user}<end_of_turn>\n<start_of_turn>model\n`;
}

/** The call as the model writes it: compact JSON with the keys in schema order, which is also the order a grammar forces. */
export function completionJson(call: Record<string, unknown>, schema: Schema): string {
  return JSON.stringify(Object.fromEntries(Object.keys(schema.properties ?? {}).map((key) => [key, call[key]])));
}

/**
 * The schema as node-llama-cpp's grammar builder takes it: type, enum, const, oneOf, properties and items.
 * Every property is required in the order given, which is what the planner's schemas ask for anyway.
 */
export function grammarSchema(schema: Schema): Schema {
  if (Array.isArray(schema.enum)) return { enum: schema.enum };
  if (schema.type === "object") {
    return { type: "object", properties: Object.fromEntries(Object.entries<Schema>(schema.properties ?? {}).map(([key, value]) => [key, grammarSchema(value)])) };
  }
  if (schema.type === "array") return { type: "array", items: grammarSchema(schema.items ?? { type: "string" }) };
  return { type: schema.type };
}

interface Runtime {
  tokenize(text: string): unknown;
  grammar(schema: Schema): Promise<unknown>;
  complete(tokens: unknown, grammar: unknown): Promise<string>;
}

const MAX_OUTPUT_TOKENS = 320;
const CONTEXT_TOKENS = 4096;
const GRAMMARS_KEPT = 64;

async function load(modelPath: string, threads: number): Promise<Runtime> {
  const { getLlama, LlamaCompletion } = await import("node-llama-cpp");
  const llama = await getLlama({ gpu: false });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: CONTEXT_TOKENS, threads });
  const completion = new LlamaCompletion({ contextSequence: context.getSequence() });
  const grammars = new Map<string, Promise<unknown>>();
  return {
    // Special tokens are parsed; the completion puts BOS in front itself.
    tokenize: (text) => model.tokenize(text, true),
    grammar(schema) {
      const key = JSON.stringify(schema);
      if (!grammars.has(key)) {
        if (grammars.size >= GRAMMARS_KEPT) grammars.delete(grammars.keys().next().value!);
        grammars.set(key, llama.createGrammarForJsonSchema(grammarSchema(schema) as any));
      }
      return grammars.get(key)!;
    },
    complete: (tokens, grammar) => completion.generateCompletion(tokens as any, { grammar: grammar as any, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0 }),
  };
}

/** The tuned Gemma from a GGUF file. Text requests only; one request at a time, since they share one context. */
export class GemmaLocal implements VisionModel {
  readonly id: string;
  private runtime: Promise<Runtime> | null = null;
  private last: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly modelPath = DEFAULT_GEMMA_PATH,
    private readonly threads = Number(process.env.PLANNER_THREADS) || Math.min(8, availableParallelism()),
  ) {
    this.id = `gemma-local:${basename(modelPath).replace(/\.gguf$/i, "")}`;
  }

  ask(request: VisionRequest): Promise<VisionResult> {
    const answer = this.last.then(() => this.run(request));
    this.last = answer.catch(() => undefined);
    return answer;
  }

  private async run(request: VisionRequest): Promise<VisionResult> {
    if (request.imagePath) throw new Error(`${this.id} reads text only`);
    if (!existsSync(this.modelPath)) throw new Error(`the model file ${this.modelPath} is missing`);
    this.runtime ??= load(this.modelPath, this.threads);
    const runtime = await this.runtime;
    const started = Date.now();
    const text = await runtime.complete(runtime.tokenize(renderPrompt(turns(request))), await runtime.grammar(request.schema));
    let output: Record<string, any>;
    try {
      output = JSON.parse(text);
    } catch {
      throw new Error(`unreadable output: ${text.slice(0, 200)}`);
    }
    return { output, seconds: (Date.now() - started) / 1000, costUsd: 0, cached: false };
  }
}
