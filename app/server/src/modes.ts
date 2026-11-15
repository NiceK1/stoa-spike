/**
 * The modes of the ask window. A mode says which engine does each job: who understands the question, who counts the
 * drawn symbols on an image plan, who reads room types and everything else on it, and who words an answer from a
 * building model's facts or a sheet's text. One mode holds for a whole request and is resolved here into the Deps the
 * pipelines run with.
 *
 * - Blueline only (the default): the Blueline interpreter, the Blueline detectors and the scripts. No outside model.
 * - Best accuracy: the most capable engine for each job, picked from what can run on this server.
 * - Custom: the user picks the interpreter and the reader.
 *
 * Which engines can run here is derived once, when the server starts:
 * - the Blueline interpreter: its GGUF file is there (models/interpreter/interpreter-q8_0.gguf, or the file that
 *   PLANNER_MODEL names with PLANNER_PROVIDER=gemma-local);
 * - Claude Haiku 5.5 and Claude Sonnet 5.5: through the API when ANTHROPIC_API_KEY is set; through the local `claude`
 *   CLI when that is the configured provider (VISION_PROVIDER unset or claude-cli, or PLANNER_PROVIDER=claude-cli) and
 *   the executable is on the PATH. A provider variable that names claude-cli keeps the CLI in use although a key is set;
 * - Gemini 4 Hydrogen: GEMINI_API_KEY is set;
 * - a reader we host ourselves: VISION_PROVIDER=openai-compatible with VISION_BASE_URL and VISION_MODEL. It is offered
 *   in Custom and never chosen by Best accuracy;
 * - the Blueline detectors: the detector the caller hands in (createDetector: the weights in ../models).
 * VISION_PROVIDER=none therefore only says that the CLI is not to be used: a key still makes its engines available.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Detector } from "./models/detector.js";
import { DEFAULT_GEMMA_PATH, GemmaLocal } from "./models/gemma.js";
import { AnthropicApiVision, ClaudeCliVision, GeminiApiVision, NoVision, OpenAiCompatibleVision, type VisionModel } from "./models/vision.js";
import type { Deps } from "./router.js";
import { INTERPRETER_LABEL, SCRIPTS, labelOf, tierOf } from "./source.js";
import type { ModeId, OutsideAdvice, SourceTier } from "./types.js";

export const DEFAULT_MODE: ModeId = "blueline";

const MODES: { id: ModeId; label: string; description: string }[] = [
  { id: "blueline", label: "Blueline only", description: "Only the models we trained and run ourselves, and our scripts. A question they cannot answer gets no value, and the reason." },
  { id: "best", label: "Best accuracy", description: "The most capable engine for each job, chosen by the server from what can run here." },
  { id: "custom", label: "Custom", description: "You pick who understands the question and which outside model reads the drawing." },
];
const labelOfMode = (id: ModeId) => MODES.find((mode) => mode.id === id)!.label;

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const GEMINI = "gemini-4-hydrogen";

/** What the availability of the engines is read from; the tests put their own in its place. */
export interface Probe {
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  /** Whether the `claude` executable is on the PATH. */
  cliInstalled(): boolean;
}

function systemProbe(): Probe {
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  return {
    env: process.env,
    exists: existsSync,
    cliInstalled: () => (process.env.PATH ?? "").split(delimiter).some((folder) => folder !== "" && existsSync(join(folder, executable))),
  };
}

/** An engine as the client shows it. */
export interface EngineRef {
  id: string;
  label: string;
  /** The id answers name it by, or the weights of a detector; secondary text next to the label. */
  name?: string;
  tier?: SourceTier;
  /** A model outside: the question or the drawing leaves this server when it is used. */
  outside: boolean;
}

/** An engine the user can pick in Custom. */
export interface Engine extends EngineRef {
  available: boolean;
  /** Why it cannot run on this server, as a sentence without its full stop. */
  unavailable?: string;
}

export type LineupRole = "interpreter" | "symbols" | "reader" | "text";

export interface LineupRow {
  role: LineupRole;
  title: string;
  /** Who does the job; empty when nobody does and a question of this kind gets no value. */
  engines: EngineRef[];
  note?: string;
}

export interface ModeInfo {
  id: ModeId;
  label: string;
  description: string;
  /** The server chooses the engines: show the line-up as what "auto" resolves to. */
  auto: boolean;
  /** The user chooses the interpreter and the reader. */
  editable: boolean;
  /** An outside model is part of the line-up. */
  outside: boolean;
  summary: string;
  /** In display order: interpreter, symbols, reader, text. */
  lineup: LineupRow[];
  /** Custom only: the choices the line-up was resolved for. */
  picks?: { interpreter: string; reader: string };
}

export interface ModesInfo {
  default: ModeId;
  modes: ModeInfo[];
  interpreters: Engine[];
  readers: Engine[];
}

