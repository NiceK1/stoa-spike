/**
 * Vision model behind one interface, so the provider can be swapped (local `claude` CLI now, an HTTP API later).
 * Every provider gets an image, a system prompt, a user prompt and a JSON schema, and returns an object matching the schema.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { cachedJson, readJson, writeJsonAtomic } from "../cache.js";
import { cacheDir } from "../config.js";
import { GemmaLocal } from "./gemma.js";

export interface VisionRequest {
  /** Leave out for a text-only question. */
  imagePath?: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export interface VisionResult {
  output: Record<string, any>;
  seconds: number;
  costUsd: number;
  cached: boolean;
}

export interface VisionModel {
  readonly id: string;
  ask(request: VisionRequest): Promise<VisionResult>;
}

/** Claude through the local `claude` CLI in headless mode. Its only tool is Read, confined to the image's folder. */
export class ClaudeCliVision implements VisionModel {
  readonly id: string;

  constructor(
    private readonly model = process.env.VISION_MODEL ?? "claude-sonnet-5-5",
    private readonly effort = process.env.VISION_EFFORT,
    private readonly timeoutMs = 600_000,
  ) {
    this.id = `claude-cli:${model}${effort ? `:${effort}` : ""}`;
  }

  async ask(request: VisionRequest): Promise<VisionResult> {
    const key = await cacheKey(this.id, request);
    const cacheFile = join(cacheDir("vision"), `${key}.json`);
    const stored = await readJson<Omit<VisionResult, "cached">>(cacheFile);
    if (stored) return { ...stored, cached: true };
    // Several questions about one drawing share a request; run it once.
    const running = this.inFlight.get(key);
    if (running) return running;
    const call = this.call(request, cacheFile).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, call);
    return call;
  }

  private readonly inFlight = new Map<string, Promise<VisionResult>>();

  private async call(request: VisionRequest, cacheFile: string): Promise<VisionResult> {
    const args = [
      "-p", "--model", this.model, "--output-format", "json", "--json-schema", JSON.stringify(request.schema),
      "--system-prompt", request.system, "--tools", request.imagePath ? "Read" : "", "--strict-mcp-config", "--safe-mode",
      "--disable-slash-commands", "--no-session-persistence",
    ];
    if (this.effort) args.push("--effort", this.effort);
    const prompt = request.imagePath
      ? `The drawing is the image file \`${basename(request.imagePath)}\` in the current folder.\n${request.prompt}`
      : request.prompt;
    // Without an image the model gets no tools and an empty folder, so it can only answer.
    const cwd = request.imagePath ? dirname(request.imagePath) : cacheDir("text-cwd");

    const started = Date.now();
    const stdout = await run("claude", args, prompt, cwd, this.timeoutMs);
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`unreadable CLI output: ${stdout.slice(0, 300)}`);
    }
    if (parsed.is_error || typeof parsed.structured_output !== "object" || parsed.structured_output === null) {
      throw new Error(`no structured output (${parsed.subtype}): ${String(parsed.result).slice(0, 300)}`);
    }
    const result = { output: parsed.structured_output, seconds: (Date.now() - started) / 1000, costUsd: parsed.total_cost_usd ?? 0 };
    await writeJsonAtomic(cacheFile, result);
    return { ...result, cached: false };
  }
}

export async function cacheKey(id: string, request: VisionRequest): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify([id, request.system, request.prompt, request.schema]));
  if (request.imagePath) hash.update(await readFile(request.imagePath));
  return hash.digest("hex").slice(0, 32);
}

function run(command: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    const child = spawn(command, args, { cwd, windowsHide: true, env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (stdout.trim()) resolve(stdout);
      else reject(new Error(`${command} produced no output: ${stderr.slice(0, 300)}`));
    });
    child.stdin.end(input);
  });
}

// USD per million tokens, input and output, for the cost estimate shown next to API answers.
const API_PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "gemini-4-hydrogen": [1.5, 7.5],
  "gemini-2.0-flash-exp": [0, 0], // Free tier during preview
  "gemini-2.0-flash-thinking-exp-1219": [0, 0], // Free tier during preview
  "gemini-1.5-pro": [1.25, 5],
  "gemini-1.5-flash": [0.075, 0.3],
};
const API_IMAGE_LONG_SIDE = 2000;

/** Claude through the Anthropic API. Needs ANTHROPIC_API_KEY. */
export class AnthropicApiVision implements VisionModel {
  readonly id: string;
  private client: import("@anthropic-ai/sdk").default | null = null;

