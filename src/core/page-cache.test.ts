import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { BodyCacheTooLargeError, createPageCache } from "./page-cache.js";

describe("createPageCache", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toolkit-pc-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("rejects invalid rootName", () => {
    expect(() => createPageCache({ rootName: "" })).toThrow();
    expect(() => createPageCache({ rootName: "../escape" })).toThrow();
  });

  it("writes and reads back the body", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir });
    const p = await c.writeBody("things", 42, 1, { hello: "world" });
    expect(p.endsWith("things/42-v1.json")).toBe(true);
    const read = await c.readBody(p);
    expect(read).toEqual({ hello: "world" });
  });

  it("supports string versions (e.g. head SHA)", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir });
    const p = await c.writeBody("diffs", "pr-123", "9f8e7d6", { d: 1 });
    expect(p.endsWith("diffs/pr-123-v9f8e7d6.json")).toBe(true);
    const read = await c.readBody(p);
    expect(read).toEqual({ d: 1 });
  });

  it("sanitizes path traversal characters in id/kind", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir });
    const p = await c.writeBody("../bad", "../../etc/passwd", 1, { x: 1 });
    expect(p.includes("..")).toBe(false);
    // The sanitized path should resolve under the cache root.
    expect(p.startsWith(c.cacheRoot())).toBe(true);
  });

  it("throws BodyCacheTooLargeError when payload exceeds maxBytes", async () => {
    const c = createPageCache({
      rootName: "test-mcp",
      rootDir,
      maxBytes: 100,
    });
    await expect(
      c.writeBody("things", 1, 1, { x: "a".repeat(200) }),
    ).rejects.toBeInstanceOf(BodyCacheTooLargeError);
  });

  it("readBody rejects paths outside the cache root", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir });
    await expect(c.readBody("/etc/passwd")).rejects.toThrow(/outside the cache root/);
  });

  it("readBody rejects relative paths", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir });
    await expect(c.readBody("relative/file.json")).rejects.toThrow(/must be absolute/);
  });

  it("readBody rejects non-JSON file", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir });
    const dir = path.join(c.cacheRoot(), "things");
    await fs.mkdir(dir, { recursive: true });
    const badPath = path.join(dir, "broken-v1.json");
    await fs.writeFile(badPath, "not json{");
    await expect(c.readBody(badPath)).rejects.toThrow(/valid JSON/);
  });

  it("overwrites previous version with new write (rename semantics)", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir });
    const p1 = await c.writeBody("things", 42, 1, { v: 1 });
    const p2 = await c.writeBody("things", 42, 1, { v: 2 });
    expect(p1).toBe(p2);
    expect(await c.readBody(p1)).toEqual({ v: 2 });
  });

  it("prune removes entries older than ttlMs", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir, ttlMs: 1000 });
    const p = await c.writeBody("things", 1, 1, { x: 1 });
    // Backdate it.
    const past = new Date(Date.now() - 10 * 1000);
    await fs.utimes(p, past, past);

    await c.prune();
    await expect(fs.access(p)).rejects.toThrow();
  });

  it("prune keeps fresh entries", async () => {
    const c = createPageCache({ rootName: "test-mcp", rootDir, ttlMs: 10 * 60 * 1000 });
    const p = await c.writeBody("things", 1, 1, { x: 1 });
    await c.prune();
    await expect(fs.access(p)).resolves.toBeUndefined();
  });

  it("prune is a no-op when cache root doesn't exist", async () => {
    const c = createPageCache({
      rootName: "never-touched",
      rootDir: path.join(rootDir, "never"),
    });
    await expect(c.prune()).resolves.toBeUndefined();
  });
});