/** What a request may state: the mode, and for Custom the interpreter and the reader. */
export interface Choice {
  mode?: unknown;
  interpreter?: unknown;
  reader?: unknown;
}

/** A choice the server cannot follow; the message tells the user what to change. */
export class ChoiceError extends Error {}

export type ModeDeps = Required<Pick<Deps, "vision" | "planner" | "text" | "detector" | "rasterScope" | "voteSymbols">> & Pick<Deps, "advice" | "plannerAbsent">;

export interface Resolved {
  mode: ModeId;
  deps: ModeDeps;
  info: ModeInfo;
}

export interface Modes {
  readonly interpreters: Engine[];
  readonly readers: Engine[];
  /** The line-up a request asks for; Blueline only when it names no mode. Throws ChoiceError. */
  resolve(choice?: Choice): Resolved;
  /** Everything the client draws the mode panel from; `custom` are the choices to resolve Custom for. Throws ChoiceError. */
  describe(custom?: Choice): ModesInfo;
}

interface Slot extends Engine {
  model: VisionModel | null;
}

interface Lineup {
  mode: ModeId;
  interpreter: Slot;
  reader: Slot;
  text: Slot;
  /** Why the interpreter is not the one the mode would rather have. */
  interpreterNote?: string;
  /** The user chose the keyword parser, as opposed to its standing in for an interpreter that cannot run. */
  keywordsPicked?: boolean;
}

const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));