  constructor(private readonly model = process.env.VISION_MODEL ?? "claude-sonnet-5-5") {
    this.id = `anthropic-api:${model}`;
  }

  async ask(request: VisionRequest): Promise<VisionResult> {
    const key = await cacheKey(this.id, request);
    const cacheFile = join(cacheDir("vision"), `${key}.json`);
    const stored = await readJson<Omit<VisionResult, "cached">>(cacheFile);
    if (stored) return { ...stored, cached: true };

    if (!this.client) this.client = new (await import("@anthropic-ai/sdk")).default();
    const content: Record<string, unknown>[] = [{ type: "text", text: request.prompt }];
    if (request.imagePath) {
      const { default: sharp } = await import("sharp");
      // The API limits image size; plans keep their detail well at this resolution.
      const png = await sharp(request.imagePath)
        .resize({ width: API_IMAGE_LONG_SIDE, height: API_IMAGE_LONG_SIDE, fit: "inside", withoutEnlargement: true }).png().toBuffer();
      content.unshift({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
    }

    const started = Date.now();
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      // If the model declines a request, the API re-runs it on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: request.system.replace("Open the image with the Read tool before answering. ", "").replace("Open the image with the Read tool first. ", ""),
      output_config: { format: { type: "json_schema", schema: request.schema } },
      messages: [{ role: "user", content }],
    } as any);
    if (response.stop_reason === "refusal") throw new Error("the model declined to answer");
    const text = response.content.find((block: any) => block.type === "text") as { text: string } | undefined;
    if (!text) throw new Error(`no text in the response (stop reason ${response.stop_reason})`);
    const [inputPrice, outputPrice] = API_PRICES[this.model] ?? [0, 0];
    const result = {
      output: JSON.parse(text.text),
      seconds: (Date.now() - started) / 1000,
      costUsd: (response.usage.input_tokens * inputPrice + response.usage.output_tokens * outputPrice) / 1e6,
    };
    await writeJsonAtomic(cacheFile, result);
    return { ...result, cached: false };
  }
}

/** Gemini through the Google AI API. Needs GEMINI_API_KEY. */
export class GeminiApiVision implements VisionModel {
  readonly id: string;
  private client: import("@google/generative-ai").GoogleGenerativeAI | null = null;

  /**
   * `thinking` is the model's thinking level (GEMINI_THINKING: low, medium, high). Left out, the model uses its own
   * default, which for Gemini 4 Hydrogen is high: about four times the cost and the wait of low on a drawing reading.
   */
  constructor(private readonly model = process.env.VISION_MODEL ?? "gemini-2.0-flash-exp", private readonly thinking = process.env.GEMINI_THINKING || undefined) {
    this.id = `gemini-api:${model}${thinking ? `:thinking-${thinking}` : ""}`;
  }

  // Helper to convert JSON schema to Gemini format (remove unsupported fields)
  private convertSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    
    // Create a copy to avoid mutating the original
    const converted = Array.isArray(schema) ? [...schema] : { ...schema };
    
    // Remove unsupported fields
    delete converted.$schema;
    delete converted.additionalProperties;
    
    // Recursively process nested objects
    if (converted.properties) {
      const newProps: any = {};
      for (const [key, value] of Object.entries(converted.properties)) {
        newProps[key] = this.convertSchema(value);
      }
      converted.properties = newProps;
    }
    
    // Process arrays
    if (converted.items) {
      converted.items = this.convertSchema(converted.items);
    }
    
    // Process anyOf/oneOf/allOf
    if (converted.anyOf) {
      converted.anyOf = converted.anyOf.map((s: any) => this.convertSchema(s));
    }
    if (converted.oneOf) {
      converted.oneOf = converted.oneOf.map((s: any) => this.convertSchema(s));
    }
    if (converted.allOf) {
      converted.allOf = converted.allOf.map((s: any) => this.convertSchema(s));
    }
    
