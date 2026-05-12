// Generic disk-backed key/value cache.
//
// Pattern: a small JSON value keyed on something stable across
// sessions (tenant id, OAuth metadata, schema version) that's
// expensive to fetch and effectively immutable. Files live under
// `<rootDir>/<scope>/<sha256(key)>.json`. Corrupt or unreadable
// entries return `undefined` rather than throwing — a poisoned cache
// must never break startup.
//
// `scope` is restricted to a safe slug so it can't escape the cache
// root. The key is hashed before becoming a path segment, so any
// caller-supplied string is acceptable.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SCOPE_PATTERN = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface DiskCacheOpts {
  // Root directory under which all scopes live. Typically the
  // toolkit-managed cache root (e.g. SandboxInstance.rootCacheDir()).
  rootDir: string;
  // Namespace slug under rootDir. Restricted charset so a typoed
  // scope can't escape the cache root.
  scope: string;
  // Lifetime in ms. Defaults to 24h. A negative value means "never
  // expire" — pass with care.
  ttlMs?: number;
}

interface Envelope<T> {
  v: T;
  // ISO-8601 write time. Stored as a string so the file is grep-able
  // and human-readable when debugging.
  fetchedAt: string;
}

function assertScope(scope: string): void {
  if (!SCOPE_PATTERN.test(scope)) {
    throw new Error(
      `DiskCache: scope must match [A-Za-z0-9_.-]+; got ${JSON.stringify(scope)}`,
    );
  }
}

function keyFile(opts: DiskCacheOpts, key: string): string {
  assertScope(opts.scope);
  const hash = createHash("sha256").update(key).digest("hex");
  return path.join(opts.rootDir, opts.scope, `${hash}.json`);
}

export async function readDiskCache<T>(
  opts: DiskCacheOpts,
  key: string,
  now: number = Date.now(),
): Promise<T | undefined> {
  const file = keyFile(opts, key);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let env: Envelope<T>;
  try {
    env = JSON.parse(raw) as Envelope<T>;
  } catch {
    // Corrupt JSON — treat as a miss rather than throw. A poisoned
    // cache file shouldn't take down startup.
    return undefined;
  }
  if (!env || typeof env.fetchedAt !== "string" || !("v" in env)) {
    return undefined;
  }
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (ttlMs >= 0) {
    const fetchedAt = Date.parse(env.fetchedAt);
    if (Number.isNaN(fetchedAt)) return undefined;
    if (now - fetchedAt > ttlMs) return undefined;
  }
  return env.v;
}

export async function writeDiskCache<T>(
  opts: DiskCacheOpts,
  key: string,
  value: T,
): Promise<void> {
  const file = keyFile(opts, key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const env: Envelope<T> = {
    v: value,
    fetchedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(env, null, 2), "utf8");
}
