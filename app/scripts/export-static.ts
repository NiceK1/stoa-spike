/**
 * Pre-computes the answers for a static build of the page (the free Hugging Face Space has no server):
 * asks a running server every dataset question and writes what the static client reads (see web/src/api.ts).
 *
 *   npx tsx scripts/export-static.ts http://127.0.0.1:7861 <out>/static
 *
 * Questions the server cannot answer (an error) are left out, so the demo lists only answerable ones.
 * Images that evidence points to are downloaded next to the data, under files/.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [server, out] = process.argv.slice(2);
if (!server || !out) throw new Error("usage: export-static.ts <server url> <out dir>");
const CONCURRENCY = 4;

async function get(path: string): Promise<any> {
  const response = await fetch(server + path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

const files = new Map<string, Promise<string>>();
/** Downloads a served file once and returns the URL the static page loads it from, relative to the page. */
function localFile(url: string): Promise<string> {
  if (!files.has(url)) {
    files.set(url, (async () => {
      const params = new URL(url, server).searchParams;
      const local = join("files", params.get("root") ?? "", params.get("path") ?? "");
      const response = await fetch(new URL(url, server));
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      await mkdir(dirname(join(out, local)), { recursive: true });
      await writeFile(join(out, local), Buffer.from(await response.arrayBuffer()));
      return `static/${local.split("\\").join("/")}`;
    })());
  }
  return files.get(url)!;
}

const stored = new Set<string>();
/** Writes evidence once, keyed by its content, and returns the key. */
async function storeEvidence(evidence: any): Promise<string> {
  if (evidence.kind === "image") evidence = { ...evidence, imageUrl: await localFile(evidence.imageUrl) };
  const text = JSON.stringify(evidence);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 20);
  if (!stored.has(hash)) {
    stored.add(hash);
    await writeFile(join(out, "evidence", `${hash}.json`), text);
  }
  return hash;
}

async function pool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

await mkdir(join(out, "drawings"), { recursive: true });
await mkdir(join(out, "evidence"), { recursive: true });
const { sources } = await get("/api/dataset");
const paths: string[] = sources.flatMap((s: any) => s.files.map((f: any) => f.path));
const ids: Record<string, number> = Object.fromEntries(paths.map((path, i) => [path, i]));
const kept = new Map<string, number>();
let asked = 0, answered = 0;

await pool(paths, async (path) => {
  const query = `path=${encodeURIComponent(path)}`;
  const { questions } = await get(`/api/questions?${query}`);
  const { evidence } = await get(`/api/preview?${query}`).catch(() => ({ evidence: null }));
  const answers: Record<string, unknown> = {};
  const answerable = [];
  for (const q of questions) {
    asked++;
    const response = await fetch(`${server}/api/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, question: q.question }),
    });
    if (!response.ok) continue;
    const reply = await response.json();
    const { evidence: shown, ...answer } = reply.answer;
    answers[q.question] = { ...reply, answer: shown ? { ...answer, evidenceRef: await storeEvidence(shown) } : answer };
    answerable.push(q);
    answered++;
  }
  kept.set(path, answerable.length);
  const preview = evidence ? { evidenceRef: await storeEvidence(evidence) } : null;
  await writeFile(join(out, "drawings", `${ids[path]}.json`), JSON.stringify({ questions: answerable, preview, answers }));
  if (kept.size % 20 === 0) console.log(`${kept.size}/${paths.length} drawings, ${answered}/${asked} questions answered`);
});

// The list shows how many answerable questions each drawing has; drawings with none are left out.
const listed = sources
  .map((s: any) => ({ ...s, files: s.files.filter((f: any) => (kept.get(f.path) ?? 0) > 0).map((f: any) => ({ ...f, questions: kept.get(f.path) })) }))
  .filter((s: any) => s.files.length > 0);
await writeFile(join(out, "dataset.json"), JSON.stringify({ sources: listed, ids }));
console.log(`done: ${paths.length} drawings, ${answered}/${asked} questions answered, ${stored.size} evidence files, ${files.size} images`);
