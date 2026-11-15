import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { askFields, callsOutside, describeChoice, describes, modeOf, parseChoice, picksOf, settle, type Choice, type ModeInfo, type ModesInfo } from "./modes";

const STORED = "blueline.mode";

function remembered(): Choice | null {
  try { return parseChoice(localStorage.getItem(STORED)); } catch { return null; }
}

function remember(choice: Choice) {
  try { localStorage.setItem(STORED, JSON.stringify(choice)); } catch { /* storage unavailable */ }
}

export interface Modes {
  /** Null until the server has listed its modes, and for good when it has none: the static build, an older server. */
  info: ModesInfo | null;
  choice: Choice | null;
  mode: ModeInfo | null;
  /** Whether a question asked now may go to an outside model. */
  outside: boolean;
  /** What the choice sends where, in a sentence; null while the server has not yet described new picks. */
  summary: string | null;
  /** Why the remembered choice was not kept; shown in the panel until it closes. */
  notice: string | null;
  choose(next: Choice): void;
  dismissNotice(): void;
  /** What to send with a question, once the server's listing has arrived or failed; undefined when it has no modes. */
  fields(): Promise<Choice | undefined>;
}

/** The server's modes and this browser's choice among them. */
export function useModes(): Modes {
  const [info, setInfo] = useState<ModesInfo | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What a question asked right now goes with: state lags a render behind, and a linked question is asked on the first one.
  const latest = useRef<{ info: ModesInfo; choice: Choice } | null>(null);
  const loading = useRef<Promise<void> | null>(null);

  const load = useCallback(() => (loading.current ??= api.modes().then(async (first) => {
    if (!first) return;
    const { choice: kept, dropped } = settle(remembered(), first);
    // Remembered picks are described before the first paint, so the line-up never shows the default ones.
    const picks = picksOf(first, kept);
    const listed = (!describes(modeOf(first, kept.mode), picks) && (await api.modes(picks))) || first;
    latest.current = { info: listed, choice: kept };
    setInfo(listed);
    setChoice(kept);
    if (dropped) {
      setNotice(`Your saved choice, ${describeChoice(listed, dropped)}, cannot run on this server. Questions use ${modeOf(listed, kept.mode)?.label ?? kept.mode} instead.`);
      remember(kept);
    }
  })), []);
  useEffect(() => { void load(); }, [load]);

  // The line-up of the mode with pickers depends on the picks, so the server describes it again when they change.
  const described = useRef("");
  useEffect(() => {
    if (!info || !choice) return;
    const picks = picksOf(info, choice);
    const key = `${picks.interpreter}/${picks.reader}`;
    // A server that answers with other picks than asked for is not asked again.
    if (describes(modeOf(info, choice.mode), picks) || key === described.current) return;
    let current = true;
    api.modes(picks).then((listed) => {
      if (!current || !listed) return;
      described.current = key;
      if (latest.current) latest.current.info = listed;
      setInfo(listed);
    });
    return () => { current = false; };
  }, [info, choice]);

  const choose = useCallback((next: Choice) => {
    if (latest.current) latest.current.choice = next;
    setChoice(next);
    remember(next);
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const fields = useCallback(() => load().then(() => (latest.current ? askFields(latest.current.info, latest.current.choice) : undefined)), [load]);

  const mode = info && choice ? modeOf(info, choice.mode) ?? null : null;
  return {
    info, choice, notice, choose, dismissNotice, fields, mode,
    outside: info && choice ? callsOutside(info, choice) : false,
    summary: info && choice && mode && describes(mode, picksOf(info, choice)) ? mode.summary : null,
  };
}
