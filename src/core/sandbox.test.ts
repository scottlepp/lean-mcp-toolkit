import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createSandbox } from "./sandbox.js";

describe("createSandbox", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ultra-mcp-toolkit-sandbox-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects invalid rootName", () => {
    expect(() => createSandbox({ rootName: "" })).toThrow();
    expect(() => createSandbox({ rootName: "../escape" })).toThrow();
    expect(() => createSandbox({ rootName: "bad name" })).toThrow();
  });

  it("writes a content-addressed file and returns summary + ref", async () => {
    const sb = createSandbox({ rootName: "test-mcp", sessionId: "s1", tmpDir });
    const result = await sb.sandbox(
      { id: 1, body: "hello" },
      { kind: "thing", summarize: (x) => ({ id: x.id }) },
    );
    expect(result.summary).toEqual({ id: 1 });
    expect(result.ref).toContain("test-mcp");
    expect(result.ref).toContain("s1");
    expect(result.ref).toContain("thing");
    expect(result.ref.endsWith(".json")).toBe(true);

    const onDisk = await fs.readFile(result.ref, "utf8");
    expect(JSON.parse(onDisk)).toEqual({ id: 1, body: "hello" });
  });

  it("deduplicates identical payloads under the same hash", async () => {
    const sb = createSandbox({ rootName: "test-mcp", sessionId: "s1", tmpDir });
    const r1 = await sb.sandbox(
      { x: 1 },
      { kind: "k", summarize: (x) => x },
    );
    const r2 = await sb.sandbox(
      { x: 1 },
      { kind: "k", summarize: (x) => x },
    );
    expect(r1.hash).toBe(r2.hash);
    expect(r1.ref).toBe(r2.ref);
  });

  it("isolates sessions by sessionId", async () => {
    const a = createSandbox({ rootName: "test-mcp", sessionId: "a", tmpDir });
    const b = createSandbox({ rootName: "test-mcp", sessionId: "b", tmpDir });
    expect(a.sessionCacheDir()).not.toBe(b.sessionCacheDir());
    expect(a.rootCacheDir()).toBe(b.rootCacheDir());
  });

  it("falls back to pid when sessionId fails the safety pattern", () => {
    const sb = createSandbox({
      rootName: "test-mcp",
      sessionId: "../escape",
      tmpDir,
    });
    expect(sb.sessionCacheDir()).toContain(String(process.pid));
  });

  it("cleanupStaleSessions removes sessions older than staleMs", async () => {
    const sb = createSandbox({
      rootName: "test-mcp",
      sessionId: "current",
      tmpDir,
      staleMs: 1000,
    });
    // Create a fake stale session directory.
    const staleDir = path.join(sb.rootCacheDir(), "stale-session");
    await fs.mkdir(staleDir, { recursive: true });
    // Backdate it.
    const past = new Date(Date.now() - 10 * 1000);
    await fs.utimes(staleDir, past, past);

    // Create an in-flight call so the current session dir exists too.
    await sb.sandbox({ a: 1 }, { kind: "k", summarize: (x) => x });

    const res = await sb.cleanupStaleSessions();
    expect(res.removed).toContain("stale-session");
    expect(res.skipped).toContain("current");
  });

  it("cleanupStaleSessions returns empty result when root doesn't exist", async () => {
    const sb = createSandbox({
      rootName: "never-touched",
      sessionId: "s1",
      tmpDir,
    });
    const res = await sb.cleanupStaleSessions();
    expect(res).toEqual({ removed: [], skipped: [], errors: [] });
  });
});
