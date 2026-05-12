// Generic HTTP client factory.
//
// Wraps `undici.request` with the patterns every MCP server's API
// client needs but routinely re-implements: redirect following (the
// /diff endpoint on Bitbucket 302s to a signed CDN URL — a footgun
// that breaks naive clients), 204 → `{}` for JSON / `""` for raw,
// best-effort JSON parse on the error path so structured errors
// surface in the thrown Error, and a separate `getText()` for text
// endpoints.
//
// Auth is pluggable: Basic, Bearer, or a fully custom header
// generator (for OAuth flows, signed requests, etc.).

import { request } from "undici";

import type { Client, QueryParams } from "./index.js";
import { httpRequest, type RetryOptions } from "./transport.js";

export type HttpAuth =
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string }
  | { kind: "custom"; header: () => string };

export interface HttpClientOpts {
  baseUrl: string;
  auth: HttpAuth;
  // Used as the User-Agent header. Most APIs require / strongly
  // prefer a stable client-identifying UA.
  userAgent: string;
  // undici's max redirect chain length. Default 5 — enough for the
  // signed-URL hop on /diff and similar endpoints; high enough that
  // a runaway redirect loop still fails fast.
  maxRedirections?: number;
  // Opt in to retry + the pooled Agent transport. Omit to preserve
  // the v0.2 single-shot behavior (raw `undici.request`, no pool).
  // The retry layer handles 429 honoring Retry-After and falls back
  // to exponential backoff with jitter.
  retry?: RetryOptions;
}

export class HttpClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    // Best-effort JSON-parsed response body. Undefined if the body
    // was empty or not parseable as JSON.
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = "HttpClientError";
  }
}

export interface HttpClient extends Client {
  // Variant for endpoints that return text/plain (diffs, logs).
  // Returns the raw response body as a string. Throws
  // HttpClientError on non-2xx (with best-effort JSON-decoded body
  // attached if present).
  getText(path: string, queryParams?: QueryParams): Promise<string>;
}

interface InternalRequestOpts {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  queryParams?: QueryParams;
  body?: unknown;
  // When set, override the Accept header (default "application/json").
  accept?: string;
  // When true, return the raw response text on success instead of
  // parsing as JSON. Used by getText() for text endpoints.
  raw?: boolean;
}

export function createHttpClient(opts: HttpClientOpts): HttpClient {
  const baseUrl = opts.baseUrl;
  const userAgent = opts.userAgent;
  const maxRedirections = opts.maxRedirections ?? 5;
  const retry = opts.retry;
  const authResolver = makeAuthResolver(opts.auth);

  function buildUrl(path: string, queryParams?: QueryParams): string {
    const url = new URL(`${baseUrl}${path}`);
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value === undefined) continue;
        url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  async function doRequest(reqOpts: InternalRequestOpts): Promise<unknown> {
    const url = buildUrl(reqOpts.path, reqOpts.queryParams);
    const headers: Record<string, string> = {
      Authorization: authResolver(),
      Accept: reqOpts.accept ?? "application/json",
      "User-Agent": userAgent,
    };
    let bodyPayload: string | undefined;
    if (
      reqOpts.body !== undefined &&
      reqOpts.method !== "GET" &&
      reqOpts.method !== "DELETE"
    ) {
      headers["Content-Type"] = "application/json";
      bodyPayload = JSON.stringify(reqOpts.body);
    }

    let statusCode: number;
    let text: string;
    if (retry) {
      // Retry+pool path. Note: the retry transport doesn't currently
      // follow redirects — endpoints that 302 to signed CDN URLs
      // (e.g. bitbucket's /diff) should stay on the single-shot path
      // until the transport grows redirect handling.
      const res = await httpRequest(url, { method: reqOpts.method, headers, body: bodyPayload }, retry);
      statusCode = res.statusCode;
      text = await res.text();
    } else {
      const res = await request(url, {
        method: reqOpts.method,
        headers,
        body: bodyPayload,
        // Critical for endpoints that 302 to a signed CDN URL
        // (e.g. bitbucket's /diff). Without this the response body is
        // the redirect notice, not the actual payload.
        maxRedirections,
      });
      statusCode = res.statusCode;
      text = await res.body.text();
    }

    if (statusCode === 204) {
      return reqOpts.raw ? "" : {};
    }

    // Best-effort JSON parse for the error path even when raw=true,
    // so we can surface a structured error message.
    let parsed: unknown = undefined;
    let parseError: Error | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        parseError = err as Error;
      }
    }

    const ok = statusCode >= 200 && statusCode < 300;
    if (!ok) {
      const msg = extractErrorMessage(parsed) ?? text ?? `HTTP ${statusCode}`;
      throw new HttpClientError(msg, statusCode, parsed);
    }

    // raw mode: return the body verbatim regardless of content type.
    if (reqOpts.raw) {
      return text;
    }
    // Successful non-JSON response (rare for JSON endpoints).
    if (parseError) {
      return text;
    }
    return parsed ?? {};
  }

  return {
    async get(path, queryParams) {
      return doRequest({ method: "GET", path, queryParams });
    },
    async getText(path, queryParams) {
      return doRequest({
        method: "GET",
        path,
        queryParams,
        accept: "text/plain",
        raw: true,
      }) as Promise<string>;
    },
    async post(path, body, queryParams) {
      return doRequest({ method: "POST", path, body, queryParams });
    },
    async put(path, body, queryParams) {
      return doRequest({ method: "PUT", path, body, queryParams });
    },
    async delete(path, queryParams) {
      return doRequest({ method: "DELETE", path, queryParams });
    },
  };
}

// --- Internal helpers --------------------------------------------------

function makeAuthResolver(auth: HttpAuth): () => string {
  switch (auth.kind) {
    case "basic": {
      const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
      const header = `Basic ${credentials}`;
      return () => header;
    }
    case "bearer": {
      const header = `Bearer ${auth.token}`;
      return () => header;
    }
    case "custom":
      return auth.header;
  }
}

// Best-effort extraction of a human-readable message from a parsed
// error response. Covers the common shapes:
//   - Bitbucket: { error: { message, detail } }
//   - Jira / Atlassian: { errorMessages: ["..."], errors: {...} }
//   - Plain { message: "..." }
// Returns undefined if nothing recognizable found; caller falls back
// to raw body text or "HTTP <status>".
function extractErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const p = parsed as Record<string, unknown>;

  // { error: { message?, detail? } }
  if (p.error && typeof p.error === "object") {
    const err = p.error as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
    if (typeof err.detail === "string") return err.detail;
  }
  // { errorMessages: ["..."] }
  if (Array.isArray(p.errorMessages) && p.errorMessages.length > 0) {
    const first = p.errorMessages[0];
    if (typeof first === "string") return first;
  }
  // { message: "..." }
  if (typeof p.message === "string") return p.message;
  return undefined;
}
