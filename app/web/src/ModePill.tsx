import { useEffect, useRef, useState } from "react";
import { callsOutside, hintOf, measuredOf, picksOf, taglineOf, type Engine, type EngineRef, type LineupRow, type ModeInfo } from "./modes";
import type { Modes } from "./useModes";

/**
 * The server as a room on a plan, with the counted-item dot of the logo: inside closed walls while nothing leaves
 * the server, outside an open door when a question may go to an outside model.
 */
export function ModeGlyph({ outside }: { outside: boolean }) {
  return (
    <svg className={outside ? "mode-glyph outside" : "mode-glyph"} viewBox="0 0 22 16" aria-hidden="true">
      <path d="M12 5V3H3v10h9v-2" />
      <path className="door" d="M12 5v6" />
      <circle className="dot" cx="7.5" cy="8" r="2.2" />
    </svg>
  );
}

/** Our own engines carry Blueline in their name; only an outside one is tagged. */
function EngineLine({ engine }: { engine: EngineRef }) {
  return (
    <div className="engine" title={engine.name}>
      <b>{engine.label}</b>
      {engine.outside && <span className="tier external-model">outside</span>}
    </div>
  );
}

/** One job of the line-up and who does it. */
function Job({ row }: { row: LineupRow }) {
  return (
    <div className="job">
      <dt>{row.title}</dt>
      <dd>
        {row.engines.map((engine) => <EngineLine key={engine.id} engine={engine} />)}
        {row.note && <p className="job-note">{row.note}</p>}
      </dd>
    </div>
  );
}

/** What a mode is and who does each job in it: kept out of the list, shown beside it for the mode being looked at. */
function Details({ mode, outside }: { mode: ModeInfo; outside: boolean }) {
  const measured = measuredOf(mode);
  return (
    <aside id="mode-details" className={outside ? "mode-details outside" : "mode-details"} role="note">
      <h3><ModeGlyph outside={outside} />{mode.label}</h3>
      <p>{mode.description}</p>
      <dl>{mode.lineup.map((row) => <Job key={row.role} row={row} />)}</dl>
      {measured && <p className="measured"><b>{measured.share}</b> {measured.rest}</p>}
    </aside>
  );
}

/** A picker of the mode that has them. An engine that cannot run here is listed, and cannot be picked. */
function Pick({ label, options, chosen, onPick }: { label: string; options: Engine[]; chosen: string; onPick: (id: string) => void }) {
  const outside = options.find((engine) => engine.id === chosen)?.outside ?? false;
  return (
    <label className={outside ? "pick outside" : "pick"}>
      <span className="pick-label">{label}{outside && <span className="tier external-model">outside</span>}</span>
      <span className="pick-select">
        <select value={chosen} onChange={(e) => onPick(e.target.value)}>
          {options.map((engine) => (
            <option key={engine.id} value={engine.id} disabled={!engine.available} title={engine.unavailable}>
              {engine.label}{!engine.available && " (cannot run here)"}
            </option>
          ))}
        </select>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
      </span>
    </label>
  );
}

/**
 * The oval in the question box that says who answers, and the panel it opens to change that.
 * Renders nothing until the server has listed its modes, so a server without modes shows no control.
 */
