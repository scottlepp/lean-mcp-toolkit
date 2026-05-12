// Generic streaming download primitive.
//
// Tools that fetch large binaries (attachments, generated reports,
// build artifacts) want to hand the agent a local path, not the raw
// bytes — a 50 MB attachment must never hit Node's heap. This module
// streams a URL to disk, returns metadata + checksum, and protects
// against double-consumption / path traversal.
//
// Vendor-neutral on purpose. The toolkit ships no "issue" or
// "attachment" concept; consumers pass a `targetDir` and an arbitrary
// `filename`, and the primitive guarantees the resulting path is
// under `targetDir`.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { request as undiciRequest } from "undici";

// --- Filename sanitization --------------------------------------------

// Filenames become path segments, so we strip anything that could
// break out of the intended directory or trip the filesystem.
const UNSAFE_CHARS = /[/\\\x00]/g;
const LEADING_DOTS = /^\.+/;

export function sanitizeFilename(name: string): string {
  // Drop any path components a caller might smuggle in.
  let base = name.split(/[/\\]/).pop() ?? "";
  base = base.replace(UNSAFE_CHARS, "_");
  // Also strip other ASCII control characters (\x01-\x1F, \x7F).
  base = base.replace(/[\x01-\x1F\x7F]/g, "_");
  base = base.replace(LEADING_DOTS, "");
  base = base.replace(/\s+/g, " ").trim();
  // Cap length to keep ext4/APFS/NTFS happy (all cap at 255).
  if (base.length > 200) {
    const dot = base.lastIndexOf(".");
    if (dot > 0 && base.length - dot <= 16) {
      const ext = base.slice(dot);
      base = `${base.slice(0, 200 - ext.length)}${ext}`;
    } else {
      base = base.slice(0, 200);
    }
  }
  if (base.length === 0) base = "download";
  return base;
}

// --- Single-consumption guard -----------------------------------------

// HTTP response bodies are one-shot streams. Code paths that read
// `body` (for streaming to disk) and then `text()` (for error
// surfacing) must not collide. This wrapper makes accidental
// double-consumption fail loudly rather than quietly return garbage.

export interface SingleConsumptionResponse {
  statusCode: number;
  body: Readable;
  bodyText: () => Promise<string>;
}

export function guardSingleConsumption(
  statusCode: number,
  underlying: {
    stream: () => Readable;
    text: () => Promise<string>;
  },
): SingleConsumptionResponse {
  let consumed: "none" | "stream" | "text" = "none";
  return {
    statusCode,
    get body(): Readable {
      if (consumed === "text") {
        throw new Error("Response body already consumed via bodyText()");
      }
      if (consumed === "stream") {
        throw new Error("Response body already consumed via body getter");
      }
      consumed = "stream";
      return underlying.stream();
    },
    bodyText: () => {
      if (consumed === "stream") {
        return Promise.reject(
          new Error("Response body already consumed via stream"),
        );
      }
      if (consumed === "text") {
        return Promise.reject(
          new Error("Response body already consumed via bodyText()"),
        );
      }
      consumed = "text";
      return underlying.text();
    },
  };
}

// --- Transport --------------------------------------------------------

export type DownloadTransport = (
  url: string,
  init: { method: "GET"; headers: Record<string, string> },
) => Promise<SingleConsumptionResponse>;

const defaultTransport: DownloadTransport = async (url, init) => {
  const res = await undiciRequest(url, {
    method: init.method,
    headers: init.headers,
  });
  return guardSingleConsumption(res.statusCode, {
    stream: () => Readable.from(res.body),
    text: () => res.body.text(),
  });
};

// --- Public API -------------------------------------------------------

export interface DownloadRef {
  absolutePath: string;
  size: number;
  sha256: string;
}

export interface DownloadToFileOpts {
  url: string;
  headers?: Record<string, string>;
  targetDir: string;
  filename: string;
  // Overridable for tests.
  transport?: DownloadTransport;
}

// Stream `url` to `targetDir/sanitize(filename)`. Atomic: writes to a
// `.partial` file and renames on success; the rename means a partial
// file from an interrupted download never poses as the real one.
// Returns absolute path, byte length, and sha256 of the bytes written.
export async function downloadToFile(opts: DownloadToFileOpts): Promise<DownloadRef> {
  const transport = opts.transport ?? defaultTransport;
  const filename = sanitizeFilename(opts.filename);
  const targetPath = path.join(opts.targetDir, filename);
  // Defense in depth: even after sanitizeFilename strips separators,
  // assert the resolved path is under targetDir. A future regression
  // in sanitizeFilename can't escape.
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDir = path.resolve(opts.targetDir);
  if (!resolvedTarget.startsWith(resolvedDir + path.sep) && resolvedTarget !== resolvedDir) {
    throw new Error(`Refusing to download outside targetDir: ${resolvedTarget}`);
  }

  await fs.mkdir(opts.targetDir, { recursive: true });

  const res = await transport(opts.url, {
    method: "GET",
    headers: opts.headers ?? {},
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const errText = await res.bodyText().catch(() => "");
    throw new Error(
      `Download failed for ${opts.url}: HTTP ${res.statusCode} ${errText.slice(0, 200)}`,
    );
  }

  // Temp + rename for atomicity. Random suffix so two concurrent
  // downloads of the same target don't corrupt each other.
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.partial`;
  try {
    await pipeline(res.body, createWriteStream(tempPath));
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }

  const stat = await fs.stat(targetPath);
  const sha256 = await hashFile(targetPath);
  return {
    absolutePath: targetPath,
    size: stat.size,
    sha256,
  };
}

async function hashFile(p: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(p), hash);
  return hash.digest("hex");
}
