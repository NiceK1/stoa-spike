import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import type { Detection, Detector } from "../src/models/detector.js";
import { ChoiceError, createModes, type Probe } from "../src/modes.js";
import { ask } from "../src/router.js";

/** A server as the modes see it: its variables, whether the interpreter's weights are there, whether the claude CLI is installed. */
function server(env: Record<string, string> = {}, { weights = true, cli = false } = {}): Probe {
  return { env, exists: (path) => weights && path.endsWith(".gguf"), cliInstalled: () => cli };
}
const window = (x: number): Detection => ({ cls: "window", score: 0.9, x, y: 10, w: 20, h: 10 });
const weights = (name: string): Detector => ({ id: `onnx:${name}`, thresholds: { window: 0.5 }, detect: async () => [window(10), window(40), window(70)] });
/** The two detectors of the app behind one. */
const detector: Detector = { ...weights("floorplan-symbols-yolo11l-1280+floorplan-yolo11m-1280"), members: [weights("floorplan-symbols-yolo11l-1280"), weights("floorplan-yolo11m-1280")] };

const KEYS = { ANTHROPIC_API_KEY: "key", GEMINI_API_KEY: "key" };
/** What deploy/verda/fallback.sh sets. */
const DEMO = { ...KEYS, VISION_PROVIDER: "gemini-api", VISION_MODEL: "gemini-4-hydrogen", PLANNER_PROVIDER: "anthropic-api", PLANNER_MODEL: "claude-haiku-5-5" };
const OURS_ONLY = { VISION_PROVIDER: "none", PLANNER_PROVIDER: "gemma-local" };

const GEMMA = "gemma-local:interpreter-q8_0";
const HAIKU = "anthropic-api:claude-haiku-5-5";
const SONNET = "anthropic-api:claude-sonnet-5-5";
const GEMINI = "gemini-api:gemini-4-hydrogen:thinking-low";

/** The ids of the models a line-up runs with. */
function models(modes: ReturnType<typeof createModes>, choice?: Record<string, unknown>) {
  const { deps } = modes.resolve(choice);
  return { interpreter: deps.planner?.id ?? null, reader: deps.vision.id, text: deps.text.id, scope: deps.rasterScope, vote: deps.voteSymbols };
}
const available = (engines: { id: string; available: boolean }[]) => engines.filter((engine) => engine.available).map((engine) => engine.id);

