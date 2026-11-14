import { useEffect, useMemo, useRef, useState } from "react";

interface Mark { n: number; x: number; y: number; w?: number; h?: number; label?: string }
type Evidence =
  | { kind: "svg"; svg: string; caption: string }
  | { kind: "image"; imageUrl: string; width: number; height: number; marks: Mark[]; caption: string };
interface Answer {
  value: number | string | null; unit?: string; pipeline: string; method: string; exact: boolean; evidence?: Evidence; note?: string;
}
interface Reply {
  answer: Answer; seconds: number; expected: { value: number | string; unit: string | null; correct: boolean | null } | null;
  /** The question this reply answers, which may differ from what is in the text box by now. */
  question: string;
}
interface DatasetFile { path: string; questions: number }
interface Source { source: string; files: DatasetFile[] }
interface Known { question: string; answer: number | string; unit: string | null; type: string }

const SOURCE_NAMES: Record<string, string> = {
  swiss_dwellings: "Apartment floors (CAD)",
  ifc_models: "Building models (IFC)",
  cubicasa5k: "Floor plan images",
  ifc_bench: "Building models, text questions",
  opening_design: "Practice drawing sets",
};

const PIPELINES: Record<string, string> = {
  "dxf-geometry": "Measured from the CAD geometry",
  "dxf-facts": "Answered from the rooms measured in the CAD geometry",
  "ifc-geometry": "Measured from the building model",
  detector: "Counted by the symbol detector",
  "symbol-vote": "Counted independently by the detectors and a vision model",
  "vision-model": "Read from the image by a vision model",
  "sheet-text": "Read from the text on the sheet",
  "ifc-facts": "Answered from facts in the building model",
  none: "No answer",
};

const KINDS: { type: string; label: string }[] = [
  { type: "count", label: "Counts" },
  { type: "area", label: "Areas" },
  { type: "length", label: "Lengths" },
  { type: "volume", label: "Volumes" },
  { type: "text", label: "Other" },
];

// Wording outside the dataset's templates, to show that a question does not have to follow them.
const FREE_QUESTIONS: Record<string, string[]> = {
  cad: ["Show me the bedrooms", "Which room is the largest?", "What is the combined area of the bathrooms and the corridors?"],
  image: ["Show me the bedrooms", "Where are the toilets?", "Mark all windows"],
};

function freeQuestions(path: string | null, uploadName: string | undefined): string[] {
  if (path) return FREE_QUESTIONS[{ swiss_dwellings: "cad", cubicasa5k: "image" }[path.split("/")[1]] ?? ""] ?? [];
  if (!uploadName) return [];
  return /\.dxf$/i.test(uploadName) ? FREE_QUESTIONS.cad : /\.(png|jpe?g|webp)$/i.test(uploadName) ? FREE_QUESTIONS.image : [];
}

/** Drawings listed per source group before "Show more"; search reaches all of them. */
const PAGE = 100;

const fileName = (path: string) => path.split("/").pop() ?? path;
const extension = (path: string) => (/\.(\w+)$/.exec(path)?.[1] ?? "").toUpperCase();

/** A readable name for a dataset file; the file name stays visible underneath. */
function title(path: string): string {
  const stem = fileName(path).replace(/\.\w+$/, "");
  const swiss = /^site(\d+)_bldg(\d+)_floor(\d+)$/.exec(stem);
  if (swiss) return `Site ${swiss[1]} · Building ${swiss[2]} · Floor ${swiss[3]}`;
  const [model, level] = stem.split("_plan-");
  const words = model.replace(/^bsc-/, "").replace(/[_-]+/g, " ").trim();
  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return level ? `${name} · plan ${level.replace(/-/g, " ")}` : name;
}

/** The dataset pairs each English question with a translation; English is shown first and the rest on request. */
const isEnglish = (q: string) =>
  /^(how|what|which|where|is|are|does|do|list|give|name|count|in|on|for|according)\b/i.test(q.trim()) && !/[äöüßéèàçò]/i.test(q);

const kindOf = (type: string) => (KINDS.some((k) => k.type === type) ? type : "text");

type Drawing = { kind: "dataset"; path: string } | { kind: "upload"; id: string; name: string };
const drawingKey = (d: Drawing) => (d.kind === "dataset" ? d.path : `upload:${d.id}`);

