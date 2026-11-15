import { describe, expect, it } from "vitest";
import { askFields, callsOutside, describeChoice, hintOf, measuredOf, modeOf, parseChoice, settle, understandsFreeWording, type ModesInfo } from "../../web/src/modes.js";
import type { Detector } from "../src/models/detector.js";
import { createModes } from "../src/modes.js";

const weights = (name: string): Detector => ({ id: `onnx:${name}`, thresholds: {}, detect: async () => [] });
const detector: Detector = { ...weights("floorplan-symbols-yolo11l-1280+floorplan-yolo11m-1280"), members: [weights("floorplan-symbols-yolo11l-1280"), weights("floorplan-yolo11m-1280")] };

/** What GET /api/modes sends from a server with these variables, optionally with Custom described for some picks. */
function listing(env: Record<string, string>, picks?: { interpreter?: string; reader?: string }): ModesInfo {
  return createModes(detector, { env, exists: (path) => path.endsWith(".gguf"), cliInstalled: () => false }).describe(picks);
}
const DEMO = listing({ ANTHROPIC_API_KEY: "key", GEMINI_API_KEY: "key" });
const OURS_ONLY = listing({ VISION_PROVIDER: "none", PLANNER_PROVIDER: "gemma-local" });

const mode = (info: ModesInfo, id: string) => modeOf(info, id)!;

describe("the choice the browser remembers", () => {
  it("is kept when every part of it can run on this server", () => {
    const stored = parseChoice('{"mode":"custom","interpreter":"haiku","reader":"gemini"}');
    expect(settle(stored, DEMO)).toEqual({ choice: { mode: "custom", interpreter: "haiku", reader: "gemini" } });
  });

  it("gives way to the server's default when a pick cannot run here, and names what was dropped", () => {
    const stored = parseChoice('{"mode":"custom","interpreter":"haiku","reader":"gemini"}');
    const { choice, dropped } = settle(stored, OURS_ONLY);
    expect(choice).toEqual({ mode: "blueline" });
    expect(describeChoice(OURS_ONLY, dropped!)).toBe("Custom with Claude Haiku 5.5 (Anthropic) and Gemini 4 Hydrogen (Google)");
  });

  it("keeps Best accuracy on a server with no outside model, where it resolves to the Blueline engines", () => {
    expect(settle({ mode: "best" }, OURS_ONLY)).toEqual({ choice: { mode: "best" } });
    expect(callsOutside(OURS_ONLY, { mode: "best" })).toBe(false);
    expect(hintOf(OURS_ONLY, { mode: "best" })).toBe("auto: no outside model here");
  });

  it("forgets picks that cannot run here without a word while a mode without pickers is chosen", () => {
    expect(settle({ mode: "blueline", interpreter: "haiku", reader: "gemini" }, OURS_ONLY)).toEqual({ choice: { mode: "blueline" } });
  });

  it("starts from the server's default with nothing stored, with damaged text or with a mode the server does not know", () => {
    expect(settle(parseChoice(null), DEMO)).toEqual({ choice: { mode: "blueline" } });
    expect(parseChoice("not json")).toBeNull();
    expect(parseChoice('{"mode":7}')).toBeNull();
    expect(settle({ mode: "fast" }, DEMO)).toEqual({ choice: { mode: "blueline" }, dropped: { mode: "fast" } });
  });
});

describe("what goes to the server with a question", () => {
  it("sends the picks only with the mode that reads them", () => {
    expect(askFields(DEMO, { mode: "blueline", interpreter: "haiku", reader: "gemini" })).toEqual({ mode: "blueline" });
    expect(askFields(DEMO, { mode: "custom", interpreter: "haiku", reader: "gemini" })).toEqual({ mode: "custom", interpreter: "haiku", reader: "gemini" });
  });

  it("fills in the server's picks when Custom is chosen before anything is picked", () => {
    expect(askFields(DEMO, { mode: "custom" })).toEqual({ mode: "custom", interpreter: "blueline", reader: "none" });
  });
});

describe("what the pill says about a choice", () => {
  it("knows before asking whether a question may go to an outside model", () => {
    expect(callsOutside(DEMO, { mode: "blueline" })).toBe(false);
    expect(callsOutside(DEMO, { mode: "best" })).toBe(true);
    expect(callsOutside(DEMO, { mode: "custom" })).toBe(false);
    expect(callsOutside(DEMO, { mode: "custom", interpreter: "keywords", reader: "sonnet" })).toBe(true);
    expect(callsOutside(DEMO, { mode: "custom", interpreter: "haiku", reader: "none" })).toBe(true);
  });

  it("adds a few words to the mode's name", () => {
    expect(hintOf(DEMO, { mode: "blueline" })).toBe("nothing leaves this server");
    expect(hintOf(DEMO, { mode: "best" })).toBe("auto: best model per question");
    expect(hintOf(DEMO, { mode: "custom" })).toBe("Blueline interpreter + no outside reader");
    expect(hintOf(DEMO, { mode: "custom", interpreter: "haiku", reader: "gemini" })).toBe("Claude Haiku 5.5 + Gemini 4 Hydrogen");
  });
});

describe("what the panel says about a line-up", () => {
  it("gives the measured result of the line-ups that were measured, and none for the others", () => {
    expect(measuredOf(mode(DEMO, "blueline"))?.share).toBe("85.9%");
    expect(measuredOf(mode(DEMO, "best"))?.share).toBe("89.0%");
    const withGemini = listing({ ANTHROPIC_API_KEY: "key", GEMINI_API_KEY: "key" }, { reader: "gemini" });
    expect(measuredOf(mode(withGemini, "custom"))?.share).toBe("87.7%");
    const withSonnet = listing({ ANTHROPIC_API_KEY: "key", GEMINI_API_KEY: "key" }, { reader: "sonnet" });
    expect(measuredOf(mode(withSonnet, "custom"))).toBeNull();
    // No Gemini key: Best accuracy reads with Claude Sonnet, which was not measured.
    expect(measuredOf(mode(listing({ ANTHROPIC_API_KEY: "key" }), "best"))).toBeNull();
    expect(measuredOf(mode(OURS_ONLY, "best"))?.share).toBe("85.9%");
  });

  it("offers free wording only where a model reads the question", () => {
    expect(understandsFreeWording(mode(DEMO, "blueline"))).toBe(true);
    expect(understandsFreeWording(mode(listing({}, { interpreter: "keywords" }), "custom"))).toBe(false);
  });
});
