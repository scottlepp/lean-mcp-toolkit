// Pooled, retry-aware HTTP transport.
//
// Every long-lived MCP server makes dozens of API calls per session.
// Native `fetch` opens a new TLS connection each time; undici's
// `Agent` with keep-alive + a small connection pool reuses sockets
// across calls. On top of that we layer a 429-aware retry that
// honors `Retry-After` (seconds or HTTP-date) and falls back to
// exponential backoff with jitter.
//
// The Agent is a module-level singleton, lazily created on first use.
// Tests can inject a stub via `__setTransportForTests` to skip the
// network entirely; the returned closure restores the previous
// transport so tests can compose.

import { Agent, request as undiciRequest } from "undici";

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  text: () => Promise<string>;
}

// Minimal transport shape callers can stub. Decoupled from undici so
// tests don't need to mock the whole module.
export type TransportFn = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

// --- Real transport ----------------------------------------------------

let poolAgent: Agent | null = null;

function getAgent(): Agent {
  if (!poolAgent) {
    poolAgent = new Agent({
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 60_000,
      connections: 8,
      pipelining: 1,
    });
  }
  return poolAgent;
}

// Graceful-shutdown hook. Hosts that hot-swap servers (or long-lived
// tests) should call this to release sockets and let the process exit
// cleanly.
export async function closeHttpPool(): Promise<void> {
  if (poolAgent) {
    await poolAgent.close();
    poolAgent = null;
  }
}

const realTransport: TransportFn = async (url, init) => {
  const res = await undiciRequest(url, {
    method: init.method as any,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    dispatcher: getAgent(),
  });
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    text: () => res.body.text(),
  };
};

let activeTransport: TransportFn = realTransport;

// --- Retry logic -------------------------------------------------------

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  // Overridable so tests can avoid real timers.
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Delay for a retry attempt. Honors `Retry-After` when the server
// sent one (numeric seconds OR HTTP-date); otherwise exponential
// backoff with jitter, capped at maxDelayMs.
export function computeBackoffMs(
  attempt: number,
  retryAfterHeader: string | undefined,
  opts: RetryOptions,
  now: number = Date.now(),
  random: () => number = Math.random,
): number {
  if (retryAfterHeader) {
    const asNumber = Number(retryAfterHeader);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.min(asNumber * 1000, opts.maxDelayMs);
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      // A past Retry-After (clock skew, queued response) means "retry
      // now" — return 0 rather than falling through to exponential
      // backoff, which would impose a spurious delay.
      const diff = asDate - now;
      return diff > 0 ? Math.min(diff, opts.maxDelayMs) : 0;
    }
  }
  const exp = opts.baseDelayMs * Math.pow(2, attempt);
  const jittered = exp * (0.5 + random() * 0.5);
  return Math.min(Math.round(jittered), opts.maxDelayMs);
}

function headerToString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

// Retrying transport. Issues `init` against the active transport,
// retries on 429 honoring backoff, returns the final HttpResponse.
export async function httpRequest(
  url: string,
  init: HttpRequestInit,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<HttpResponse> {
  const sleep = retry.sleep ?? defaultSleep;

  let lastResponse: HttpResponse | null = null;
  for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
    const res = await activeTransport(url, init);
    lastResponse = res;

    if (res.statusCode !== 429) return res;
    if (attempt === retry.maxRetries) return res;

    const retryAfter = headerToString(res.headers["retry-after"]);
    const delayMs = computeBackoffMs(attempt, retryAfter, retry);
    // Critical: drain the body before sleeping. undici's Agent only
    // returns the socket to the pool once the body is consumed; at
    // connections: 8, leaving bodies undrained starves the pool
    // within a handful of retries.
    await res.text().catch(() => undefined);
    await sleep(delayMs);
  }

  // Unreachable: the loop always returns. Narrow the type.
  return lastResponse as HttpResponse;
}

// --- Test hooks --------------------------------------------------------

// Replace the transport for the duration of a test. Returns a restore
// closure so tests can swap in a stub and then revert.
export function __setTransportForTests(fn: TransportFn): () => void {
  const prev = activeTransport;
  activeTransport = fn;
  return () => {
    activeTransport = prev;
  };
}