export function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [listed, setListed] = useState(false);
  const [filter, setFilter] = useState("");
  /** How many drawings each source group lists; the full dataset has thousands per group. */
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [preview, setPreview] = useState<Evidence | null | "loading">(null);
  const [known, setKnown] = useState<Known[]>([]);
  const [question, setQuestion] = useState("");
  /** Answers asked this session, per drawing, newest last. */
  const [history, setHistory] = useState<Record<string, Reply[]>>({});
  const [shownReply, setShownReply] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [translations, setTranslations] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/dataset").then((r) => r.json()).then((d) => { setSources(d.sources); setListed(true); }).catch(() => setError("The server is not reachable."));
  }, []);

  // "/" jumps to the drawing search, as in most file browsers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setKnown([]);
    setPreview(null);
    if (!drawing) return;
    const query = drawing.kind === "dataset" ? `path=${encodeURIComponent(drawing.path)}` : `upload=${encodeURIComponent(drawing.id)}`;
    if (drawing.kind === "dataset") {
      fetch(`/api/questions?${query}`).then((r) => r.json()).then((d) => setKnown(d.questions));
    }
    let current = true;
    setPreview("loading");
    fetch(`/api/preview?${query}`).then((r) => r.json()).then((d) => current && setPreview(d.evidence ?? null)).catch(() => current && setPreview(null));
    return () => { current = false; };
  }, [drawing]);

  // A link can open a drawing and ask a question straight away: ?path=...&q=...
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const linked = params.get("path");
    if (!linked) return;
    const d: Drawing = { kind: "dataset", path: linked };
    setDrawing(d);
    const q = params.get("q");
    if (q) void ask(q, d);
  }, []);

  const shown = useMemo(() => {
    const needles = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (path: string) => {
      const hay = `${path} ${title(path)}`.toLowerCase();
      return needles.every((n) => hay.includes(n));
    };
    return sources
      .map((s) => ({ ...s, files: s.files.filter((f) => matches(f.path)) }))
      .filter((s) => s.files.length > 0);
  }, [sources, filter]);

  const key = drawing ? drawingKey(drawing) : null;
  const replies = key ? history[key] ?? [] : [];
  const reply = shownReply !== null ? replies[shownReply] ?? null : null;

  const english = known.filter((k) => isEnglish(k.question));
  const offered = translations || english.length === 0 ? known : english;
  const kinds = KINDS.map((k) => ({ ...k, n: offered.filter((q) => kindOf(q.type) === k.type).length })).filter((k) => k.n > 0);
  const free = drawing ? freeQuestions(drawing.kind === "dataset" ? drawing.path : null, drawing.kind === "upload" ? drawing.name : undefined) : [];
  const chips = kind === "free" ? [] : kind ? offered.filter((q) => kindOf(q.type) === kind) : offered;
  const freeChips = kind === null || kind === "free" ? free : [];

  // Only the latest request may update the screen: a slow answer must not land under another drawing or question.
  const latest = useRef(0);

  async function ask(text: string, target: Drawing | null = drawing) {
    if (!target || !text.trim()) return;
    const request = ++latest.current;
    setQuestion("");
    setPending(text);
    setError(null);
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.kind === "dataset" ? { path: target.path, question: text } : { upload: target.id, question: text }),
      });
      const body = await response.json();
      if (request !== latest.current) return;
      if (!response.ok) throw new Error(body.error ?? "The question could not be answered.");
      const k = drawingKey(target);
      setHistory((h) => {
        const list = [...(h[k] ?? []), { ...body, question: text }];
        setShownReply(list.length - 1);
        return { ...h, [k]: list };
      });
    } catch (e) {
      if (request !== latest.current) return;
      setQuestion(text);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === latest.current) setPending(null);
    }
  }

  function choose(d: Drawing) {
    latest.current++;
    setPending(null);
    setError(null);
    setQuestion("");
    setKind(null);
    setShownReply((history[drawingKey(d)]?.length ?? 0) > 0 ? history[drawingKey(d)].length - 1 : null);
    setDrawing(d);
    // Keep the link shareable: it reopens this drawing.
    const url = new URL(location.href);
    url.search = d.kind === "dataset" ? `?path=${encodeURIComponent(d.path)}` : "";
    history_replace(url);
    setTimeout(() => composer.current?.focus(), 0);
  }

  async function chooseUpload(file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    if (!response.ok) return setError("The upload failed.");
    const body = await response.json();
    choose({ kind: "upload", id: body.upload, name: body.name });
  }

  const evidence = reply?.answer.evidence ?? (preview === "loading" ? null : preview);

  return (
    <div className="layout">
      <aside className="browser">
        <header className="brand">
          <h1>Take-off check</h1>
          <p className="lede">Pick a drawing, ask how many or how much. Every counted item is marked so you can check it.</p>
        </header>
        <div className="search">
          <input
            ref={search} className="field" type="search" placeholder="Search drawings" value={filter}
            onChange={(e) => setFilter(e.target.value)} aria-label="Search drawings"
          />
          {!filter && <kbd>/</kbd>}
        </div>
        <div className="files" role="listbox" aria-label="Drawings">
          {drawing?.kind === "upload" && (
            <div>
              <div className="group">Your upload</div>
              <button className="file chosen" role="option" aria-selected>
                <span className="name">{drawing.name}</span>
                <span className="meta"><span className="badge">{extension(drawing.name)}</span></span>
              </button>
            </div>
          )}
          {shown.map((s) => (
            <div key={s.source}>
              <div className="group">{SOURCE_NAMES[s.source] ?? s.source}<span className="count">{s.files.length}</span></div>
              {s.files.slice(0, limits[s.source] ?? PAGE).map((f) => {
                const chosen = drawing?.kind === "dataset" && drawing.path === f.path;
                const asked = history[f.path]?.length ?? 0;
                return (
                  <button
                    key={f.path} role="option" aria-selected={chosen} className={chosen ? "file chosen" : "file"}
                    onClick={() => choose({ kind: "dataset", path: f.path })} title={f.path}
                  >
                    <span className="name">{title(f.path)}</span>
                    <span className="meta">
                      <span className="badge">{extension(f.path)}</span>
                      <span className="fname">{fileName(f.path)}</span>
                      <span className="count">{asked > 0 ? `${asked} asked · ` : ""}{f.questions} q</span>
                    </span>
                  </button>
                );
              })}
              {s.files.length > (limits[s.source] ?? PAGE) && (
                <button className="more" onClick={() => setLimits((l) => ({ ...l, [s.source]: (l[s.source] ?? PAGE) + PAGE }))}>
                  Show {Math.min(PAGE, s.files.length - (limits[s.source] ?? PAGE))} more of {s.files.length - (limits[s.source] ?? PAGE)}
                </button>
              )}
            </div>
          ))}
          {sources.length > 0 && shown.length === 0 && <p className="hint">No drawing matches “{filter}”.</p>}
          {!listed && !error && <p className="hint">Loading drawings…</p>}
          {listed && sources.length === 0 && <p className="hint">No drawings in the dataset folder yet.</p>}
        </div>
        <label className="upload">
          <input type="file" accept=".png,.jpg,.jpeg,.pdf,.dxf,.ifc,.svg" onChange={(e) => chooseUpload(e.target.files?.[0])} />
          <span>＋ Upload your own drawing</span>
          <small>PDF, PNG, JPG, DXF, IFC</small>
        </label>
      </aside>

      <main className="stage">
        {!drawing ? (
          <div className="empty">
            <div>
              <p className="big">Choose a drawing to start</p>
              <p>Search on the left by site, building or file name, or upload your own.</p>
            </div>
          </div>
        ) : (
          <>
            <header className="topbar">
              <div className="current">
                <span className="badge">{extension(drawing.kind === "dataset" ? drawing.path : drawing.name)}</span>
                <h2>{drawing.kind === "dataset" ? title(drawing.path) : drawing.name}</h2>
              </div>
              {replies.length > 0 && (
                <nav className="history" aria-label="Answers for this drawing">
                  <button className={shownReply === null ? "step on" : "step"} onClick={() => setShownReply(null)}>Drawing</button>
                  {replies.map((r, i) => (
                    <button
                      key={i} className={i === shownReply ? "step on" : "step"} onClick={() => setShownReply(i)} title={r.question}
                    >
                      <b>{r.answer.value === null ? "—" : String(r.answer.value)}</b>
                      {r.expected?.correct === true && <span className="ok" aria-label="matches the dataset">✓</span>}
                      {r.expected?.correct === false && <span className="off" aria-label="differs from the dataset">✗</span>}
                      <span className="short">{r.question}</span>
                    </button>
                  ))}
                </nav>
              )}
            </header>

            {error && <div className="notice" role="alert">{error}</div>}
            {pending ? (
              <div className="placard pending" aria-live="polite">
                <div className="figure"><span className="spinner" /></div>
                <div className="facts">
                  <p className="asked">{pending}</p>
                  <p className="time">Reading the drawing… vector drawings answer at once, images take up to 20 s.</p>
                </div>
              </div>
            ) : reply && <Result reply={reply} />}

            {evidence ? (
              <Viewer evidence={evidence} />
            ) : (
              <div className="empty">
                <p>{preview === "loading" ? "Loading the drawing…" : "No flat preview for this file. Ask a question and the matching plan appears here."}</p>
              </div>
            )}

            <section className="ask">
              {(known.length > 0 || free.length > 0) && (
                <div className="suggest">
                  <div className="tabs" role="tablist" aria-label="Suggested questions">
                    <span className="label">Try</span>
                    <button role="tab" aria-selected={kind === null} className={kind === null ? "tab on" : "tab"} onClick={() => setKind(null)}>
                      All <span className="count">{offered.length + free.length}</span>
                    </button>
                    {free.length > 0 && (
                      <button role="tab" aria-selected={kind === "free"} className={kind === "free" ? "tab on" : "tab"} onClick={() => setKind("free")}>
                        Your words <span className="count">{free.length}</span>
                      </button>
                    )}
                    {kinds.map((k) => (
                      <button
                        key={k.type} role="tab" aria-selected={kind === k.type} className={kind === k.type ? "tab on" : "tab"}
                        onClick={() => setKind(k.type)}
                      >
                        {k.label} <span className="count">{k.n}</span>
                      </button>
                    ))}
                    {english.length > 0 && english.length < known.length && (
                      <label className="toggle">
                        <input type="checkbox" checked={translations} onChange={(e) => setTranslations(e.target.checked)} />
                        Translations
                      </label>
                    )}
                  </div>
                  <div className="chips">
                    {freeChips.map((q) => (
                      <button key={q} className="chip free" onClick={() => ask(q)} disabled={pending !== null} title="Free wording, outside the dataset's templates">
                        {q}
                      </button>
                    ))}
                    {chips.map((k, i) => (
                      <button key={i} className="chip" onClick={() => ask(k.question)} disabled={pending !== null} title={k.question}>
                        {k.question}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <form className="composer" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
                <textarea
                  ref={composer} rows={1} value={question} onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(question); } }}
                  placeholder="Ask about this drawing, e.g. How many windows are there?" aria-label="Question"
                />
                <button className="primary" disabled={pending !== null || !question.trim()}>Ask</button>
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function history_replace(url: URL) {
  try { window.history.replaceState(null, "", url); } catch { /* not allowed in some embeds */ }
}

function Result({ reply }: { reply: Reply }) {
  const { answer, expected, seconds, question } = reply;
  const unit = answer.unit && answer.unit !== "count" ? answer.unit.replace("m2", "m²").replace("m3", "m³") : "";
  const long = typeof answer.value === "string" && answer.value.length > 12;
  return (
    <header className="placard">
      <div className={long ? "figure text" : "figure"}>
        {answer.value === null ? "—" : String(answer.value)}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div className="facts">
        <p className="asked">{question}</p>
        <p>
          <span className={answer.exact ? "tag exact" : "tag estimate"}>{answer.exact ? "Exact" : "Estimate"}</span>
          {PIPELINES[answer.pipeline] ?? answer.pipeline}: {answer.method}.
        </p>
        {answer.note && <p className="note">{answer.note}</p>}
        <p className="time">
          {expected && expected.correct !== null && (
            <span className={expected.correct ? "check ok" : "check off"}>
              {expected.correct ? "Matches" : "Differs from"} the dataset answer, {String(expected.value)}.{" "}
            </span>
          )}
          Answered in {seconds.toFixed(1)} s
        </p>
      </div>
    </header>
  );
}

function Viewer({ evidence }: { evidence: Evidence }) {
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => setView({ x: 0, y: 0, k: 1 }), [evidence]);

  function zoomAt(px: number, py: number, factor: number) {
    setView((v) => {
      const k = Math.min(12, Math.max(1, v.k * factor));
      // Keep the given point fixed while zooming.
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  }

  const canvas = useRef<HTMLDivElement>(null);
  function zoomCentre(factor: number) {
    const box = canvas.current?.getBoundingClientRect();
    if (box) zoomAt(box.width / 2, box.height / 2, factor);
  }

  return (
    <figure className="viewer">
      <div
        ref={canvas} className="canvas"
        onWheel={(e) => { const box = e.currentTarget.getBoundingClientRect(); zoomAt(e.clientX - box.left, e.clientY - box.top, wheelFactor(e)); }}
        onDoubleClick={(e) => { const box = e.currentTarget.getBoundingClientRect(); zoomAt(e.clientX - box.left, e.clientY - box.top, 1.6); }}
        onPointerDown={(e) => { drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => {
          // Read the drag start now: by the time the state update runs, pointer-up may have cleared it.
          const start = drag.current;
          if (!start) return;
          const x = e.clientX - start.x, y = e.clientY - start.y;
          setView((v) => ({ ...v, x, y }));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <div className="sheet" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <div className="fit" style={{ "--aspect": aspect(evidence) } as React.CSSProperties}>
            {evidence.kind === "svg" ? <div className="svgwrap" dangerouslySetInnerHTML={{ __html: evidence.svg }} /> : <Marked evidence={evidence} />}
          </div>
        </div>
        <div className="zoom" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button onClick={() => zoomCentre(1.3)} aria-label="Zoom in">＋</button>
          <button onClick={() => zoomCentre(1 / 1.3)} aria-label="Zoom out">－</button>
          <button onClick={() => setView({ x: 0, y: 0, k: 1 })} aria-label="Fit to screen" disabled={view.k === 1 && view.x === 0 && view.y === 0}>⤢</button>
        </div>
      </div>
      <figcaption>{evidence.caption}. Scroll or double-click to zoom, drag to move.</figcaption>
    </figure>
  );
}

/**
 * Zoom step for one wheel event, in proportion to how far it scrolled: a mouse-wheel notch (about 100 px)
 * zooms about 12%, and a trackpad's many small events add up smoothly instead of 20% each.
 */
function wheelFactor(e: React.WheelEvent): number {
  const pixels = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
  return Math.exp(-Math.max(-100, Math.min(100, pixels)) * 0.0012);
}

function aspect(evidence: Evidence): number {
  if (evidence.kind === "image") return evidence.width / evidence.height;
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(evidence.svg);
  return box ? Number(box[1]) / Number(box[2]) : 1.5;
}

function Marked({ evidence }: { evidence: Extract<Evidence, { kind: "image" }> }) {
  const { width, height, marks } = evidence;
  const r = Math.max(width, height) / 70;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={marks.length ? `${marks.length} marked items` : "The drawing"}>
      <image href={evidence.imageUrl} width={width} height={height} />
      {marks.map((m) => {
        const boxed = m.w !== undefined && m.h !== undefined;
        // A text row is wide and thin: its badge shrinks to the row height and sits at the row's left end.
        const row = boxed && m.w! > 6 * m.h!;
        const size = row ? Math.max(r * 0.3, Math.min(r, m.h! * 0.8)) : r;
        const cx = row ? m.x - size * 1.3 : boxed ? m.x + m.w! / 2 : m.x;
        const cy = row ? m.y + m.h! / 2 : boxed ? m.y - size * 0.9 : m.y;
        return (
          <g key={m.n}>
            {boxed && <rect x={m.x} y={m.y} width={m.w} height={m.h} className="box" strokeWidth={size / 6} />}
            <circle cx={cx} cy={cy} r={size} className="dot" strokeWidth={size / 8} />
            <text x={cx} y={cy + size * 0.38} fontSize={size * 1.15} className="num">{m.n}</text>
            {m.label && <title>{m.label}</title>}
          </g>
        );
      })}
    </svg>
  );
}