export function createModes(detector: Detector | null, probe: Probe = systemProbe()): Modes {
  const env = (name: string) => probe.env[name]?.trim() || undefined;
  const visionProvider = env("VISION_PROVIDER"), plannerProvider = env("PLANNER_PROVIDER");
  const cliNamed = visionProvider === "claude-cli" || plannerProvider === "claude-cli";
  const cli = (cliNamed || visionProvider === undefined) && probe.cliInstalled();
  const claudeBy = cliNamed && cli ? "cli" : env("ANTHROPIC_API_KEY") ? "api" : cli ? "cli" : null;
  const noClaude =
    cliNamed || visionProvider === undefined
      ? "ANTHROPIC_API_KEY is not set and the claude CLI was not found on the PATH"
      : `ANTHROPIC_API_KEY is not set, and the claude CLI is not the configured provider (VISION_PROVIDER=${visionProvider})`;
  const claude = (id: string, label: string, model: string, effort?: string): Slot => ({
    id, label, name: `${claudeBy === "cli" ? "claude-cli" : "anthropic-api"}:${model}`, tier: "external-model", outside: true, available: claudeBy !== null,
    ...(claudeBy === null && { unavailable: noClaude }),
    model: claudeBy === "api" ? new AnthropicApiVision(model) : claudeBy === "cli" ? new ClaudeCliVision(model, effort) : null,
  });

  const gemmaPath = plannerProvider === "gemma-local" && /\.gguf$/i.test(env("PLANNER_MODEL") ?? "") ? env("PLANNER_MODEL")! : DEFAULT_GEMMA_PATH;
  const gemma = new GemmaLocal(gemmaPath);
  const hasGemma = probe.exists(gemmaPath);
  const blueline: Slot = {
    id: "blueline", label: INTERPRETER_LABEL, name: gemma.id, tier: "own-model", outside: false, available: hasGemma,
    ...(!hasGemma && { unavailable: `its weights file is missing: ${gemmaPath}` }), model: hasGemma ? gemma : null,
  };
  const keywords: Slot = { id: "keywords", label: "Keyword parser only", name: SCRIPTS.keywords, tier: "script", outside: false, available: true, model: null };

  const hasGemini = env("GEMINI_API_KEY") !== undefined;
  const gemini: Slot = {
    id: "gemini", label: labelOf(`gemini-api:${GEMINI}`)!, name: `gemini-api:${GEMINI}`, tier: "external-model", outside: true, available: hasGemini,
    ...(!hasGemini && { unavailable: "GEMINI_API_KEY is not set" }), model: hasGemini ? new GeminiApiVision(GEMINI) : null,
  };
  const haiku = claude("haiku", labelOf(`anthropic-api:${HAIKU}`)!, HAIKU, env("PLANNER_EFFORT"));
  const sonnet = claude("sonnet", labelOf(`anthropic-api:${SONNET}`)!, SONNET, env("VISION_EFFORT"));
  const none: Slot = { id: "none", label: "No outside reader", outside: false, available: true, model: null };

  const interpreters = [blueline, haiku, gemini, keywords];
  const readers = [none, gemini, sonnet];
  if (visionProvider === "openai-compatible") {
    const model = env("VISION_MODEL"), baseUrl = env("VISION_BASE_URL");
    const hosted = model && baseUrl ? new OpenAiCompatibleVision(model, baseUrl, env("VISION_API_KEY"), Number(env("VISION_IMAGE_MIN_SIDE") ?? 0)) : null;
    readers.push({
      id: "self-hosted", label: hosted ? labelOf(hosted.id)! : "Self-hosted reader", name: hosted?.id, tier: "self-hosted-model", outside: false, available: hosted !== null,
      ...(!hosted && { unavailable: "VISION_PROVIDER=openai-compatible needs VISION_BASE_URL and VISION_MODEL" }), model: hosted,
    });
  }

  const noVision = new NoVision();
  const firstOf = (...slots: Slot[]) => slots.find((slot) => slot.available);

  function picked(kind: "interpreter" | "reader", slots: Slot[], id: unknown, fallback: Slot): Slot {
    if (id === undefined || id === null || id === "") return fallback;
    const slot = slots.find((each) => each.id === id);
    if (!slot) throw new ChoiceError(`Unknown ${kind} '${String(id)}'. Choose one of: ${slots.filter((each) => each.available).map((each) => each.id).join(", ")}.`);
    if (!slot.available) {
      const others = slots.filter((each) => each.available).map((each) => `${each.id} (${each.label})`);
      throw new ChoiceError(`${slot.label} cannot be the ${kind} on this server: ${slot.unavailable}. Available: ${others.join(", ")}.`);
    }
    return slot;
  }

  function lineupOf(choice: Choice = {}): Lineup {
    const mode = MODES.find((known) => known.id === (choice.mode ?? DEFAULT_MODE))?.id;
    if (!mode) throw new ChoiceError(`Unknown mode '${String(choice.mode)}'. Choose one of: ${MODES.map((known) => `${known.id} (${known.label})`).join(", ")}.`);
    const ours = firstOf(blueline) ?? keywords;
    const noGemma = blueline.available ? undefined : `the Blueline interpreter cannot run here (${blueline.unavailable}), so the keyword parser reads the question`;
    if (mode === "best") {
      const interpreter = firstOf(haiku, gemini) ?? ours;
      const reader = firstOf(gemini, sonnet) ?? none;
      return {
        mode, interpreter, reader, text: firstOf(sonnet) ?? reader,
        interpreterNote: interpreter.outside ? undefined : (noGemma ?? "no outside interpreter can run on this server, so the Blueline interpreter reads the question"),
      };
    }
    if (mode === "custom") {
      const interpreter = picked("interpreter", interpreters, choice.interpreter, ours);
      const reader = picked("reader", readers, choice.reader, none);
      const stated = Boolean(choice.interpreter);
      return { mode, interpreter, reader, text: reader, interpreterNote: stated ? undefined : noGemma, keywordsPicked: stated && interpreter === keywords };
    }
    return { mode: "blueline", interpreter: ours, reader: none, text: none, interpreterNote: noGemma };
  }

  const bestReads = lineupOf({ mode: "best" }).reader !== none;
  const hostedReads = readers.some((reader) => reader.available && reader !== none && !reader.outside);

  function adviceOf({ mode, reader }: Lineup): OutsideAdvice | undefined {
    if (reader !== none) return undefined;
    if (bestReads && mode !== "best") {
      return {
        none: mode === "custom" ? "no reader is chosen in Custom" : "Blueline only calls none",
        remedy: "Best accuracy, or a reader chosen in Custom, would answer it", retry: "best",
      };
    }
    return { none: "none can run on this server", ...(hostedReads && { remedy: "The self-hosted reader, chosen in Custom, would answer it" }) };
  }

  const ref = ({ id, label, name, tier, outside }: EngineRef): EngineRef => ({ id, label, ...(name && { name }), ...(tier && { tier }), outside });
  const members = detector?.members ?? (detector ? [detector] : []);
  const detectors: EngineRef | null = detector && {
    id: "detectors", label: labelOf(detector.id) ?? detector.id,
    name: tierOf(detector.id) === "own-model" ? members.map((member) => member.id.split(":")[1]).join(" + ") : detector.id,
    tier: tierOf(detector.id), outside: tierOf(detector.id) === "external-model",
  };

  function infoOf(lineup: Lineup): ModeInfo {
    const { mode, interpreter, reader, text } = lineup;
    const reads = reader !== none;
    // Mirrors the solver: a vote needs three counts, so two detectors and the reader.
    const votes = mode === "best" && reads && (detector?.members?.length ?? 0) >= 2;
    const symbols: LineupRow = { role: "symbols", title: "Counts the drawn symbols on image plans", engines: [] };
    if (detectors && votes) {
      symbols.engines = [detectors, ref(reader)];
      symbols.note = `the middle of ${members.length + 1} independent counts: each of the ${members.length} detectors and the reader's inventory of the drawing`;
    } else if (detectors) {
      symbols.engines = [detectors];
      if (mode === "best") symbols.note = reads ? "the detector alone: a vote takes two detectors" : "the detector alone, as in Blueline only: no reader can run here to vote with";
    } else {
      symbols.engines = reads ? [ref(reader)] : [];
      symbols.note = reads ? "no detector weights are installed" : "no detector weights are installed: a count on an image plan gets no value";
    }

    const rooms: LineupRow = { role: "reader", title: "Reads room types, storeys and anything else on image plans", engines: [] };
    if (reads) rooms.engines = [ref(reader)];
    else if (detectors) {
      rooms.engines = [detectors];
      rooms.note = "room types and storeys only; a question about anything else gets no value";
    } else rooms.note = "nobody: such a question gets no value";

    const outsiders = new Map<string, string[]>();
    for (const [what, engine] of [["questions", interpreter], ["image plans", reader], ["building model facts and sheet text", text]] as const) {
      if (engine.outside) outsiders.set(engine.label, [...(outsiders.get(engine.label) ?? []), what]);
    }
    if (detectors?.outside) outsiders.set(detectors.label, [...(outsiders.get(detectors.label) ?? []), "image plans"]);
    const hosted = reads && !reader.outside ? ` Image plans go to ${reader.label}, which we host ourselves.` : "";
    const resolvesToOurs = mode !== "blueline" && !bestReads && !interpreters.some((each) => each.outside && each.available);
    const summary =
      outsiders.size > 0 ? `Outside models are called: ${[...outsiders].map(([label, whats]) => `${list(whats)} go to ${label}`).join("; ")}.${hosted}`
      : hosted ? `No outside model is called.${hosted}`
      : resolvesToOurs ? `No outside model can run on this server, so ${labelOfMode(mode)} resolves to the Blueline engines. Nothing leaves this server.`
      : "Nothing leaves this server.";

    const known = MODES.find((each) => each.id === mode)!;
    return {
      ...known, auto: mode === "best", editable: mode === "custom", outside: outsiders.size > 0, summary,
      lineup: [
        { role: "interpreter", title: "Understands the question", engines: [ref(interpreter)], ...(lineup.interpreterNote && { note: lineup.interpreterNote }) },
        symbols,
        rooms,
        { role: "text", title: "Words answers from building model facts and sheet text", engines: text === none ? [] : [ref(text)], ...(text === none && { note: "nobody: such a question gets no value" }) },
      ],
      ...(mode === "custom" && { picks: { interpreter: interpreter.id, reader: reader.id } }),
    };
  }

  function depsOf(lineup: Lineup): ModeDeps {
    const reads = lineup.reader !== none;
    return {
      vision: lineup.reader.model ?? noVision, planner: lineup.interpreter.model, text: lineup.text.model ?? noVision, detector,
      rasterScope: reads ? "symbols" : "all", voteSymbols: lineup.mode === "best" && reads, advice: adviceOf(lineup),
      ...(lineup.interpreter === keywords && {
        plannerAbsent: lineup.keywordsPicked ? "the keyword parser is the interpreter chosen in Custom" : `the Blueline interpreter cannot run here: ${blueline.unavailable}`,
      }),
    };
  }

  const engine = ({ model: _model, ...shown }: Slot): Engine => shown;
  return {
    interpreters: interpreters.map(engine),
    readers: readers.map(engine),
    resolve(choice) {
      const lineup = lineupOf(choice);
      return { mode: lineup.mode, deps: depsOf(lineup), info: infoOf(lineup) };
    },
    describe(custom = {}) {
      return {
        default: DEFAULT_MODE,
        modes: MODES.map(({ id }) => infoOf(lineupOf(id === "custom" ? { ...custom, mode: id } : { mode: id }))),
        interpreters: interpreters.map(engine),
        readers: readers.map(engine),
      };
    },
  };
}

/**
 * For the evaluation scripts: the line-up of --mode (with --engine-interpreter and --reader for custom), built by the
 * resolver the server uses. Null when the run names no mode: the environment then picks the models.
 * A choice that cannot be followed ends the run with its message.
 */
export function lineupOfRun(option: (name: string) => string | undefined, detector: Detector | null): Resolved | null {
  const mode = option("mode");
  if (mode === undefined) return null;
  try {
    return createModes(detector).resolve({ mode, interpreter: option("engine-interpreter"), reader: option("reader") });
  } catch (error) {
    if (!(error instanceof ChoiceError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

/** The line-up the modes resolve to, in one line, for the evaluation scripts and the server's log. */
export function lineupSentence({ info, deps }: Resolved): string {
  const by = (role: LineupRole) => info.lineup.find((row) => row.role === role)!.engines.map((each) => each.name ?? each.label).join(" + ") || "nobody";
  return `${info.label}: interpreter ${by("interpreter")}; symbols ${by("symbols")}${deps.voteSymbols ? " (middle count)" : ""}; room types and readings ${by("reader")}; text ${by("text")}`;
}
