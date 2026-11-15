import { describe, expect, it } from "vitest";
import { explainFailure } from "../src/failure.js";
import { SCHEMA as JUDGE_SCHEMA } from "../src/judge.js";
import { geminiOutput, geminiSchema } from "../src/models/vision.js";
import { rasterRequest } from "../src/planner.js";
import { SCHEMA as REWRITE_SCHEMA } from "../src/rewrite.js";
import { SCHEMA as SHEET_SCHEMA } from "../src/solvers/document.js";
import { ANSWER_SCHEMA, SELECT_SCHEMA } from "../src/solvers/ifc/digest.js";
import { COUNT_SCHEMA, FREE_SCHEMA, INVENTORY_SCHEMA } from "../src/solvers/raster.js";

/** What Gemini's response schema refuses, found anywhere in a schema: a list of types, an empty enum value, a keyword it does not know. */
function refused(schema: any, path = "schema"): string[] {
  if (Array.isArray(schema)) return schema.flatMap((each, i) => refused(each, `${path}[${i}]`));
  if (!schema || typeof schema !== "object") return [];
  const found: string[] = [];
  if (Array.isArray(schema.type)) found.push(`${path}.type is a list`);
  if (Array.isArray(schema.enum) && schema.enum.includes("")) found.push(`${path}.enum has an empty value`);
  for (const keyword of ["$schema", "additionalProperties"]) if (keyword in schema) found.push(`${path}.${keyword}`);
  for (const [key, value] of Object.entries(schema.properties ?? {})) found.push(...refused(value, `${path}.${key}`));
  for (const key of ["items", "anyOf", "oneOf", "allOf"]) found.push(...refused(schema[key], `${path}.${key}`));
  return found;
}

describe("a schema as Gemini takes it", () => {
  it("says 'or null' as nullable and keeps one type", () => {
    expect(geminiSchema({ type: "object", properties: { value: { type: ["number", "null"] }, unit: { type: "string" } }, additionalProperties: false })).toEqual({
      type: "object", properties: { value: { type: "number", nullable: true }, unit: { type: "string" } },
    });
  });

  it("gives an empty enum value a stand-in and turns it back in the answer", () => {
    const storey = geminiSchema({ type: "string", enum: ["Level 1", ""] });
    expect(storey.enum).toEqual(["Level 1", "(none)"]);
    expect(geminiOutput({ storey: "(none)", elements: ["door"], rooms: [{ name: "(none)" }], locate: false })).toEqual({ storey: "", elements: ["door"], rooms: [{ name: "" }], locate: false });
  });

  it("leaves nothing Gemini refuses in any answer format the app sends", () => {
    const sent = {
      inventory: INVENTORY_SCHEMA, count: COUNT_SCHEMA, free: FREE_SCHEMA, sheet: SHEET_SCHEMA, select: SELECT_SCHEMA, facts: ANSWER_SCHEMA,
      judge: JUDGE_SCHEMA, rewrite: REWRITE_SCHEMA, raster: rasterRequest("how many doors?", []).schema,
      // The menu of an IFC model offers the empty string for "the whole model".
      storey: { type: "object", properties: { storey: { type: "string", enum: ["Level 1", ""] } }, required: ["storey"], additionalProperties: false },
    };
    // The formats as written do hold what Gemini refuses, or this test would prove nothing.
    expect(Object.values(sent).flatMap((schema) => refused(schema)).length).toBeGreaterThan(0);
    for (const [name, schema] of Object.entries(sent)) expect(refused(geminiSchema(schema)), name).toEqual([]);
  });
});

describe("what a failed answer says", () => {
  it("names the outside model in one sentence and keeps the provider's message as detail", () => {
    const raw = "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent: [400 Bad Request] Invalid JSON payload received. " + "x".repeat(600);
    const failure = explainFailure(new Error(raw));
    expect(failure.error).toBe("The outside model Gemini 4 Hydrogen (Google) did not answer this question. Ask again, or switch to Blueline only, which does not call it.");
    expect(failure.detail).toHaveLength(300);
  });

  it("passes on a short message of our own as it is, and cuts a long one", () => {
    expect(explainFailure(new Error("file is outside the served folders"))).toEqual({ error: "file is outside the served folders" });
    const long = explainFailure(new Error("y".repeat(500)));
    expect(long.error.length).toBeLessThanOrEqual(200);
    expect(long.detail).toHaveLength(300);
  });
});
