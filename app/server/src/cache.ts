import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";

/** The JSON value in `file`, or null when the file is missing or unreadable. */
export async function readJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Writes through a temporary file, so the target is either absent or complete. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, file);
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Returns the JSON value stored in `file`, or computes it and stores it.
 * Concurrent callers share one computation, and the file appears only when it is complete,
 * so a reader never sees a half-written value.
 */
export async function cachedJson<T>(file: string, compute: () => Promise<T>): Promise<T> {
  const stored = await readJson<T>(file);
  if (stored !== null) return stored;
  const running = inFlight.get(file);
  if (running) return running as Promise<T>;
  const call = (async () => {
    const value = await compute();
    await writeJsonAtomic(file, value);
    return value;
  })().finally(() => inFlight.delete(file));
  inFlight.set(file, call);
  return call;
}
