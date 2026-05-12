import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import {
  downloadToFile,
  guardSingleConsumption,
  sanitizeFilename,
  type DownloadTransport,
} from "./streaming.js";

describe("sanitizeFilename", () => {
  it("strips path separators", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a\\b\\c.txt")).toBe("c.txt");
  });

  it("strips null bytes and control chars", () => {
    expect(sanitizeFilename("file\x00name")).toBe("file_name");
    expect(sanitizeFilename("a\x01b\x1fc")).toBe("a_b_c");
  });

  it("strips leading dots (no hidden files)", () => {
    expect(sanitizeFilename(".env")).toBe("env");
    expect(sanitizeFilename("..hidden")).toBe("hidden");
  });

  it("substitutes a default for fully-empty results", () => {
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename("...")).toBe("download");
    expect(sanitizeFilename("/")).toBe("download");
  });

  it("caps length while preserving the last short extension", () => {
    // lastIndexOf("."), so multi-segment extensions reduce to the
    // trailing piece — ".tar.gz" → ".gz" at the cap.
    const long = "x".repeat(300) + ".gz";
    const r = sanitizeFilename(long);
    expect(r.length).toBeLessThanOrEqual(200);
    expect(r.endsWith(".gz")).toBe(true);
  });

  it("caps length when there is no short extension", () => {
    const long = "y".repeat(300);
    expect(sanitizeFilename(long).length).toBe(200);
  });
});

describe("guardSingleConsumption", () => {
  it("permits one stream read, then rejects further access", () => {
    const wrapped = guardSingleConsumption(200, {
      stream: () => Readable.from(["body"]),
      text: async () => "body",
    });
    // First read OK.
    const _stream = wrapped.body;
    expect(_stream).toBeDefined();
    // Second access throws.
    expect(() => wrapped.body).toThrow(/already consumed/);
    return expect(wrapped.bodyText()).rejects.toThrow(/already consumed/);
  });

  it("permits one text read, then rejects further access", async () => {
    const wrapped = guardSingleConsumption(200, {
      stream: () => Readable.from(["body"]),
      text: async () => "body",
    });
    await expect(wrapped.bodyText()).resolves.toBe("body");
    await expect(wrapped.bodyText()).rejects.toThrow(/already consumed/);
    expect(() => wrapped.body).toThrow(/already consumed/);
  });
});

describe("downloadToFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toolkit-stream-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function fakeTransport(body: Buffer, statusCode = 200): DownloadTransport {
    return async () =>
      guardSingleConsumption(statusCode, {
        stream: () => Readable.from(body),
        text: async () => body.toString("utf8"),
      });
  }

  it("writes bytes to disk and returns absolutePath/size/sha256", async () => {
    const payload = Buffer.from("hello world");
    const expectedHash = createHash("sha256").update(payload).digest("hex");
    const ref = await downloadToFile({
      url: "https://x/y",
      filename: "out.txt",
      targetDir: tmpDir,
      transport: fakeTransport(payload),
    });
    expect(ref.absolutePath).toBe(path.join(tmpDir, "out.txt"));
    expect(ref.size).toBe(payload.length);
    expect(ref.sha256).toBe(expectedHash);

    const onDisk = await fs.readFile(ref.absolutePath);
    expect(onDisk.equals(payload)).toBe(true);
  });

  it("produces stable sha256 across calls with identical payloads", async () => {
    const payload = Buffer.from("repeatable");
    const a = await downloadToFile({
      url: "https://x/a",
      filename: "a.bin",
      targetDir: tmpDir,
      transport: fakeTransport(payload),
    });
    const b = await downloadToFile({
      url: "https://x/b",
      filename: "b.bin",
      targetDir: tmpDir,
      transport: fakeTransport(payload),
    });
    expect(a.sha256).toBe(b.sha256);
  });

  it("sanitizes the filename before writing", async () => {
    const ref = await downloadToFile({
      url: "https://x/y",
      filename: "../../etc/passwd",
      targetDir: tmpDir,
      transport: fakeTransport(Buffer.from("safe")),
    });
    expect(ref.absolutePath).toBe(path.join(tmpDir, "passwd"));
    const stat = await fs.stat(ref.absolutePath);
    expect(stat.isFile()).toBe(true);
  });

  it("writes atomically (no .partial files remain on success)", async () => {
    await downloadToFile({
      url: "https://x/y",
      filename: "atomic.bin",
      targetDir: tmpDir,
      transport: fakeTransport(Buffer.from("done")),
    });
    const entries = await fs.readdir(tmpDir);
    expect(entries.every((e) => !e.includes(".partial"))).toBe(true);
    expect(entries).toContain("atomic.bin");
  });

  it("throws on non-2xx status with the server message", async () => {
    const transport = fakeTransport(Buffer.from("not found"), 404);
    await expect(
      downloadToFile({
        url: "https://x/y",
        filename: "missing.bin",
        targetDir: tmpDir,
        transport,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});
