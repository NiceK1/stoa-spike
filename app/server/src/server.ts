import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { APP_ROOT, CACHE_DIR, UPLOAD_DIR, datasetRoot, loadEnv } from "./config.js";
import { isAvailable, questionsByPath } from "./dataset.js";
import { createDetector } from "./models/detector.js";
import { createPlanner, createVision } from "./models/vision.js";
import { ask, type Deps } from "./router.js";
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

const deps: Deps = { vision: createVision(), planner: createPlanner(), detector: createDetector(), fileUrl };
const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

app.get("/api/health", async () => ({ vision: deps.vision.id, detector: deps.detector?.id ?? null, dataset: datasetRoot() }));

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

app.post("/api/upload", async (request, reply) => {
  const part = await request.file();
  if (!part) return reply.code(400).send({ error: "no file" });
  const folder = join(UPLOAD_DIR, randomBytes(8).toString("hex"));
  await mkdir(folder, { recursive: true });
  const name = basename(part.filename).replace(/[^\w.\-]+/g, "_");
  await writeFile(join(folder, name), await part.toBuffer());
  return { upload: `${basename(folder)}/${name}`, name };
});

app.post<{ Body: { path?: string; upload?: string; question: string; type?: QuestionType } }>("/api/ask", async (request, reply) => {
  const { path, upload, question, type } = request.body ?? ({} as any);
  if (!question?.trim()) return reply.code(400).send({ error: "question is required" });
  const file = path ? inside(datasetRoot(), path) : upload ? inside(UPLOAD_DIR, upload) : null;
  if (!file) return reply.code(400).send({ error: "path or upload is required" });

  const known = path ? questionsByPath().get(path)?.find((row) => row.question === question.trim()) : undefined;
  const started = Date.now();
  try {
    const answer = await ask({ file, question: question.trim(), type: type ?? (known?.type === "other" ? undefined : known?.type) }, deps);
    return {
      answer,
      seconds: (Date.now() - started) / 1000,
      expected: known ? { value: known.answer, unit: known.unit, correct: isCorrect(known.type, known.answer, answer.value) } : null,
    };
  } catch (error) {
    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

const webDist = join(APP_ROOT, "web", "dist");
if (existsSync(webDist)) await app.register(fastifyStatic, { root: webDist });

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "127.0.0.1" });
console.log(`Stoa take-off server on http://127.0.0.1:${port} (vision ${deps.vision.id}, detector ${deps.detector?.id ?? "none"})`);