    return converted;
  }

  async ask(request: VisionRequest): Promise<VisionResult> {
    const key = await cacheKey(this.id, request);
    const cacheFile = join(cacheDir("vision"), `${key}.json`);
    const stored = await readJson<Omit<VisionResult, "cached">>(cacheFile);
    if (stored) return { ...stored, cached: true };

    if (!this.client) {
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY not set in environment");
      this.client = new GoogleGenerativeAI(apiKey);
    }

    const genModel = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: this.convertSchema(request.schema),
        // The SDK's types predate the thinking level; the API takes it.
        ...(this.thinking && ({ thinkingConfig: { thinkingLevel: this.thinking } } as object)),
      },
      systemInstruction: request.system.replace("Open the image with the Read tool before answering. ", "").replace("Open the image with the Read tool first. ", ""),
    });

    const parts: any[] = [{ text: request.prompt }];
    if (request.imagePath) {
      const { default: sharp } = await import("sharp");
      // Resize image to reasonable size
      const png = await sharp(request.imagePath)
        .resize({ width: API_IMAGE_LONG_SIDE, height: API_IMAGE_LONG_SIDE, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      
      parts.unshift({
        inlineData: {
          mimeType: "image/png",
          data: png.toString("base64"),
        },
      });
    }

    const started = Date.now();
    const result = await genModel.generateContent(parts);
    const response = result.response;
    
    if (!response.text()) {
      throw new Error(`No text in Gemini response`);
    }

    let output: Record<string, any>;
    try {
      output = JSON.parse(response.text());
    } catch (e) {
      throw new Error(`Failed to parse Gemini JSON response: ${response.text().slice(0, 300)}`);
    }

    // Calculate cost estimate
    const usage = response.usageMetadata;
    const [inputPrice, outputPrice] = API_PRICES[this.model] ?? [0, 0];
    const costUsd = usage 
      // Thinking tokens are billed as output.
      ? ((usage.promptTokenCount || 0) * inputPrice + ((usage.candidatesTokenCount || 0) + ((usage as { thoughtsTokenCount?: number }).thoughtsTokenCount || 0)) * outputPrice) / 1e6
      : 0;

    const visionResult = {
      output,
      seconds: (Date.now() - started) / 1000,
      costUsd,
    };
    
    await writeJsonAtomic(cacheFile, visionResult);
    return { ...visionResult, cached: false };
  }
}

/** The first way `value` departs from `schema` (type, required, properties, items, enum), or null when it conforms. */
export function schemaViolation(value: unknown, schema: Record<string, any>, path = "answer"): string | null {
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const allowed: string[] = schema.type === undefined ? [] : [schema.type].flat();
  if (allowed.length && !allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
    return `${path} is ${actual}, not ${allowed.join(" or ")}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} is not one of the allowed values`;
  if (actual === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) return `${path}.${key} is missing`;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const violation = key in object ? schemaViolation(object[key], property as Record<string, any>, `${path}.${key}`) : null;
      if (violation) return violation;
    }
  }
  if (actual === "array" && schema.items) {
    for (const [index, item] of (value as unknown[]).entries()) {
      const violation = schemaViolation(item, schema.items, `${path}[${index}]`);
      if (violation) return violation;
    }
  }
  return null;
}

/**
 * A model behind an OpenAI-compatible chat endpoint: an open vision model we serve ourselves (vLLM), or any server
 * speaking the same protocol. VISION_BASE_URL is the server, VISION_MODEL the name it serves, VISION_API_KEY optional.
 * VISION_IMAGE_MIN_SIDE enlarges drawings whose longer side is below that many pixels before they are sent.
 */
export class OpenAiCompatibleVision implements VisionModel {
  readonly id: string;
  private readonly endpoint: string;

  constructor(
    private readonly model = process.env.VISION_MODEL ?? "",
    baseUrl = process.env.VISION_BASE_URL ?? "",
    private readonly apiKey = process.env.VISION_API_KEY,
    private readonly minSide = Number(process.env.VISION_IMAGE_MIN_SIDE ?? 0),
    private readonly timeoutMs = 600_000,
  ) {
    if (!model || !baseUrl) throw new Error("VISION_PROVIDER=openai-compatible needs VISION_BASE_URL and VISION_MODEL");
    this.endpoint = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;
    // Whatever changes the answer belongs in the id, because the id is part of the cache key.
    this.id = `openai-compatible:${model}${minSide ? `:min${minSide}` : ""}`;
  }

  async ask(request: VisionRequest): Promise<VisionResult> {
    const cacheFile = join(cacheDir("vision"), `${await cacheKey(this.id, request)}.json`);
    const unusable = this.unusable.get(cacheFile);
    if (unusable) throw unusable;
    let called = false;
    const result = await cachedJson(cacheFile, () => {
      called = true;
      return this.call(request);
    }).catch((error) => {
      if (error instanceof UnusableAnswer) this.unusable.set(cacheFile, error);
      throw error;
    });
    return { ...result, cached: !called };
  }

  // At temperature 0 the same request gives the same unusable answer, and a runaway list costs minutes each time:
  // every question about one drawing would pay for it again. Kept for this process only; server errors are retried.
  private readonly unusable = new Map<string, UnusableAnswer>();

