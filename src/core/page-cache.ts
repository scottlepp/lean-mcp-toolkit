// Versioned-id disk cache for known-key resources.
//
// Distinct from `sandbox` (content-addressed, anonymous large
// payloads). Use `pageCache` when the resource has a stable id and a
// version/etag that invalidates the cache:
//   - Confluence pages (id + integer version)
//   - PR diffs (pr id + head sha)
//   - Build logs (build id + attempt number)
//
// Path scheme: `{cacheRoot}/{kind}/{id}-v{version}.json`
//   - `kind` is a caller-chosen slug (e.g. "pages", "diffs", "logs")
//   - `version` is the version key (number or string — head SHAs work)
//
// Writes are atomic via tmpfile+rename: a concurrent reader never
// observes a partial file. Reads validate that the resolved path
// stays inside the cache root (defense against arbitrary file reads
// via crafted refs).
//
// Generalized from confluence-mcp/src/core/page-cache.ts. Env-var-
// driven configuration was lifted into factory params so the SDK has
// no hardcoded env var names.

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_TTL_DAYS = 7;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class BodyCacheTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly max: number) {
    super(
      `body would exceed cache size cap (${bytes} > ${max}); pass through to inline excerpt`,
    );
    this.name = "BodyCacheTooLargeError";
  }
}

export interface CreatePageCacheOpts {
  // Subdirectory name under os.tmpdir() that holds all cache entries
  // for this server (e.g. "bitbucket-mcp"). Ignored when `rootDir` is
  // also set.
  rootName: string;
  // Override the full root path (overrides the rootName-derived path).
  // Tests pass a tmpdir.
  rootDir?: string;
  // Pruning TTL in milliseconds. Files older than this are removed
  // when `prune()` runs. Defaults to 7 days.
  ttlMs?: number;
  // Per-file size cap. Writes above this throw `BodyCacheTooLargeError`
  // so callers can fall back to inline excerpts rather than fill disk.
  // Defaults to 5MB.
  maxBytes?: number;
  // When true, log prune progress to stderr. Useful for diagnosing
  // stuck caches in production.
  debug?: boolean;
  // Prefix used for stderr log lines (when `debug` is true or pruning
  // errors are logged). Defaults to `[${rootName}]`.
  loggerPrefix?: string;
}

export interface PageCacheInstance {
  // Absolute path to the cache root directory.
  cacheRoot(): string;
  // Write a body to disk, returning the absolute path. Atomic
  // (tmp+rename). Throws `BodyCacheTooLargeError` if the serialized
  // size exceeds `maxBytes`.
  //
  // `body` is any JSON-serializable value. Callers typically wrap
  // their raw API response in a small envelope before passing.
  writeBody(
    kind: string,
    id: string | number,
    version: string | number,
    body: unknown,
  ): Promise<string>;
  // Read a body back from disk. Validates that the resolved path
  // stays inside the cache root before reading. Returns `unknown`;
  // callers narrow.
  readBody(path: string): Promise<unknown>;
  // Remove entries older than the configured TTL. Best-effort: log
  // errors but never throw.
  prune(): Promise<void>;
}

// Sanitize a path component derived from possibly-untrusted input
// (resource ids can contain unusual characters depending on the API).
// Replaces anything outside `[A-Za-z0-9_-]` with `_` so the resulting
// filename can't escape the cache directory. `.` is intentionally
// excluded — without it, `..` segments can't reconstitute even if the
// raw input contained them. Callers with dotted version strings (e.g.
// semver) get `1_2_3` instead of `1.2.3`; that's fine since the path
// is purely an internal cache key, never user-facing.
function sanitizeIdComponent(s: string | number): string {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "_");
}

export function createPageCache(opts: CreatePageCacheOpts): PageCacheInstance {
  if (!opts.rootName || !/^[A-Za-z0-9_.-]+$/.test(opts.rootName)) {
    throw new Error(
      `createPageCache: rootName must be a non-empty slug ([A-Za-z0-9_.-]+); got: ${JSON.stringify(opts.rootName)}`,
    );
  }
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const loggerPrefix = opts.loggerPrefix ?? `[${opts.rootName}]`;
  const debug = opts.debug ?? false;

  function cacheRoot(): string {
    if (opts.rootDir && opts.rootDir.length > 0) {
      return resolve(opts.rootDir);
    }
    return resolve(join(tmpdir(), opts.rootName));
  }

  function buildBodyPath(
    kind: string,
    id: string | number,
    version: string | number,
  ): string {
    return join(
      cacheRoot(),
      sanitizeIdComponent(kind),
      `${sanitizeIdComponent(id)}-v${sanitizeIdComponent(version)}.json`,
    );
  }

  async function writeBody(
    kind: string,
    id: string | number,
    version: string | number,
    body: unknown,
  ): Promise<string> {
    const json = JSON.stringify(body);
    // Byte length, not String#length — String#length is UTF-16 code
    // units, which under-counts emoji and many CJK code points by ~2×.
    // The on-disk file is UTF-8, so the cap should match.
    const bytes = Buffer.byteLength(json, "utf-8");
    if (bytes > maxBytes) {
      throw new BodyCacheTooLargeError(bytes, maxBytes);
    }

    const path = buildBodyPath(kind, id, version);
    await mkdir(join(cacheRoot(), sanitizeIdComponent(kind)), {
      recursive: true,
    });

    const tmpPath = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmpPath, json, "utf-8");
    try {
      await rename(tmpPath, path);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
    return path;
  }

  async function readBody(path: string): Promise<unknown> {
    if (!isAbsolute(path)) {
      throw new Error(`bodyPath must be absolute: ${path}`);
    }
    const root = cacheRoot();
    const rel = relative(root, path);
    // `path.relative` produces an empty string when `path === root`,
    // a path starting with `..` when `path` is outside `root`, and an
    // absolute path on Windows when the two are on different drives.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `bodyPath is outside the cache root (${root}): ${path}`,
      );
    }
    const raw = await readFile(path, "utf-8");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`bodyPath does not contain valid JSON: ${path}`);
    }
  }

  async function prune(): Promise<void> {
    const root = cacheRoot();
    const cutoff = Date.now() - ttlMs;

    if (debug) {
      console.error(
        `${loggerPrefix} pruning ${root}, cutoff ${new Date(cutoff).toISOString()}`,
      );
    }

    let kinds: string[];
    try {
      kinds = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`${loggerPrefix} prune readdir(${root}) failed:`, err);
      }
      return;
    }

    await Promise.all(
      kinds.map(async (kind) => {
        const dir = join(root, kind);
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch (err) {
          console.error(
            `${loggerPrefix} prune readdir(${dir}) failed:`,
            err,
          );
          return;
        }
        await Promise.all(
          entries.map(async (entry) => {
            const p = join(dir, entry);
            try {
              const st = await stat(p);
              if (st.mtimeMs < cutoff) {
                await rm(p, { force: true });
              }
            } catch (err) {
              console.error(
                `${loggerPrefix} prune stat/rm(${p}) failed:`,
                err,
              );
            }
          }),
        );
      }),
    );
  }

  return { cacheRoot, writeBody, readBody, prune };
}
