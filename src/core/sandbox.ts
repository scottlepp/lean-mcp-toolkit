// Content-addressed disk cache for full API responses.
//
// Pattern: every MCP tool that returns a large/structured response
// writes the full JSON to disk (under $TMPDIR/<rootName>/<session>/<kind>/)
// and returns a small summary plus a `ref` filesystem path. Identical
// payloads hash to the same path, so duplicates are deduplicated
// across calls.
//
// Sessions are isolated by `MCP_SESSION_ID` (or process PID fallback).
// On server startup, sessions older than `staleMs` are removed.
//
// This module is server-agnostic. Each consumer (jira-mcp, confluence-mcp,
// bitbucket-mcp) calls `createSandbox({ rootName: "<server>" })` once at
// startup and shares the returned object across the codebase.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { SandboxOpts, SandboxResult } from "../types/refs.js";

// Session IDs become a single path segment under the cache root. Restrict
// to a safe charset so a malformed env var can't escape the session dir
// via "../" or collide with other sessions via case/whitespace tricks.
// Anything that doesn't match falls back to the pid.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

// Default: sessions older than 24h are cleaned up at server startup.
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

// Env var consulted when no explicit `sessionId` is passed. Standard
// across MCP hosts (Claude Code, Claude Desktop) so multiple servers
// running in one host share a session identifier.
const DEFAULT_SESSION_ENV_VAR = "MCP_SESSION_ID";

export interface CreateSandboxOpts {
  // Subdirectory name under os.tmpdir() that holds all sessions for
  // this server. Use a slug like "jira-mcp", "bitbucket-mcp".
  rootName: string;
  // Override the session id resolution. By default we read
  // `process.env[sessionEnvVar]` and fall back to process.pid.
  // Tests pass an explicit value.
  sessionId?: string;
  // Env var to consult for the session id. Defaults to "MCP_SESSION_ID".
  // Servers that need to disambiguate (or tests that want isolation)
  // can override.
  sessionEnvVar?: string;
  // How old a session must be before `cleanupStaleSessions` removes
  // it, in milliseconds. Defaults to 24h.
  staleMs?: number;
  // Override the tmpdir base. Tests pass a tmpdir; production uses
  // os.tmpdir().
  tmpDir?: string;
}

export interface CleanupError {
  session: string;
  message: string;
}

export interface CleanupResult {
  removed: string[];
  skipped: string[];
  errors: CleanupError[];
}

export interface SandboxInstance {
  rootCacheDir(): string;
  sessionCacheDir(): string;
  sandbox<TInput, TSummary>(
    response: TInput,
    opts: SandboxOpts<TInput, TSummary>,
  ): Promise<SandboxResult<TSummary>>;
  cleanupStaleSessions(now?: number): Promise<CleanupResult>;
  // Test-only: forget the cached session dir so env-var-driven session
  // id can be swapped between cases. Exported with a `__` prefix to
  // signal "internal".
  __resetSessionCacheDirForTests(): void;
}

export function createSandbox(opts: CreateSandboxOpts): SandboxInstance {
  if (!opts.rootName || !/^[A-Za-z0-9_.-]+$/.test(opts.rootName)) {
    throw new Error(
      `createSandbox: rootName must be a non-empty slug ([A-Za-z0-9_.-]+); got: ${JSON.stringify(opts.rootName)}`,
    );
  }
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const sessionEnvVar = opts.sessionEnvVar ?? DEFAULT_SESSION_ENV_VAR;
  const explicitSessionId = opts.sessionId;

  let cachedSessionDir: string | null = null;

  function resolveSessionId(): string {
    if (explicitSessionId !== undefined) {
      // Test/embedder-provided sessions still need the safety check —
      // they end up on disk as a path segment.
      if (SESSION_ID_PATTERN.test(explicitSessionId)) return explicitSessionId;
      return String(process.pid);
    }
    const fromEnv = process.env[sessionEnvVar]?.trim();
    if (fromEnv && SESSION_ID_PATTERN.test(fromEnv)) return fromEnv;
    return String(process.pid);
  }

  function rootCacheDir(): string {
    return path.join(tmpDir, opts.rootName);
  }

  function sessionCacheDir(): string {
    if (cachedSessionDir) return cachedSessionDir;
    cachedSessionDir = path.join(rootCacheDir(), resolveSessionId());
    return cachedSessionDir;
  }

  async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  function hashPayload(serialized: string): string {
    return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  }

  async function sandbox<TInput, TSummary>(
    response: TInput,
    sbOpts: SandboxOpts<TInput, TSummary>,
  ): Promise<SandboxResult<TSummary>> {
    const serialized = JSON.stringify(response, null, 2);
    const hash = hashPayload(serialized);
    const kindDir = path.join(sessionCacheDir(), sbOpts.kind);
    const filePath = path.join(kindDir, `${hash}.json`);

    // Intentional sync check: read-before-write atomicity for the
    // content-addressed cache. Two concurrent `sandbox()` calls with
    // the same hash must not both write. `fs.access` would split the
    // check and the write across event-loop ticks and introduce a
    // race window; `existsSync` completes in a single tick.
    if (!existsSync(filePath)) {
      await ensureDir(kindDir);
      await fs.writeFile(filePath, serialized, "utf8");
    }

    return {
      summary: sbOpts.summarize(response),
      ref: filePath,
      hash,
      fullSize: Buffer.byteLength(serialized, "utf8"),
      fetchedAt: new Date().toISOString(),
    };
  }

  // Delete session directories that haven't been touched in > staleMs.
  // Called once at server startup. Per-entry failures are captured in
  // `errors` rather than thrown — a permission problem on one stale
  // dir shouldn't block server startup, but the caller still gets
  // enough diagnostic info to surface or log the failure.
  async function cleanupStaleSessions(
    now: number = Date.now(),
  ): Promise<CleanupResult> {
    const root = rootCacheDir();
    const removed: string[] = [];
    const skipped: string[] = [];
    const errors: CleanupError[] = [];

    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { removed, skipped, errors };
      }
      throw err;
    }

    const currentSession = path.basename(sessionCacheDir());

    await Promise.all(
      entries.map(async (name) => {
        if (name === currentSession) {
          skipped.push(name);
          return;
        }
        const full = path.join(root, name);
        try {
          const stat = await fs.stat(full);
          if (!stat.isDirectory()) {
            skipped.push(name);
            return;
          }
          if (now - stat.mtimeMs > staleMs) {
            await fs.rm(full, { recursive: true, force: true });
            removed.push(name);
          } else {
            skipped.push(name);
          }
        } catch (err) {
          errors.push({
            session: name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    return { removed, skipped, errors };
  }

  return {
    rootCacheDir,
    sessionCacheDir,
    sandbox,
    cleanupStaleSessions,
    __resetSessionCacheDirForTests() {
      cachedSessionDir = null;
    },
  };
}
