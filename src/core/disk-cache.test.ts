import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { readDiskCache, writeDiskCache } from "./disk-cache.js";

describe("disk-cache", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ultra-mcp-toolkit-disk-cache-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("rejects scopes outside the safe charset", async () => {
    await expect(
      writeDiskCache({ rootDir, scope: "../escape" }, "k", { x: 1 }),
    ).rejects.toThrow(/scope must match/);
    await expect(readDiskCache({ rootDir, scope: "bad scope" }, "k")).rejects.toThrow(
      /scope must match/,
    );
  });

  it("round-trips a value", async () => {
    await writeDiskCache({ rootDir, scope: "tenant" }, "host:a", { id: "abc" });
    const got = await readDiskCache<{ id: string }>(
      { rootDir, scope: "tenant" },
      "host:a",
    );
    expect(got).toEqual({ id: "abc" });
  });

  it("returns undefined past TTL", async () => {
    await writeDiskCache({ rootDir, scope: "s" }, "k", { hello: "world" });
    const fresh = await readDiskCache(
      { rootDir, scope: "s", ttlMs: 100 },
      "k",
      Date.now() + 200,
    );
    expect(fresh).toBeUndefined();
  });

  it("isolates scopes (same key in different scopes does not collide)", async () => {
    await writeDiskCache({ rootDir, scope: "a" }, "k", { v: 1 });
    await writeDiskCache({ rootDir, scope: "b" }, "k", { v: 2 });
    expect(await readDiskCache({ rootDir, scope: "a" }, "k")).toEqual({ v: 1 });
    expect(await readDiskCache({ rootDir, scope: "b" }, "k")).toEqual({ v: 2 });
  });

  it("returns undefined on a missing key (no throw)", async () => {
    expect(await readDiskCache({ rootDir, scope: "nope" }, "missing")).toBeUndefined();
  });

  it("returns undefined on a corrupted file (no throw)", async () => {
    // Manually plant a corrupt file at the address the implementation would write to.
    await writeDiskCache({ rootDir, scope: "s" }, "k", { v: 1 });
    const file = await findOnlyJsonFile(path.join(rootDir, "s"));
    await fs.writeFile(file, "not json{{{", "utf8");
    expect(await readDiskCache({ rootDir, scope: "s" }, "k")).toBeUndefined();
  });

  it("returns undefined on a stored value missing required envelope fields", async () => {
    await writeDiskCache({ rootDir, scope: "s" }, "k", { v: 1 });
    const file = await findOnlyJsonFile(path.join(rootDir, "s"));
    await fs.writeFile(file, JSON.stringify({ junk: true }), "utf8");
    expect(await readDiskCache({ rootDir, scope: "s" }, "k")).toBeUndefined();
  });

  it("re-writing overwrites the prior value", async () => {
    await writeDiskCache({ rootDir, scope: "s" }, "k", { v: 1 });
    await writeDiskCache({ rootDir, scope: "s" }, "k", { v: 2 });
    expect(await readDiskCache({ rootDir, scope: "s" }, "k")).toEqual({ v: 2 });
  });
});

async function findOnlyJsonFile(dir: string): Promise<string> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  if (files.length !== 1) throw new Error(`expected 1 json file, got ${files.length}`);
  return path.join(dir, files[0]);
}