  private async image(imagePath: string): Promise<string> {
    const { default: sharp } = await import("sharp");
    const { width = 0, height = 0 } = await sharp(imagePath).metadata();
    const side = Math.max(API_IMAGE_LONG_SIDE, this.minSide);
    const enlarge = Math.max(width, height) < this.minSide;
    const png = await sharp(imagePath)
      .resize({ width: enlarge ? this.minSide : side, height: enlarge ? this.minSide : side, fit: "inside", withoutEnlargement: !enlarge }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  }

  private async call(request: VisionRequest): Promise<Omit<VisionResult, "cached">> {
    // Guided decoding enforces the schema's structure without showing it to the model, so the system turn carries it too.
    const system = `${request.system.replace("Open the image with the Read tool before answering. ", "").replace("Open the image with the Read tool first. ", "")}\n\n` +
      `Answer with one JSON object that follows this JSON schema: ${JSON.stringify(request.schema)}`;
    const user = request.imagePath
      ? [{ type: "image_url", image_url: { url: await this.image(request.imagePath) } }, { type: "text", text: request.prompt }]
      : request.prompt;

    const started = Date.now();
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: OPEN_MODEL_MAX_TOKENS,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name: "answer", schema: request.schema, strict: true } },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${this.id} answered ${response.status}: ${body.slice(0, 300)}`);
    let output: unknown;
    let choice: { finish_reason?: string; message?: { content?: string | null } } | undefined;
    try {
      choice = JSON.parse(body).choices?.[0];
      output = JSON.parse(choice?.message?.content ?? "");
    } catch {
      const reason = choice?.finish_reason === "length" ? "the answer was cut off at the token limit" : "the answer is not JSON";
      throw new UnusableAnswer(`${this.id}: ${reason}: ${(choice?.message?.content ?? body).slice(0, 300)}`);
    }
    const violation = schemaViolation(output, { ...request.schema, type: "object" });
    if (violation) throw new UnusableAnswer(`${this.id}: the answer does not follow the schema: ${violation}`);
    return { output: output as Record<string, any>, seconds: (Date.now() - started) / 1000, costUsd: 0 };
  }
}
/** The model answered, and the answer is cut off, not JSON, or not what the schema asks for. */
class UnusableAnswer extends Error {}

/** An inventory of a dense plan lists a few hundred positions; a runaway list stops here instead of running on. */
const OPEN_MODEL_MAX_TOKENS = 4096;

/**
 * No vision model: everything runs on this machine, image plans are answered by the local detectors alone.
 * A question that only a vision model can answer fails with a message saying so.
 */
export class NoVision implements VisionModel {
  readonly id = "none";
  async ask(): Promise<VisionResult> {
    throw new Error("This question needs a vision model, and the app is running with local models only (VISION_PROVIDER=none).");
  }
}

/**
 * VISION_PROVIDER picks the provider: "claude-cli" (default, local), "anthropic-api", "gemini-api",
 * "openai-compatible" (a model we serve ourselves), or "none" (local detectors only).
 */
export function createVision(): VisionModel {
  if (process.env.VISION_PROVIDER === "none") return new NoVision();
  if (process.env.VISION_PROVIDER === "openai-compatible") return new OpenAiCompatibleVision();
  if (process.env.VISION_PROVIDER === "anthropic-api") return new AnthropicApiVision();
  if (process.env.VISION_PROVIDER === "gemini-api") return new GeminiApiVision();
  return new ClaudeCliVision();
}

/**
 * The model that turns a free-form question into a structured call. PLANNER_MODEL names it; a small model is enough,
 * and without the variable the vision model does this too.
 */
export function createPlanner(): VisionModel | null {
  const model = process.env.PLANNER_MODEL;
  const provider = process.env.PLANNER_PROVIDER ?? process.env.VISION_PROVIDER;
  // Without a model, questions outside the fixed wording are not understood rather than failing.
  if (provider === "none") return null;
  
  if (!model && !provider) return createVision();
  
  if (provider === "anthropic-api") return new AnthropicApiVision(model);
  if (provider === "gemini-api") return new GeminiApiVision(model);
  if (provider === "openai-compatible") return new OpenAiCompatibleVision(model);
  // The tuned Gemma on this machine's CPU; PLANNER_MODEL may give the GGUF file.
  if (provider === "gemma-local") return new GemmaLocal(model && /\.gguf$/i.test(model) ? model : undefined);
  
  // Default to Claude CLI if no provider specified but model is set
  return new ClaudeCliVision(model, process.env.PLANNER_EFFORT);
}
