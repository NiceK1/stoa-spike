/**
 * Everything the page asks of the server. A static build (VITE_STATIC=1, the free Hugging Face Space) has no server:
 * it reads answers pre-computed by scripts/export-static.ts from files next to the page instead.
 */
export const STATIC = import.meta.env.VITE_STATIC === "1";

export type Drawing = { kind: "dataset"; path: string } | { kind: "upload"; id: string; name: string };

const query = (d: Drawing) => (d.kind === "dataset" ? `path=${encodeURIComponent(d.path)}` : `upload=${encodeURIComponent(d.id)}`);

async function json(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

// Static data: dataset.json lists the drawings with an id each; drawings/<id>.json holds a drawing's questions,
// preview and answers; answers point to evidence/<hash>.json, shared between answers that show the same thing.
let index: Promise<{ sources: unknown[]; ids: Record<string, number> }> | null = null;
const staticIndex = () => (index ??= json("static/dataset.json"));
const drawings = new Map<number, Promise<any>>();
async function staticDrawing(path: string): Promise<any> {
  const id = (await staticIndex()).ids[path];
  if (id === undefined) throw new Error("This drawing is not part of the demo.");
  if (!drawings.has(id)) drawings.set(id, json(`static/drawings/${id}.json`));
  return drawings.get(id)!;
}
const withEvidence = async (item: any) => (item?.evidenceRef ? { ...item, evidence: await json(`static/evidence/${item.evidenceRef}.json`) } : item);

export async function health(): Promise<{ vision: string }> {
  return STATIC ? { vision: "none" } : json("/api/health");
}

export async function dataset(): Promise<{ sources: any[] }> {
  return STATIC ? staticIndex() as Promise<{ sources: any[] }> : json("/api/dataset");
}

export async function questions(d: Drawing): Promise<{ questions: any[] }> {
  if (!STATIC) return json(`/api/questions?${query(d)}`);
  return d.kind === "dataset" ? { questions: (await staticDrawing(d.path)).questions } : { questions: [] };
}

export async function preview(d: Drawing): Promise<{ evidence: any }> {
  if (!STATIC) return json(`/api/preview?${query(d)}`);
  return d.kind === "dataset" ? { evidence: (await withEvidence((await staticDrawing(d.path)).preview))?.evidence ?? null } : { evidence: null };
}

/** The server's reply to a question, or an Error with the message to show. */
export async function ask(d: Drawing, question: string): Promise<any> {
  if (!STATIC) {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d.kind === "dataset" ? { path: d.path, question } : { upload: d.id, question }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "The question could not be answered.");
    return body;
  }
  if (d.kind !== "dataset") throw new Error("Uploads need the full app.");
  const { answers } = await staticDrawing(d.path);
  const loose = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  const key = Object.keys(answers).find((known) => loose(known) === loose(question));
  if (!key) {
    throw new Error("This online demo has the answers to the questions listed for each drawing: pick one of them. Run Blueline locally to ask your own.");
  }
  const reply = answers[key];
  return { ...reply, answer: await withEvidence(reply.answer) };
}

export async function upload(file: File): Promise<{ upload: string; name: string }> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/upload", { method: "POST", body: form });
  if (!response.ok) throw new Error("The upload failed.");
  return response.json();
}