describe("which engines can run on a server", () => {
  it("offers every outside engine through its API on the public demo, which has both keys and no CLI", () => {
    const modes = createModes(detector, server(DEMO));
    expect(modes.interpreters).toEqual([
      { id: "blueline", label: "Blueline interpreter (tuned Gemma)", name: GEMMA, tier: "own-model", outside: false, available: true },
      { id: "haiku", label: "Claude Haiku 5.5 (Anthropic)", name: HAIKU, tier: "external-model", outside: true, available: true },
      { id: "gemini", label: "Gemini 4 Hydrogen (Google)", name: GEMINI, tier: "external-model", outside: true, available: true },
      { id: "keywords", label: "Keyword parser only", name: "Keyword parser", tier: "script", outside: false, available: true },
    ]);
    expect(modes.readers).toEqual([
      { id: "none", label: "No outside reader", outside: false, available: true },
      { id: "gemini", label: "Gemini 4 Hydrogen (Google)", name: GEMINI, tier: "external-model", outside: true, available: true },
      { id: "sonnet", label: "Claude Sonnet 5.5 (Anthropic)", name: SONNET, tier: "external-model", outside: true, available: true },
    ]);
  });

  it("offers the Claude engines through the local CLI on a developer's PC without keys or variables", () => {
    const modes = createModes(detector, server({}, { cli: true }));
    expect(available(modes.interpreters)).toEqual(["blueline", "haiku", "keywords"]);
    expect(available(modes.readers)).toEqual(["none", "sonnet"]);
    expect(modes.interpreters[1].name).toBe("claude-cli:claude-haiku-5-5");
    expect(modes.readers[1]).toMatchObject({ id: "gemini", available: false, unavailable: "GEMINI_API_KEY is not set" });
  });

  it("has only the Blueline engines with VISION_PROVIDER=none and no keys, and says why the others cannot run", () => {
    // The CLI is installed, and still not offered: the server's variables do not name it.
    const modes = createModes(detector, server(OURS_ONLY, { cli: true }));
    expect(available(modes.interpreters)).toEqual(["blueline", "keywords"]);
    expect(available(modes.readers)).toEqual(["none"]);
    expect(modes.readers[2].unavailable).toBe("ANTHROPIC_API_KEY is not set, and the claude CLI is not the configured provider (VISION_PROVIDER=none)");
  });

  it("does not offer the CLI where it is not installed, and takes an empty key for no key", () => {
    const modes = createModes(detector, server({ GEMINI_API_KEY: " " }));
    expect(available(modes.readers)).toEqual(["none"]);
    expect(modes.interpreters[1].unavailable).toBe("ANTHROPIC_API_KEY is not set and the claude CLI was not found on the PATH");
  });

  it("keeps the CLI in use when a provider variable names it, although a key is set", () => {
    const modes = createModes(detector, server({ ...KEYS, VISION_PROVIDER: "claude-cli" }, { cli: true }));
    expect(models(modes, { mode: "custom", interpreter: "haiku", reader: "sonnet" })).toMatchObject({ interpreter: "claude-cli:claude-haiku-5-5", reader: "claude-cli:claude-sonnet-5-5" });
  });

  it("does not offer the Blueline interpreter when its weights file is missing", () => {
    const modes = createModes(detector, server(OURS_ONLY, { weights: false }));
    expect(modes.interpreters[0]).toMatchObject({ id: "blueline", available: false, unavailable: expect.stringContaining("its weights file is missing: ") });
    expect(models(modes).interpreter).toBeNull();
    expect(modes.resolve().info.lineup[0]).toMatchObject({ engines: [{ id: "keywords" }], note: expect.stringContaining("so the keyword parser reads the question") });
    expect(modes.resolve().deps.plannerAbsent).toContain("the Blueline interpreter cannot run here: its weights file is missing: ");
  });

  it("offers a reader we host ourselves in Custom, and Best accuracy does not choose it", () => {
    const modes = createModes(detector, server({ VISION_PROVIDER: "openai-compatible", VISION_BASE_URL: "http://10.0.0.5:8000", VISION_MODEL: "gemma-4-31b" }));
    expect(modes.readers.at(-1)).toEqual({ id: "self-hosted", label: "gemma-4-31b (self-hosted)", name: "openai-compatible:gemma-4-31b", tier: "self-hosted-model", outside: false, available: true });
    expect(models(modes, { mode: "best" }).reader).toBe("none");
    const custom = modes.resolve({ mode: "custom", reader: "self-hosted" });
    expect(custom.deps.vision.id).toBe("openai-compatible:gemma-4-31b");
    expect(custom.info).toMatchObject({ outside: false, summary: "No outside model is called. Image plans go to gemma-4-31b (self-hosted), which we host ourselves." });
    expect(modes.resolve().deps.advice).toEqual({ none: "none can run on this server", remedy: "The self-hosted reader, chosen in Custom, would answer it" });
  });
});

describe("Blueline only", () => {
  it("is what a request without a mode gets: our interpreter, our detectors for every kind, and no outside model although the keys are there", () => {
    const modes = createModes(detector, server(DEMO));
    expect(models(modes)).toEqual({ interpreter: GEMMA, reader: "none", text: "none", scope: "all", vote: false });
    expect(modes.resolve().mode).toBe("blueline");
    expect(modes.resolve({ mode: "blueline" }).info).toMatchObject({ label: "Blueline only", auto: false, editable: false, outside: false, summary: "Nothing leaves this server." });
  });

  it("tells a question it cannot answer which mode would, where that mode has an outside model", () => {
    expect(createModes(detector, server(DEMO)).resolve().deps.advice).toEqual({
      none: "Blueline only calls none", remedy: "Best accuracy, or a reader chosen in Custom, would answer it", retry: "best",
    });
    expect(createModes(detector, server(OURS_ONLY)).resolve().deps.advice).toEqual({ none: "none can run on this server" });
  });
});

