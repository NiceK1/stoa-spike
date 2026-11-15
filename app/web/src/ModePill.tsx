import { useEffect, useRef, useState } from "react";
import { TierTag } from "./SourceBlock";
import { callsOutside, hintOf, measuredOf, picksOf, type Engine, type EngineRef, type LineupRow, type ModeInfo } from "./modes";
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

function EngineLine({ engine }: { engine: EngineRef }) {
  return (
    <div className="engine" title={engine.name}>
      {engine.tier && <TierTag tier={engine.tier} />}
      <b>{engine.label}</b>
    </div>
  );
}

/** One job of the line-up and who does it. With `options` the job is a picker, and `chosen` is the pick. */
function Row({ row, options, chosen, onPick }: { row: LineupRow; options?: Engine[]; chosen?: string; onPick?: (id: string) => void }) {
  if (!options) {
    return (
      <div className="row">
        <p className="row-title">{row.title}</p>
        {row.engines.map((engine) => <EngineLine key={engine.id} engine={engine} />)}
        {row.note && <p className="row-note">{row.note}</p>}
      </div>
    );
  }
  // What the pick leaves to someone else: with no outside reader, the detectors still read the room types.
  const others = row.engines.filter((engine) => engine.id !== chosen);
  return (
    <fieldset className="row">
      <legend className="row-title">{row.title}</legend>
      {options.map((engine) => (
        <label key={engine.id} className={engine.available ? "pick" : "pick unavailable"}>
          <input
            type="radio" name={`blueline-pick-${row.role}`} checked={engine.id === chosen} disabled={!engine.available}
            onChange={() => onPick?.(engine.id)}
          />
          <span className="engine" title={engine.name}>
            {engine.tier && <TierTag tier={engine.tier} />}
            <b>{engine.label}</b>
          </span>
          {!engine.available && <span className="why">Cannot run on this server: {engine.unavailable ?? "it is not installed"}.</span>}
        </label>
      ))}
      {others.map((engine) => <EngineLine key={engine.id} engine={engine} />)}
      {row.note && <p className="row-note">{row.note}</p>}
    </fieldset>
  );
}

/**
 * The oval in the question box that says who answers, and the panel it opens to change that.
 * Renders nothing until the server has listed its modes, so a server without modes shows no control.
 */
export function ModePill({ modes, busy }: { modes: Modes; busy: boolean }) {
  const { info, choice, mode, outside, summary, notice } = modes;
  const [open, setOpen] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  function close(refocus: boolean) {
    setOpen(false);
    modes.dismissNotice();
    if (refocus) pill.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLInputElement>('input[name="blueline-mode"]:checked')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(true); };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !pill.current?.contains(target)) close(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onDown); };
  }, [open]);

  if (!info || !choice || !mode) return null;
  const hint = hintOf(info, choice);
  const picks = picksOf(info, choice);

  return (
    <>
      <div className="mode-row">
        <button
          ref={pill} type="button" className={`mode-pill${outside ? " outside" : ""}${outside && busy ? " busy" : ""}`}
          aria-haspopup="dialog" aria-expanded={open} aria-controls="mode-panel" title={summary ?? undefined}
          aria-label={`Who answers: ${mode.label}.${summary ? ` ${summary}` : ""}`} onClick={() => (open ? close(false) : setOpen(true))}
        >
          {/* The outline is drawn, not a border, so that its dashes can open and travel. */}
          <svg className="mode-edge" aria-hidden="true"><rect x="0.75" y="0.75" width="100%" height="100%" rx="13.25" /></svg>
          <ModeGlyph outside={outside} />
          <span className="mode-name">{mode.label}</span>
          {hint && <span className="mode-hint">{hint}</span>}
          <svg className="mode-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5" /></svg>
        </button>
        <span className="visually-hidden" role="status">{summary && `${mode.label}. ${summary}`}</span>
      </div>
      {open && (
        <>
          <div className="mode-scrim" />
          <div
            ref={panel} id="mode-panel" className="mode-panel" role="dialog" aria-labelledby="mode-panel-title"
            // Enter in a radio button would submit the question box this panel sits in; here it means "done".
            onKeyDown={(e) => { if (e.key === "Enter" && e.target instanceof HTMLInputElement) { e.preventDefault(); close(true); } }}
          >
            <header className="mode-head">
              <h2 id="mode-panel-title">Who answers your questions</h2>
              <button type="button" className="mode-done" onClick={() => close(true)}>Done</button>
            </header>
            {notice && <p className="mode-notice" role="status">{notice}</p>}
            <div className="mode-options" role="radiogroup" aria-labelledby="mode-panel-title">
              {info.modes.map((each) => {
                const on = each.id === mode.id;
                const out = callsOutside(info, { ...choice, mode: each.id });
                const measured = measuredOf(each);
                return (
                  <div key={each.id} className={`mode-option${on ? " on" : ""}${out ? " outside" : ""}`}>
                    <label className="mode-choice">
                      <input
                        type="radio" name="blueline-mode" checked={on}
                        aria-labelledby={`mode-title-${each.id}`} aria-describedby={`mode-about-${each.id}`}
                        onChange={() => modes.choose({ ...choice, mode: each.id })}
                      />
                      <span className="mode-title" id={`mode-title-${each.id}`}>{each.label}{each.auto && <span className="badge">auto</span>}</span>
                      <ModeGlyph outside={out} />
                      <span className="mode-about" id={`mode-about-${each.id}`}>
                        {each.description}
                        {measured && <span className="mode-measured"><b>{measured.share}</b> {measured.rest}</span>}
                      </span>
                    </label>
                    {on && <Lineup mode={each} interpreters={info.interpreters} readers={info.readers} picks={picks} onPick={(pick) => modes.choose({ ...choice, ...picks, ...pick })} />}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Lineup({ mode, interpreters, readers, picks, onPick }: {
  mode: ModeInfo; interpreters: Engine[]; readers: Engine[]; picks: { interpreter: string; reader: string };
  onPick: (pick: { interpreter: string } | { reader: string }) => void;
}) {
  return (
    <div className="lineup">
      {/* With outside models in the line-up, their tags below say what the summary would. */}
      {!mode.outside && <p className="mode-summary">{mode.summary}</p>}
      {mode.auto && <p className="lineup-head">On this server, auto resolves to</p>}
      {mode.lineup.map((row) =>
        mode.editable && row.role === "interpreter" ? <Row key={row.role} row={row} options={interpreters} chosen={picks.interpreter} onPick={(id) => onPick({ interpreter: id })} />
        : mode.editable && row.role === "reader" ? <Row key={row.role} row={row} options={readers} chosen={picks.reader} onPick={(id) => onPick({ reader: id })} />
        : <Row key={row.role} row={row} />,
      )}
    </div>
  );
}
