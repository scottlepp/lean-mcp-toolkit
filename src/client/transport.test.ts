import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY,
  __setTransportForTests,
  computeBackoffMs,
  httpRequest,
  type HttpResponse,
  type TransportFn,
} from "./transport.js";

function makeResponse(
  statusCode: number,
  headers: Record<string, string | string[] | undefined> = {},
  body: string = "",
): HttpResponse {
  let consumed = false;
  return {
    statusCode,
    headers,
    text: async () => {
      if (consumed) throw new Error("body already consumed");
      consumed = true;
      return body;
    },
  };
}

describe("computeBackoffMs", () => {
  const opts = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 10_000 };

  it("honors numeric Retry-After (seconds)", () => {
    expect(computeBackoffMs(0, "2", opts)).toBe(2000);
    expect(computeBackoffMs(0, "0", opts)).toBe(0);
  });

  it("caps numeric Retry-After at maxDelayMs", () => {
    expect(computeBackoffMs(0, "999", opts)).toBe(10_000);
  });

  it("honors HTTP-date Retry-After", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const future = new Date(now + 3000).toUTCString();
    expect(computeBackoffMs(0, future, opts, now)).toBe(3000);
  });

  it("returns 0 for past HTTP-date (no spurious wait)", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const past = new Date(now - 10_000).toUTCString();
    expect(computeBackoffMs(0, past, opts, now)).toBe(0);
  });

  it("falls back to exponential + jitter when no header", () => {
    // Fixed random for determinism: 0.5 → multiplier exactly 0.75.
    expect(computeBackoffMs(0, undefined, opts, 0, () => 0.5)).toBe(375);
    expect(computeBackoffMs(2, undefined, opts, 0, () => 0.5)).toBe(1500);
  });

  it("caps exponential backoff at maxDelayMs", () => {
    expect(computeBackoffMs(20, undefined, opts, 0, () => 1)).toBe(10_000);
  });
});

describe("httpRequest", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("returns the response unchanged for non-429", async () => {
    let calls = 0;
    const fn: TransportFn = async () => {
      calls++;
      return makeResponse(200, {}, "ok");
    };
    restore = __setTransportForTests(fn);
    const res = await httpRequest("https://x", { method: "GET", headers: {} });
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(1);
  });

  it("retries on 429 honoring numeric Retry-After", async () => {
    const slept: number[] = [];
    const fn: TransportFn = async () => {
      return slept.length === 0
        ? makeResponse(429, { "retry-after": "1" }, "rate limited")
        : makeResponse(200, {}, "ok");
    };
    restore = __setTransportForTests(fn);
    const res = await httpRequest(
      "https://x",
      { method: "GET", headers: {} },
      { ...DEFAULT_RETRY, sleep: async (ms) => void slept.push(ms) },
    );
    expect(res.statusCode).toBe(200);
    expect(slept).toEqual([1000]);
  });

  it("retries on 429 honoring HTTP-date Retry-After", async () => {
    const slept: number[] = [];
    const fn: TransportFn = async () => {
      const future = new Date(Date.now() + 2500).toUTCString();
      return slept.length === 0
        ? makeResponse(429, { "retry-after": future }, "rate limited")
        : makeResponse(200, {}, "ok");
    };
    restore = __setTransportForTests(fn);
    const res = await httpRequest(
      "https://x",
      { method: "GET", headers: {} },
      { ...DEFAULT_RETRY, sleep: async (ms) => void slept.push(ms) },
    );
    expect(res.statusCode).toBe(200);
    expect(slept.length).toBe(1);
    // Allow a small clock-jitter window — the resolver computes
    // (asDate - now) at call time so the value is not exactly 2500.
    expect(slept[0]).toBeGreaterThan(1500);
    expect(slept[0]).toBeLessThanOrEqual(2500);
  });

  it("past Retry-After date results in zero sleep", async () => {
    const slept: number[] = [];
    const fn: TransportFn = async () => {
      const past = new Date(Date.now() - 10_000).toUTCString();
      return slept.length === 0
        ? makeResponse(429, { "retry-after": past }, "rate limited")
        : makeResponse(200, {}, "ok");
    };
    restore = __setTransportForTests(fn);
    await httpRequest(
      "https://x",
      { method: "GET", headers: {} },
      { ...DEFAULT_RETRY, sleep: async (ms) => void slept.push(ms) },
    );
    expect(slept).toEqual([0]);
  });

  it("returns the last 429 after exhausting maxRetries", async () => {
    let calls = 0;
    const fn: TransportFn = async () => {
      calls++;
      return makeResponse(429, { "retry-after": "0" }, "still");
    };
    restore = __setTransportForTests(fn);
    const res = await httpRequest(
      "https://x",
      { method: "GET", headers: {} },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, sleep: async () => undefined },
    );
    expect(res.statusCode).toBe(429);
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("drains the body between attempts so the socket is released", async () => {
    const drained: boolean[] = [];
    const fn: TransportFn = async () => {
      const res = makeResponse(
        drained.length === 0 ? 429 : 200,
        { "retry-after": "0" },
        "payload",
      );
      const orig = res.text;
      res.text = async () => {
        drained.push(true);
        return orig();
      };
      return res;
    };
    restore = __setTransportForTests(fn);
    await httpRequest(
      "https://x",
      { method: "GET", headers: {} },
      { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10, sleep: async () => undefined },
    );
    // The 429 body was drained between attempts; the 200 body is left
    // for the caller. drained should contain exactly one true.
    expect(drained.length).toBe(1);
  });

  it("the test transport hook restores after closure invocation", async () => {
    const stub: TransportFn = async () => makeResponse(200, {}, "stubbed");
    const cleanup = __setTransportForTests(stub);
    const res = await httpRequest("https://x", { method: "GET", headers: {} });
    expect(res.statusCode).toBe(200);
    cleanup();
    // After cleanup the active transport is back to whatever it was
    // — we can't easily inspect it without making a real network
    // call, but installing a new stub and observing it is enough.
    const stub2: TransportFn = async () => makeResponse(204, {}, "");
    restore = __setTransportForTests(stub2);
    const res2 = await httpRequest("https://x", { method: "GET", headers: {} });
    expect(res2.statusCode).toBe(204);
  });
});
