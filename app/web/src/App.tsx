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

const fileName = (path: string) => path.split("/").pop() ?? path;

export function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ id: string; name: string } | null>(null);
  const [known, setKnown] = useState<Known[]>([]);
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/dataset").then((r) => r.json()).then((d) => setSources(d.sources)).catch(() => setError("The server is not reachable."));
  }, []);

  useEffect(() => {
    setKnown([]);
    if (path) fetch(`/api/questions?path=${encodeURIComponent(path)}`).then((r) => r.json()).then((d) => setKnown(d.questions));
  }, [path]);

  // A link can open a drawing and ask a question straight away: ?path=...&q=...
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const linked = params.get("path");
    if (!linked) return;
    setPath(linked);
    const q = params.get("q");
    if (q) void ask(q, linked);
  }, []);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return sources
      .map((s) => ({ ...s, files: s.files.filter((f) => !needle || f.path.toLowerCase().includes(needle)) }))
      .filter((s) => s.files.length > 0);
  }, [sources, filter]);

  const drawingChosen = path !== null || upload !== null;
  const free = freeQuestions(path, upload?.name);

  // Only the latest request may update the screen: a slow answer must not land under another drawing or question.
  const latest = useRef(0);

  async function ask(text: string, drawing: string | null = path) {
    if (!(drawing || upload) || !text.trim()) return;
    const request = ++latest.current;
    setQuestion(text);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: drawing ?? undefined, upload: drawing ? undefined : upload?.id, question: text }),
      });
      const body = await response.json();
      if (request !== latest.current) return;
      if (!response.ok) throw new Error(body.error ?? "The question could not be answered.");
      setReply({ ...body, question: text });
    } catch (e) {
      if (request !== latest.current) return;
      setReply(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === latest.current) setBusy(false);
    }
  }

  function changeDrawing() {
    latest.current++;
    setBusy(false);
    setReply(null);
    setError(null);
    setQuestion("");
  }

  async function chooseUpload(file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    if (!response.ok) return setError("The upload failed.");
    const body = await response.json();
    changeDrawing();
    setUpload({ id: body.upload, name: body.name });
    setPath(null);
  }

  return (
    <div className="layout">
      <aside className="panel">
        <h1>Take-off check</h1>
        <p className="lede">Ask a quantity question about a drawing. The answer comes back with every counted item marked, so you can check it yourself.</p>

        <section>
          <h2>Drawing</h2>
          <input className="field" placeholder="Filter drawings" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter drawings" />
          <div className="files" role="listbox" aria-label="Drawings">
            {shown.map((s) => (
              <div key={s.source}>
                <div className="group">{SOURCE_NAMES[s.source] ?? s.source}</div>
                {s.files.slice(0, 80).map((f) => (
                  <button
                    key={f.path} role="option" aria-selected={f.path === path}
                    className={f.path === path ? "file chosen" : "file"}
                    onClick={() => { changeDrawing(); setPath(f.path); setUpload(null); }}
                  >
                    <span>{fileName(f.path)}</span>
                    <span className="count">{f.questions}</span>
                  </button>
                ))}
              </div>
            ))}
            {shown.length === 0 && <p className="hint">No drawing matches the filter.</p>}
          </div>
          <label className="upload">
            <input type="file" accept=".png,.jpg,.jpeg,.pdf,.dxf,.ifc,.svg" onChange={(e) => chooseUpload(e.target.files?.[0])} />
            {upload ? `Uploaded: ${upload.name}` : "Or upload your own drawing"}
          </label>
        </section>

        <section>
          <h2>Question</h2>
          <form onSubmit={(e) => { e.preventDefault(); ask(question); }}>
            <textarea
              className="field" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)}
              placeholder={drawingChosen ? "How many windows are shown on this floor plan?" : "Choose a drawing first"}
              disabled={!drawingChosen} aria-label="Question"
            />
            <button className="primary" disabled={!drawingChosen || busy || !question.trim()}>{busy ? "Reading the drawing…" : "Ask"}</button>
          </form>
          {free.length > 0 && (
            <>
              <h3>Or in your own words</h3>
              <div className="known">
                {free.map((q) => (
                  <button key={q} className="suggestion" onClick={() => ask(q)} disabled={busy}>{q}</button>
                ))}
              </div>
            </>
          )}
          {known.length > 0 && (
            <>
              <h3>Questions that come with this drawing</h3>
              <div className="known">
                {known.map((k, i) => (
                  <button key={i} className="suggestion" onClick={() => ask(k.question)} disabled={busy}>{k.question}</button>
                ))}
              </div>
            </>
          )}
        </section>
      </aside>

      <main className="stage">
        {error && <div className="notice" role="alert">{error}</div>}
        {reply ? <Result reply={reply} question={reply.question} /> : !error && (
          <div className="empty">
            <p>{drawingChosen ? "Ask a question, or pick one from the list." : "Choose a drawing to start."}</p>
          </div>
        )}
      </main>
    </div>
  );
}

function Result({ reply, question }: { reply: Reply; question: string }) {
  const { answer, expected, seconds } = reply;
  const unit = answer.unit && answer.unit !== "count" ? answer.unit.replace("m2", "m²").replace("m3", "m³") : "";
  return (
    <>
      <header className="placard">
        <div className="figure">
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
          {expected && expected.correct !== null && (
            <p className={expected.correct ? "check ok" : "check off"}>
              {expected.correct ? "Matches" : "Differs from"} the dataset answer, {String(expected.value)}.
            </p>
          )}
          <p className="time">Answered in {seconds.toFixed(1)} s</p>
        </div>
      </header>
      {answer.evidence ? <Viewer evidence={answer.evidence} /> : <div className="empty"><p>No drawing to show for this answer.</p></div>}
    </>
  );
}

function Viewer({ evidence }: { evidence: Evidence }) {
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => setView({ x: 0, y: 0, k: 1 }), [evidence]);

  function zoom(e: React.WheelEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left, py = e.clientY - box.top;
    setView((v) => {
      const k = Math.min(12, Math.max(1, v.k * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      // Keep the point under the cursor fixed while zooming.
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  }

  return (
    <figure className="viewer">
      <div
        className="canvas" onWheel={zoom}
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
          {/* As wide as the stage allows, but never taller than the space under the answer. */}
          <div className="fit" style={{ width: `min(100%, calc((100vh - 290px) * ${aspect(evidence)}))` }}>
            {evidence.kind === "svg" ? <div dangerouslySetInnerHTML={{ __html: evidence.svg }} /> : <Marked evidence={evidence} />}
          </div>
        </div>
      </div>
      <figcaption>
        {evidence.caption}. Scroll to zoom, drag to move.
        {view.k !== 1 && <button className="link" onClick={() => setView({ x: 0, y: 0, k: 1 })}>Reset view</button>}
      </figcaption>
    </figure>
  );
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
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${marks.length} marked items`}>
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