describe("Best accuracy", () => {
  it("has Haiku understand, Gemini read, Sonnet word, and the symbols voted on, where both keys are set", () => {
    const modes = createModes(detector, server(DEMO));
    expect(models(modes, { mode: "best" })).toEqual({ interpreter: HAIKU, reader: GEMINI, text: SONNET, scope: "symbols", vote: true });
    expect(modes.resolve({ mode: "best" }).deps.advice).toBeUndefined();
  });

  it("falls back engine by engine on what can run", () => {
    const anthropic = createModes(detector, server({ ANTHROPIC_API_KEY: "key", VISION_PROVIDER: "none" }));
    expect(models(anthropic, { mode: "best" })).toEqual({ interpreter: HAIKU, reader: SONNET, text: SONNET, scope: "symbols", vote: true });
    const google = createModes(detector, server({ GEMINI_API_KEY: "key", VISION_PROVIDER: "none" }));
    expect(models(google, { mode: "best" })).toEqual({ interpreter: GEMINI, reader: GEMINI, text: GEMINI, scope: "symbols", vote: true });
    const cli = createModes(detector, server({}, { cli: true }));
    expect(models(cli, { mode: "best" })).toMatchObject({ interpreter: "claude-cli:claude-haiku-5-5", reader: "claude-cli:claude-sonnet-5-5", text: "claude-cli:claude-sonnet-5-5" });
  });

  it("resolves to the Blueline engines where no outside model can run, and says so", () => {
    const modes = createModes(detector, server(OURS_ONLY));
    expect(models(modes, { mode: "best" })).toEqual(models(modes));
    const { info, deps } = modes.resolve({ mode: "best" });
    expect(info.summary).toBe("No outside model can run on this server, so Best accuracy resolves to the Blueline engines. Nothing leaves this server.");
    expect(info.lineup.map((row) => row.engines.map((engine) => engine.id))).toEqual([["blueline"], ["detectors"], ["detectors"], []]);
    expect(info.lineup[1].note).toBe("the detector alone, as in Blueline only: no reader can run here to vote with");
    expect(deps.advice).toEqual({ none: "none can run on this server" });
  });

  it("runs every request with the same model instances", () => {
    const modes = createModes(detector, server(DEMO));
    const best = modes.resolve({ mode: "best" }).deps;
    expect(modes.resolve({ mode: "best" }).deps.vision).toBe(best.vision);
    expect(modes.resolve({ mode: "custom", interpreter: "gemini", reader: "gemini" }).deps).toMatchObject({ planner: best.vision, vision: best.vision });
    expect(modes.resolve({ mode: "custom", interpreter: "haiku" }).deps.planner).toBe(best.planner);
  });
});

describe("Custom", () => {
  const modes = createModes(detector, server(DEMO));

  it("starts as Blueline only, and offers Best accuracy for what it cannot answer without a reader", () => {
    const custom = modes.resolve({ mode: "custom" });
    expect(models(modes, { mode: "custom" })).toEqual(models(modes));
    expect(custom.info).toMatchObject({ editable: true, picks: { interpreter: "blueline", reader: "none" }, summary: "Nothing leaves this server." });
    expect(custom.deps.advice).toMatchObject({ none: "no reader is chosen in Custom", retry: "best" });
  });

  it("runs the interpreter and the reader the user picks: the detectors count the symbols, the reader the rest, and nothing is voted", () => {
    expect(models(modes, { mode: "custom", interpreter: "haiku", reader: "sonnet" })).toEqual({ interpreter: HAIKU, reader: SONNET, text: SONNET, scope: "symbols", vote: false });
    expect(models(modes, { mode: "custom", interpreter: "keywords", reader: "gemini" })).toEqual({ interpreter: null, reader: GEMINI, text: GEMINI, scope: "symbols", vote: false });
    expect(modes.resolve({ mode: "custom", interpreter: "keywords" }).deps.plannerAbsent).toBe("the keyword parser is the interpreter chosen in Custom");
    expect(modes.resolve({ mode: "custom", interpreter: "keywords", reader: "gemini" }).info.summary).toBe(
      "Outside models are called: image plans and building model facts and sheet text go to Gemini 4 Hydrogen (Google).",
    );
  });
});