export function ModePill({ modes, busy }: { modes: Modes; busy: boolean }) {
  const { info, choice, mode, outside, summary, notice } = modes;
  const [open, setOpen] = useState(false);
  // The mode whose details show: the one under the pointer or with the focus, or the one pinned with its "i".
  const [looking, setLooking] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  function close(refocus: boolean) {
    setOpen(false);
    setLooking(null);
    setPinned(null);
    modes.dismissNotice();
    if (refocus) pill.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLInputElement>('input[name="blueline-mode"]:checked')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(true); };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!pop.current?.contains(target) && !pill.current?.contains(target)) close(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [open]);

  if (!info || !choice || !mode) return null;
  const picks = picksOf(info, choice);
  // Beside the list the card can follow the pointer; inside a phone's sheet it would move the list under the finger.
  const follows = window.matchMedia("(min-width: 641px)").matches;
  const detailed = info.modes.find((each) => each.id === (pinned ?? (follows ? looking : null)));

  return (
    <>
      <div className="mode-row">
        <button
          ref={pill} type="button" className={`mode-pill${outside ? " outside" : ""}${outside && busy ? " busy" : ""}`}
          aria-haspopup="dialog" aria-expanded={open} aria-controls="mode-panel" title={summary ?? undefined}
          aria-label={`Who answers: ${mode.label}, ${hintOf(info, choice)}.${summary ? ` ${summary}` : ""}`} onClick={() => (open ? close(false) : setOpen(true))}
        >
          {/* The outline is drawn, not a border, so that its dashes can open and travel. */}
          <svg className="mode-edge" aria-hidden="true"><rect x="0.75" y="0.75" width="100%" height="100%" rx="15.25" /></svg>
          <ModeGlyph outside={outside} />
          <span className="mode-name">{mode.label}</span>
          <svg className="mode-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5" /></svg>
        </button>
        <span className="visually-hidden" role="status">{summary && `${mode.label}. ${summary}`}</span>
      </div>
      {open && (
        <>
          <div className="mode-scrim" />
          <div ref={pop} className="mode-pop">
            <div
              id="mode-panel" className="mode-panel" role="dialog" aria-labelledby="mode-panel-title"
              // Enter in a radio button would submit the question box this panel sits in; here it means "done".
              onKeyDown={(e) => { if (e.key === "Enter" && e.target instanceof HTMLInputElement) { e.preventDefault(); close(true); } }}
            >
              <header className="mode-head">
                <h2 id="mode-panel-title">Answer with</h2>
                <button type="button" className="mode-done" onClick={() => close(true)}>Done</button>
              </header>
              {notice && <p className="mode-notice" role="status">{notice}</p>}
              <div className="mode-options" role="radiogroup" aria-labelledby="mode-panel-title" onMouseLeave={() => setLooking(null)}>
                {info.modes.map((each) => {
                  const on = each.id === mode.id;
                  const out = callsOutside(info, { ...choice, mode: each.id });
                  const measured = measuredOf(each);
                  return (
                    <div
                      key={each.id} className={`mode-option${on ? " on" : ""}${out ? " outside" : ""}`} onMouseEnter={() => setLooking(each.id)}
                      // The whole block chooses. A click on a mode without pickers is the whole choice, so the list closes;
                      // the keyboard's own clicks (arrow keys, Space: detail 0) move through the list and leave it open.
                      onClick={(e) => { modes.choose({ ...choice, mode: each.id }); if (!each.editable && e.detail > 0) close(true); }}
                    >
                      <label className="mode-choice">
                        <input
                          type="radio" name="blueline-mode" checked={on}
                          aria-labelledby={`mode-title-${each.id}`} aria-describedby={`mode-about-${each.id}`}
                          onChange={() => modes.choose({ ...choice, mode: each.id })}
                          // Opening the list with the mouse focuses the chosen mode; only the keyboard's focus asks for its details.
                          onFocus={(e) => { if (e.target.matches(":focus-visible")) setLooking(each.id); }} onBlur={() => setLooking(null)}
                        />
                        <span className="mode-title" id={`mode-title-${each.id}`}>{each.label}{each.auto && <span className="badge">auto</span>}</span>
                        <span className="mode-share">{measured?.share}</span>
                        <span className="mode-about" id={`mode-about-${each.id}`}>{taglineOf(each)}</span>
                      </label>
                      <button
                        type="button" className="mode-info" aria-label={`What ${each.label} uses`} aria-controls="mode-details"
                        aria-expanded={pinned === each.id} onClick={(e) => { e.stopPropagation(); setPinned(pinned === each.id ? null : each.id); }}
                      >i</button>
                      {on && each.editable && (
                        <div className="picks" onClick={(e) => e.stopPropagation()}>
                          <Pick label="Understands the question" options={info.interpreters} chosen={picks.interpreter} onPick={(id) => modes.choose({ ...choice, ...picks, interpreter: id })} />
                          <Pick label="Reads image plans" options={info.readers} chosen={picks.reader} onPick={(id) => modes.choose({ ...choice, ...picks, reader: id })} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mode-foot">Score: questions about 200 unseen floor-plan images answered exactly right.</p>
            </div>
            {detailed && <Details mode={detailed} outside={callsOutside(info, { ...choice, mode: detailed.id })} />}
          </div>
        </>
      )}
    </>
  );
}
