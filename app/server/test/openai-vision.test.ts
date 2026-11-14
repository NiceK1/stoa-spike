import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleVision, createPlanner, createVision, schemaViolation } from "../src/models/vision.js";

const SCHEMA = {
  type: "object",
  properties: {
    floors: { type: "integer" },
    kitchens: { type: "array", items: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] } },
  },
  required: ["floors", "kitchens"],
  additionalProperties: false,
};

type Reply = { content?: string; finish?: string; status?: number; text?: string };

/** A fetch that answers every call with `reply` (a chat completion, or a status with a body) and records the requests. */
function fakeFetch(reply: Reply) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const text = reply.text ?? JSON.stringify({ choices: [{ finish_reason: reply.finish ?? "stop", message: { role: "assistant", content: reply.content } }] });
    return new Response(text, { status: reply.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

// The disk cache is shared with real runs, so every test asks something no run has asked.
const fresh = () => ({
  system: "You take an inventory. Open the image with the Read tool before answering. Be exact.",
  prompt: `inventory ${randomUUID()}`,
  schema: SCHEMA,
});

async function drawing(width: number, height: number): Promise<string> {
  const file = join(mkdtempSync(join(tmpdir(), "openai-vision-")), "plan.png");
  await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toFile(file);
  return file;
}

describe("OpenAI-compatible vision provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts the system and user turns with the image and the schema, and returns the validated answer", async () => {
    const { calls } = fakeFetch({ content: '{"floors":2,"kitchens":[{"x":410,"y":520}]}' });
    const model = new OpenAiCompatibleVision("gemma-4-12b-it", "http://127.0.0.1:8100/v1/", "secret");
    const request = { ...fresh(), imagePath: await drawing(40, 30) };

    const result = await model.ask(request);

    expect(result.output).toEqual({ floors: 2, kitchens: [{ x: 410, y: 520 }] });
    expect(result.cached).toBe(false);
    expect(result.costUsd).toBe(0);
    expect(result.seconds).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    const { url, headers, body } = calls[0];
    expect(url).toBe("http://127.0.0.1:8100/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer secret");
    expect(body.model).toBe("gemma-4-12b-it");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "answer", schema: SCHEMA, strict: true } });
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(body.messages[0].content).toContain("You take an inventory. Be exact.");
    expect(body.messages[0].content).toContain(JSON.stringify(SCHEMA));
    const [image, text] = body.messages[1].content;
    expect(image.image_url.url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    expect(text).toEqual({ type: "text", text: request.prompt });
  });

  it("answers the same request from the disk cache without calling the server again", async () => {
    const { fetchMock } = fakeFetch({ content: '{"floors":1,"kitchens":[]}' });
    const request = fresh();

    const first = await new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test").ask(request);
    const second = await new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test").ask(request);
    const otherModel = await new OpenAiCompatibleVision("gemma-4-31b-it", "http://vlm.test").ask(request);

    expect(first.cached).toBe(false);
    expect(second).toEqual({ ...first, cached: true });
    expect(otherModel.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a question without a drawing as plain text and no key header", async () => {
    const { calls } = fakeFetch({ content: '{"floors":0,"kitchens":[]}' });
    const request = fresh();

    await new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test", undefined).ask(request);

    expect(calls[0].url).toBe("http://vlm.test/v1/chat/completions");
    expect(calls[0].body.messages[1].content).toBe(request.prompt);
    expect(calls[0].headers).not.toHaveProperty("authorization");
  });

  it("enlarges a small drawing to the configured side and leaves it alone otherwise", async () => {
    const { calls } = fakeFetch({ content: '{"floors":1,"kitchens":[]}' });
    const imagePath = await drawing(400, 200);
    const sentWidth = async (call: number) => {
      const base64 = calls[call].body.messages[1].content[0].image_url.url.split(",")[1];
      return (await sharp(Buffer.from(base64, "base64")).metadata()).width;
    };

    await new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test", undefined, 0).ask({ ...fresh(), imagePath });
    await new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test", undefined, 1600).ask({ ...fresh(), imagePath });

    expect(await sentWidth(0)).toBe(400);
    expect(await sentWidth(1)).toBe(1600);
  });

  const unusable: [string, Reply, RegExp][] = [
    ["an answer that misses a required field", { content: '{"floors":1}' }, /kitchens is missing/],
    ["a field of the wrong type", { content: '{"floors":"two","kitchens":[]}' }, /floors is string, not integer/],
    ["an answer cut off at the token limit", { content: '{"floors":1,"kitchens":[{"x":1,', finish: "length" }, /cut off/],
    ["text that is not JSON", { content: "There are two floors." }, /not JSON/],
  ];
  it.each(unusable)("fails on %s, asks the server once per process, and keeps it off the disk", async (_name, reply, message) => {
    const { fetchMock } = fakeFetch(reply);
    const model = new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test");
    const request = fresh();

    await expect(model.ask(request)).rejects.toThrow(message);
    await expect(model.ask(request)).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test").ask(request)).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks again after a server error", async () => {
    const { fetchMock } = fakeFetch({ status: 500, text: "CUDA out of memory" });
    const model = new OpenAiCompatibleVision("gemma-4-12b-it", "http://vlm.test");
    const request = fresh();

    await expect(model.ask(request)).rejects.toThrow(/500: CUDA out of memory/);
    await expect(model.ask(request)).rejects.toThrow(/500: CUDA out of memory/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is selected by VISION_PROVIDER for the vision model and the interpreter", () => {
    vi.stubEnv("VISION_PROVIDER", "openai-compatible");
    vi.stubEnv("VISION_BASE_URL", "http://127.0.0.1:8100");
    vi.stubEnv("VISION_MODEL", "gemma-4-12b-it");
    vi.stubEnv("VISION_IMAGE_MIN_SIDE", "");
    vi.stubEnv("PLANNER_PROVIDER", "");
    vi.stubEnv("PLANNER_MODEL", "");

    expect(createVision()).toBeInstanceOf(OpenAiCompatibleVision);
    expect(createVision().id).toBe("openai-compatible:gemma-4-12b-it");
    expect(createPlanner()).toBeInstanceOf(OpenAiCompatibleVision);
  });

  it("says what is missing when the server or the model is not configured", () => {
    vi.stubEnv("VISION_PROVIDER", "openai-compatible");
    vi.stubEnv("VISION_BASE_URL", "");
    vi.stubEnv("VISION_MODEL", "gemma-4-12b-it");

    expect(() => createVision()).toThrow(/VISION_BASE_URL and VISION_MODEL/);
  });
});

describe("schemaViolation", () => {
  it("accepts a conforming value, an integer where a number is asked, and null where it is allowed", () => {
    expect(schemaViolation({ floors: 1, kitchens: [{ x: 1, y: 2 }] }, SCHEMA)).toBeNull();
    const nullable = { type: "object", properties: { value: { type: ["number", "null"] }, unit: { type: ["string", "null"] } } };
    expect(schemaViolation({ value: 3, unit: null }, nullable)).toBeNull();
  });

  it("names the place of the first violation", () => {
    expect(schemaViolation({ floors: 1, kitchens: [{ x: 1, y: 2 }, { x: 1.5, y: 2 }] }, SCHEMA)).toBe("answer.kitchens[1].x is number, not integer");
    expect(schemaViolation([], SCHEMA)).toBe("answer is array, not object");
    expect(schemaViolation("b", { enum: ["a"] })).toBe("answer is not one of the allowed values");
  });
});