describe("a choice the server cannot follow", () => {
  const refusal = (modes: ReturnType<typeof createModes>, choice: Record<string, unknown>) => {
    try {
      modes.resolve(choice);
    } catch (error) {
      if (error instanceof ChoiceError) return error.message;
      throw error;
    }
    return null;
  };
  const demo = createModes(detector, server(DEMO));
  const ours = createModes(detector, server(OURS_ONLY));

  it("is refused with a sentence that names the choices", () => {
    expect(refusal(demo, { mode: "fast" })).toBe("Unknown mode 'fast'. Choose one of: blueline (Blueline only), best (Best accuracy), custom (Custom).");
    expect(refusal(demo, { mode: 7 })).toContain("Unknown mode '7'.");
    expect(refusal(ours, { mode: "custom", interpreter: "gpt" })).toBe("Unknown interpreter 'gpt'. Choose one of: blueline, keywords.");
    expect(refusal(demo, { mode: "custom", reader: "haiku" })).toBe("Unknown reader 'haiku'. Choose one of: none, gemini, sonnet.");
  });

  it("is refused when the engine cannot run on this server, with the reason and what can", () => {
    expect(refusal(ours, { mode: "custom", reader: "gemini" })).toBe(
      "Gemini 4 Hydrogen (Google) cannot be the reader on this server: GEMINI_API_KEY is not set. Available: none (No outside reader).",
    );
    expect(refusal(ours, { mode: "custom", interpreter: "haiku" })).toContain("Claude Haiku 5.5 (Anthropic) cannot be the interpreter on this server: ANTHROPIC_API_KEY is not set");
    expect(() => ours.describe({ reader: "gemini" })).toThrow(ChoiceError);
  });

  it("reads the interpreter and the reader with Custom only", () => {
    expect(refusal(ours, { mode: "blueline", reader: "gemini" })).toBeNull();
    expect(models(demo, { mode: "best", interpreter: "keywords", reader: "none" })).toMatchObject({ interpreter: HAIKU, reader: GEMINI });
  });
});

