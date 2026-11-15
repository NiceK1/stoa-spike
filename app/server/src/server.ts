import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { APP_ROOT, CACHE_DIR, REPO_ROOT, UPLOAD_DIR, datasetRoot, loadEnv } from "./config.js";
import { isAvailable, questionsByPath } from "./dataset.js";
import { createDetector } from "./models/detector.js";
import { ChoiceError, DEFAULT_MODE, createModes, lineupSentence, type Choice } from "./modes.js";
import { ask, preview } from "./router.js";
import { isCorrect } from "./scoring.js";
import type { QuestionType } from "./types.js";

loadEnv();

const ROOTS: Record<string, string> = { dataset: datasetRoot(), cache: CACHE_DIR };
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
};

/** Resolves a path inside one of the served roots, or null when it would escape the root. */
function inside(root: string, path: string): string | null {
  const absolute = resolve(root, path);
  return absolute === root || absolute.startsWith(root + sep) ? absolute : null;
}

function fileUrl(absolute: string): string {
  for (const [name, root] of Object.entries(ROOTS)) {
    if (absolute.startsWith(root + sep)) {
      return `/api/file?root=${name}&path=${encodeURIComponent(relative(root, absolute).split(sep).join("/"))}`;
    }
  }
  throw new Error("file is outside the served folders");
}

const modes = createModes(createDetector());
const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

// `vision` is the reader of the default mode, which is what a question without a mode gets.
app.get("/api/health", async () => {
  const { deps } = modes.resolve();
  return { mode: DEFAULT_MODE, vision: deps.vision.id, interpreter: deps.planner?.id ?? null, detector: deps.detector?.id ?? null, dataset: datasetRoot() };
});

// With ?interpreter= and ?reader=, the Custom mode is described for those choices.
app.get<{ Querystring: Choice }>("/api/modes", async (request, reply) => {
  try {
    return modes.describe({ interpreter: request.query.interpreter, reader: request.query.reader });
  } catch (error) {
    if (error instanceof ChoiceError) return reply.code(400).send({ error: error.message });
    throw error;
  }
});

app.get("/api/dataset", async () => {
  const sources = new Map<string, { path: string; questions: number }[]>();
  for (const [path, rows] of questionsByPath()) {
    if (!isAvailable(path)) continue;
    const source = path.split("/")[1];
    if (!sources.has(source)) sources.set(source, []);
    sources.get(source)!.push({ path, questions: rows.length });
  }
  return { sources: [...sources].map(([source, files]) => ({ source, files: files.sort((a, b) => a.path.localeCompare(b.path)) })) };
});

app.get<{ Querystring: { path: string } }>("/api/questions", async (request) => ({
  questions: (questionsByPath().get(request.query.path) ?? []).map(({ question, answer, unit, type }) => ({ question, answer, unit, type })),
}));

app.get<{ Querystring: { root: string; path: string } }>("/api/file", async (request, reply) => {
  const root = ROOTS[request.query.root];
  const absolute = root ? inside(root, request.query.path ?? "") : null;
  if (!absolute || !existsSync(absolute)) return reply.code(404).send({ error: "not found" });
  return reply.type(MIME[extname(absolute).toLowerCase()] ?? "application/octet-stream").send(createReadStream(absolute));
});

app.get<{ Querystring: { path?: string; upload?: string } }>("/api/preview", async (request, reply) => {
  const { path, upload } = request.query;
  const file = path ? inside(datasetRoot(), path) : upload ? inside(UPLOAD_DIR, upload) : null;
  if (!file) return reply.code(400).send({ error: "path or upload is required" });
  try {
    return { evidence: await preview(file, { fileUrl }) };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/upload", async (request, reply) => {
  const part = await request.file();
  if (!part) return reply.code(400).send({ error: "no file" });
  const folder = join(UPLOAD_DIR, randomBytes(8).toString("hex"));
  await mkdir(folder, { recursive: true });
  const name = basename(part.filename).replace(/[^\w.\-]+/g, "_");
  await writeFile(join(folder, name), await part.toBuffer());
  return { upload: `${basename(folder)}/${name}`, name };
});

// `mode` is blueline, best or custom (Blueline only when left out); `interpreter` and `reader` are read with custom only.
app.post<{ Body: { path?: string; upload?: string; question: string; type?: QuestionType } & Choice }>("/api/ask", async (request, reply) => {
  const { path, upload, question, type, mode, interpreter, reader } = request.body ?? ({} as any);
  if (!question?.trim()) return reply.code(400).send({ error: "question is required" });
  const file = path ? inside(datasetRoot(), path) : upload ? inside(UPLOAD_DIR, upload) : null;
  if (!file) return reply.code(400).send({ error: "path or upload is required" });
  let lineup;
  try {
    lineup = modes.resolve({ mode, interpreter, reader });
  } catch (error) {
    if (error instanceof ChoiceError) return reply.code(400).send({ error: error.message });
    throw error;
  }

  const known = path ? questionsByPath().get(path)?.find((row) => row.question === question.trim()) : undefined;
  const started = Date.now();
  try {
    const answer = await ask({ file, question: question.trim(), type: type ?? (known?.type === "other" ? undefined : known?.type) }, { ...lineup.deps, fileUrl });
    return {
      answer,
      mode: lineup.mode,
      seconds: (Date.now() - started) / 1000,
      expected: known ? { value: known.answer, unit: known.unit, correct: isCorrect(known.type, known.answer, answer.value) } : null,
    };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

// The same front door as the Hugging Face Space: "/" is the landing page and the app is at /app.html.
// A link that already names a drawing (/?path=...) still opens the app, so older links keep working.
const webDist = join(APP_ROOT, "web", "dist");
const landing = join(REPO_ROOT, "deploy", "hf-space", "landing.html");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, index: false });
  app.get<{ Querystring: Record<string, string> }>("/", (request, reply) =>
    existsSync(landing) && !request.query.path && !request.query.q
      ? reply.type("text/html").send(createReadStream(landing))
      : reply.sendFile("index.html"),
  );
  app.get("/app.html", (_request, reply) => reply.sendFile("index.html"));
}

const port = Number(process.env.PORT ?? 8787);
// HOST=0.0.0.0 in a container (the Hugging Face Space); the default keeps a local run private to this machine.
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
console.log(`Stoa take-off server on http://127.0.0.1:${port}`);
for (const mode of ["blueline", "best"]) console.log(`  ${lineupSentence(modes.resolve({ mode }))}`);
