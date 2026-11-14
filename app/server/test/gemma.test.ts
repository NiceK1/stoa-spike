import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GemmaLocal, completionJson, grammarSchema, renderPrompt, schemaHint, turns } from "../src/models/gemma.js";
import { createPlanner } from "../src/models/vision.js";
import { rasterRequest } from "../src/planner.js";
import { ask } from "../src/router.js";
import { RASTER_KINDS } from "../src/solvers/raster.js";

const SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["count", "none"] },
    labels: { type: "array", items: { type: "string", enum: Array.from({ length: 20 }, (_, i) => `Label ${i}`) } },
    storey: { type: "string", enum: ["Level 1", ""] },
    rooms: { type: "array", items: { type: "string" } },
    locate: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["operation", "labels", "storey", "rooms", "locate", "reason"],
  additionalProperties: false,
};

describe("the prompt of the local interpreter", () => {
  it("puts the drawing's menu in front of the question, so that questions about one drawing share it", () => {
    const { developer, user } = turns({ system: "You translate a question.\nMany rules follow.", schema: SCHEMA, prompt: "Question: how many doors?\nA keyword parser reads this as: count all doors.\n\nSymbols: 3 doors\nApartments: A" });
    expect(developer).toBe(`You translate a question.\n${schemaHint(SCHEMA)}\n\nSymbols: 3 doors\nApartments: A`);
    expect(user).toBe("Question: how many doors?\nA keyword parser reads this as: count all doors.");
  });

  it("keeps a question that holds a blank line whole", () => {
    const { developer, user } = turns({ system: "Instruction.", schema: SCHEMA, prompt: "Question: first\n\nsecond\n\nMenu line" });
    expect(user).toBe("Question: first\n\nsecond");
    expect(developer.endsWith("\n\nMenu line")).toBe(true);
  });

  it("is FunctionGemma's chat template without the BOS the runtime adds", () => {
    expect(renderPrompt({ developer: "D", user: "U" })).toBe("<start_of_turn>developer\nD<end_of_turn>\n<start_of_turn>user\nU<end_of_turn>\n<start_of_turn>model\n");
  });

  it("is the same for the request the planner builds", () => {
    const { developer, user } = turns(rasterRequest("where is the sauna", RASTER_KINDS, null));
    expect(user).toBe("Question: where is the sauna");
    expect(developer).toContain("Call: operation count_known|count_other|read; targets [window|door|");
    expect(developer).toContain("\n\nKinds for count_known:\n- window: windows\n");
  });

  it("names the fields in order with their fixed choices, and leaves a drawing's long vocabulary to the menu", () => {
    expect(schemaHint(SCHEMA)).toBe("Call: operation count|none; labels [from the menu]; storey Level 1|''; rooms []; locate true|false; reason text");
  });

  it("writes a call compactly with the keys in schema order", () => {
    expect(completionJson({ reason: "", locate: false, rooms: [], storey: "", labels: ["Küche"], operation: "count" }, SCHEMA))
      .toBe('{"operation":"count","labels":["Küche"],"storey":"","rooms":[],"locate":false,"reason":""}');
  });
});

describe("the grammar of the local interpreter", () => {
  it("keeps what the grammar builder takes and an empty string among the choices", () => {
    expect(grammarSchema(SCHEMA)).toEqual({
      type: "object",
      properties: {
        operation: { enum: ["count", "none"] },
        labels: { type: "array", items: { enum: SCHEMA.properties.labels.items.enum } },
        storey: { enum: ["Level 1", ""] },
        rooms: { type: "array", items: { type: "string" } },
        locate: { type: "boolean" },
        reason: { type: "string" },
      },
    });
  });
});

describe("the local interpreter without its model file", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is chosen with PLANNER_PROVIDER=gemma-local, and PLANNER_MODEL may name the file", () => {
    vi.stubEnv("PLANNER_PROVIDER", "gemma-local");
    vi.stubEnv("PLANNER_MODEL", "C:/models/tuned-q8_0.gguf");
    expect(createPlanner()?.id).toBe("gemma-local:tuned-q8_0");
    vi.stubEnv("PLANNER_MODEL", "claude-haiku-5-5");
    expect(createPlanner()?.id).toBe("gemma-local:interpreter-q8_0");
  });

  it("fails with a message that names the file", async () => {
    const missing = join(tmpdir(), "no-such-model.gguf");
    await expect(new GemmaLocal(missing).ask({ system: "s", prompt: "p", schema: SCHEMA })).rejects.toThrow(/no-such-model\.gguf is missing/);
  });

  it("leaves the question to the keyword parser, and the answer says so", async () => {
    const rect = (x: number, y: number, w: number, h: number) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const polyline = (layer: string, points: number[][]) => `0\nLWPOLYLINE\n8\n${layer}\n90\n${points.length}\n70\n1\n${points.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join("")}`;
    const plan = join(mkdtempSync(join(tmpdir(), "gemma-test-")), "floor.dxf");
    writeFileSync(plan, `0\nSECTION\n2\nENTITIES\n${polyline("ROOM_OUTLINE", rect(0, 0, 4, 3))}0\nTEXT\n8\nROOM_TEXT\n10\n2\n20\n1.8\n1\nZimmer\n${polyline("DOOR", rect(3.9, 1, 0.2, 0.8))}0\nENDSEC\n0\nEOF\n`);
    const vision = { id: "fake-vision", ask: async () => ({ output: {}, seconds: 0, costUsd: 0, cached: false }) };
    const answer = await ask({ file: plan, question: "How many doors are drawn on this floor plan?" }, { vision, planner: new GemmaLocal(join(tmpdir(), "no-such-model.gguf")), detector: null, fileUrl: () => "" });
    expect(answer.value).toBe(1);
    expect(answer.method).toMatch(/^read by the keyword parser \(the interpreter gemma-local:no-such-model gave no usable call: the model file .*is missing/);
  });
});
