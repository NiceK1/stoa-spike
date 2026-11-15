/** The answering modes as GET /api/modes lists them (server/src/modes.ts), and the choice this browser remembers. */

/** Whose work a script or model is, as the server tags it (SourceTier in server/src/types.ts). */
export type Tier = "script" | "own-model" | "self-hosted-model" | "external-model";

export interface EngineRef { id: string; label: string; name?: string; tier?: Tier; outside: boolean }
export interface Engine extends EngineRef { available: boolean; unavailable?: string }
export interface LineupRow { role: "interpreter" | "symbols" | "reader" | "text"; title: string; engines: EngineRef[]; note?: string }
export interface Picks { interpreter: string; reader: string }
export interface ModeInfo {
  id: string; label: string; description: string; auto: boolean; editable: boolean; outside: boolean; summary: string;
  lineup: LineupRow[];
  /** Only on a mode with pickers: the picks its line-up was described for. */
  picks?: Picks;
}
export interface ModesInfo { default: string; modes: ModeInfo[]; interpreters: Engine[]; readers: Engine[] }

/** `interpreter` and `reader` are the picks for the mode with pickers; they are kept while another mode is chosen. */
export interface Choice { mode: string; interpreter?: string; reader?: string }

export const modeOf = (info: ModesInfo, id: string): ModeInfo | undefined => info.modes.find((mode) => mode.id === id);

const engineOf = (engines: Engine[], id: string | undefined): Engine | undefined => engines.find((engine) => engine.id === id);

/** The picks a choice stands for: its own, else the ones the server describes the mode with. */
export function picksOf(info: ModesInfo, choice: Choice): Picks {
  const described = info.modes.find((mode) => mode.picks)?.picks;
  return {
    interpreter: choice.interpreter ?? described?.interpreter ?? info.interpreters[0]?.id ?? "",
    reader: choice.reader ?? described?.reader ?? info.readers[0]?.id ?? "",
  };
}

/** Whether a mode's line-up is the one for these picks; a mode without pickers has one line-up only. */
export const describes = (mode: ModeInfo | undefined, picks: Picks): boolean =>
  !mode?.picks || (mode.picks.interpreter === picks.interpreter && mode.picks.reader === picks.reader);

/** A remembered choice as it was stored, or null when the text is not one. */
export function parseChoice(stored: string | null): Choice | null {
  if (!stored) return null;
  try {
    const { mode, interpreter, reader } = JSON.parse(stored) ?? {};
    if (typeof mode !== "string") return null;
    return { mode, ...(typeof interpreter === "string" && { interpreter }), ...(typeof reader === "string" && { reader }) };
  } catch {
    return null;
  }
}

/**
 * The choice to use on this server: the remembered one when it can run here, else the server's default, with the
 * remembered one in `dropped`. Picks that cannot run are dropped quietly while a mode without pickers is chosen.
 */
export function settle(remembered: Choice | null, info: ModesInfo): { choice: Choice; dropped?: Choice } {
  if (!remembered) return { choice: { mode: info.default } };
  const runs = (engines: Engine[], id: string | undefined) => id === undefined || engineOf(engines, id)?.available === true;
  const picksRun = runs(info.interpreters, remembered.interpreter) && runs(info.readers, remembered.reader);
  const mode = modeOf(info, remembered.mode);
  if (!mode || (mode.editable && !picksRun)) return { choice: { mode: info.default }, dropped: remembered };
  return { choice: picksRun ? remembered : { mode: remembered.mode } };
}

/** What POST /api/ask takes for a choice: the picks go along only with the mode that reads them. */
export function askFields(info: ModesInfo, choice: Choice): Choice {
  return modeOf(info, choice.mode)?.editable ? { mode: choice.mode, ...picksOf(info, choice) } : { mode: choice.mode };
}

/** Whether a question asked with this choice may go to an outside model. For picks this is known before the server describes them. */
export function callsOutside(info: ModesInfo, choice: Choice): boolean {
  const mode = modeOf(info, choice.mode);
  if (!mode?.editable) return mode?.outside ?? false;
  const picks = picksOf(info, choice);
  return (engineOf(info.interpreters, picks.interpreter)?.outside ?? false) || (engineOf(info.readers, picks.reader)?.outside ?? false);
}

/** A model's name without its vendor or base model in brackets, for places with room for a few words only. */
const short = (engine: Engine) => (engine.tier ? engine.label.replace(/\s*\([^)]*\)$/, "") : engine.label.toLowerCase());

/** The few words the pill adds to the mode's name. */
export function hintOf(info: ModesInfo, choice: Choice): string {
  const mode = modeOf(info, choice.mode);
  if (!mode) return "";
  if (mode.editable) {
    const picks = picksOf(info, choice);
    return [engineOf(info.interpreters, picks.interpreter), engineOf(info.readers, picks.reader)].filter((each) => each !== undefined).map(short).join(" + ");
  }
  if (mode.auto) return mode.outside ? "auto: best model per question" : "auto: no outside model here";
  return mode.outside ? "outside models are called" : "nothing leaves this server";
}

/** A choice in words, for telling the user which one could not be kept. */
export function describeChoice(info: ModesInfo, choice: Choice): string {
  const mode = modeOf(info, choice.mode);
  if (!mode) return `“${choice.mode}”`;
  if (!mode.editable) return mode.label;
  const named = [engineOf(info.interpreters, choice.interpreter), engineOf(info.readers, choice.reader)].filter((each) => each !== undefined);
  return named.length > 0 ? `${mode.label} with ${named.map((engine) => engine.label).join(" and ")}` : mode.label;
}

/** Free wording needs a model to read the question; the keyword parser knows the dataset's wordings only. */
export function understandsFreeWording(mode: ModeInfo): boolean {
  const interpreter = mode.lineup.find((row) => row.role === "interpreter");
  return interpreter?.engines.some((engine) => engine.tier !== undefined && engine.tier !== "script") ?? false;
}

export interface Measured { share: string; rest: string }

const READING_COST = "One outside reading per drawing: about $0.07 and half a minute for the first question on an image plan.";

/**
 * The measured result of a line-up on 1,781 questions about 200 held-out image plans (app/README.md, "Measured"),
 * or null for a line-up that was not measured. Told by who does the two image jobs, since that is what was varied.
 */
export function measuredOf(mode: ModeInfo): Measured | null {
  const ids = (role: LineupRow["role"]) => mode.lineup.find((row) => row.role === role)?.engines.map((engine) => engine.id).join("+");
  const symbols = ids("symbols"), reader = ids("reader");
  if (symbols === "detectors" && reader === "detectors") return { share: "85.9%", rest: "right on 1,781 questions about held-out image plans. No outside call, free." };
  if (symbols === "detectors+gemini" && reader === "gemini") return { share: "89.0%", rest: `right on the same 1,781 questions. ${READING_COST}` };
  if (symbols === "detectors" && reader === "gemini") return { share: "87.7%", rest: `right on the same 1,781 questions. ${READING_COST}` };
  return null;
}
