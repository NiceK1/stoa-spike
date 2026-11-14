/**
 * Vision model behind one interface, so the provider can be swapped (local `claude` CLI now, an HTTP API later).
 * Every provider gets an image, a system prompt, a user prompt and a JSON schema, and returns an object matching the schema.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "../cache.js";
import { cacheDir } from "../config.js";

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

async function cacheKey(id: string, request: VisionRequest): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify([id, request.system, request.prompt, request.schema]));
  if (request.imagePath) hash.update(await readFile(request.imagePath));
  return hash.digest("hex").slice(0, 32);
}

function run(command: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
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

/** VISION_PROVIDER picks the provider: "claude-cli" (default, local) or "anthropic-api". */
export function createVision(): VisionModel {
  return process.env.VISION_PROVIDER === "anthropic-api" ? new AnthropicApiVision() : new ClaudeCliVision();
}

/**
 * The model that turns a free-form question into a structured call. PLANNER_MODEL names it; a small model is enough,
 * and without the variable the vision model does this too.
 */
export function createPlanner(): VisionModel {
  const model = process.env.PLANNER_MODEL;
  if (!model) return createVision();
  return process.env.VISION_PROVIDER === "anthropic-api" ? new AnthropicApiVision(model) : new ClaudeCliVision(model, process.env.PLANNER_EFFORT);
}