describe("what the client draws the mode panel from", () => {
  const ours = { id: "detectors", label: "Blueline detector (trained YOLO11)", name: "floorplan-symbols-yolo11l-1280 + floorplan-yolo11m-1280", tier: "own-model", outside: false };
  const gemini = { id: "gemini", label: "Gemini 4 Hydrogen (Google)", name: GEMINI, tier: "external-model", outside: true };

  it("lists the three modes with Blueline only as the default, and each line-up in display order", () => {
    const info = createModes(detector, server(DEMO)).describe();
    expect(info.default).toBe("blueline");
    expect(info.modes.map((mode) => [mode.id, mode.label, mode.auto, mode.editable, mode.outside])).toEqual([
      ["blueline", "Blueline only", false, false, false], ["best", "Best accuracy", true, false, true], ["custom", "Custom", false, true, false],
    ]);
    expect(info.modes[0].lineup).toEqual([
      { role: "interpreter", title: "Understands the question", engines: [{ id: "blueline", label: "Blueline interpreter (tuned Gemma)", name: GEMMA, tier: "own-model", outside: false }] },
      { role: "symbols", title: "Counts the drawn symbols on image plans", engines: [ours] },
      { role: "reader", title: "Reads room types, storeys and anything else on image plans", engines: [ours], note: "room types and storeys only; a question about anything else gets no value" },
      { role: "text", title: "Words answers from building model facts and sheet text", engines: [], note: "nobody: such a question gets no value" },
    ]);
    expect(info.modes[1].lineup).toEqual([
      { role: "interpreter", title: "Understands the question", engines: [{ id: "haiku", label: "Claude Haiku 5.5 (Anthropic)", name: HAIKU, tier: "external-model", outside: true }] },
      {
        role: "symbols", title: "Counts the drawn symbols on image plans", engines: [ours, gemini],
        note: "the middle of 3 independent counts: each of the 2 detectors and the reader's inventory of the drawing",
      },
      { role: "reader", title: "Reads room types, storeys and anything else on image plans", engines: [gemini] },
      { role: "text", title: "Words answers from building model facts and sheet text", engines: [{ id: "sonnet", label: "Claude Sonnet 5.5 (Anthropic)", name: SONNET, tier: "external-model", outside: true }] },
    ]);
    expect(info.modes[1].summary).toBe(
      "Outside models are called: questions go to Claude Haiku 5.5 (Anthropic); image plans go to Gemini 4 Hydrogen (Google); building model facts and sheet text go to Claude Sonnet 5.5 (Anthropic).",
    );
  });

  it("describes Custom for the choices it is asked about", () => {
    const custom = createModes(detector, server(DEMO)).describe({ interpreter: "gemini", reader: "sonnet" }).modes[2];
    expect(custom).toMatchObject({ picks: { interpreter: "gemini", reader: "sonnet" }, outside: true });
    expect(custom.lineup.map((row) => row.engines.map((engine) => engine.id))).toEqual([["gemini"], ["detectors"], ["sonnet"], ["sonnet"]]);
  });

  it("says that nothing counts on an image plan when no detector weights are installed", () => {
    const { lineup } = createModes(null, server(OURS_ONLY)).resolve().info;
    expect(lineup[1]).toMatchObject({ engines: [], note: "no detector weights are installed: a count on an image plan gets no value" });
    expect(lineup[2]).toMatchObject({ engines: [], note: "nobody: such a question gets no value" });
  });
});

describe("a question the line-up has no outside model for", () => {
  let drawing = "";
  beforeAll(async () => {
    drawing = join(mkdtempSync(join(tmpdir(), "modes-test-")), "plan.png");
    await sharp({ create: { width: 200, height: 100, channels: 3, background: "#ffffff" } }).png().toFile(drawing);
  });
  const STAIRS = "How many staircases are on this floor plan?";
  const asked = (env: Record<string, string>, question: string, mode?: string) =>
    ask({ file: drawing, question }, { ...createModes(detector, server(env)).resolve({ mode }).deps, interpreter: "templates", fileUrl: () => "/plan.png" });

  it("gets no value in Blueline only, the mode that would answer it, and the offer to ask again there", async () => {
    const answer = await asked(DEMO, STAIRS);
    expect(answer).toMatchObject({ value: null, pipeline: "none", retry: { mode: "best" } });
    expect(answer.source.needed).toBe(
      "an outside vision model is needed, because our detectors do not know this kind of item; Blueline only calls none. Best accuracy, or a reader chosen in Custom, would answer it",
    );
    expect(answer.note).toBe(
      "No answer: this question needs an outside vision model, because our detectors do not know this kind of item, and Blueline only calls none. Best accuracy, or a reader chosen in Custom, would answer it.",
    );
  });

  it("carries no offer where no mode has an outside model", async () => {
    for (const mode of ["blueline", "best", "custom"]) {
      const answer = await asked(OURS_ONLY, STAIRS, mode);
      expect(answer.value, mode).toBeNull();
      expect(answer.retry, mode).toBeUndefined();
      expect(answer.source.needed, mode).toBe("an outside vision model is needed, because our detectors do not know this kind of item; none can run on this server");
    }
  });

  it("still counts what the detectors know, with no offer", async () => {
    const answer = await asked(DEMO, "How many windows are shown on this floor plan?");
    expect(answer).toMatchObject({ value: 3, pipeline: "detector" });
    expect(answer.retry).toBeUndefined();
  });
});
