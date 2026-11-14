import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const APP_ROOT = join(REPO_ROOT, "app");
export const CACHE_DIR = join(APP_ROOT, ".cache");
export const UPLOAD_DIR = join(CACHE_DIR, "uploads");

/** Reads KEY=value lines from the repo's .env into process.env, without overriding what is already set. */
export function loadEnv(): void {
  const file = join(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

export function datasetRoot(): string {
  return resolve(process.env.STOA_DATASET ?? join(REPO_ROOT, "dataset"));
}

export function cacheDir(name: string): string {
  const dir = join(CACHE_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
