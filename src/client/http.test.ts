import { describe, expect, it } from "vitest";

import { HttpClientError, createHttpClient } from "./http.js";

// Note: end-to-end request tests would need either undici's
// MockAgent or a real server; both are heavier than is justified for
// this lift. These tests cover the configuration plumbing and the
// HttpClientError shape; the body behavior (redirects, 204, error
// path) is exercised by the bitbucket-mcp consumer tests against
// recorded fixtures.

describe("createHttpClient", () => {
  it("returns a client with the Client interface methods + getText", () => {
    const c = createHttpClient({
      baseUrl: "https://example.test",
      auth: { kind: "bearer", token: "xx" },
      userAgent: "test/1.0",
    });
    expect(typeof c.get).toBe("function");
    expect(typeof c.post).toBe("function");
    expect(typeof c.put).toBe("function");
    expect(typeof c.delete).toBe("function");
    expect(typeof c.getText).toBe("function");
  });

  it("accepts basic / bearer / custom auth without throwing", () => {
    expect(() =>
      createHttpClient({
        baseUrl: "https://x",
        auth: { kind: "basic", username: "u", password: "p" },
        userAgent: "ua",
      }),
    ).not.toThrow();
    expect(() =>
      createHttpClient({
        baseUrl: "https://x",
        auth: { kind: "bearer", token: "t" },
        userAgent: "ua",
      }),
    ).not.toThrow();
    expect(() =>
      createHttpClient({
        baseUrl: "https://x",
        auth: { kind: "custom", header: () => "X-Auth abc" },
        userAgent: "ua",
      }),
    ).not.toThrow();
  });
});

describe("HttpClientError", () => {
  it("carries status code and response payload", () => {
    const e = new HttpClientError("nope", 404, { error: { message: "nope" } });
    expect(e.name).toBe("HttpClientError");
    expect(e.statusCode).toBe(404);
    expect(e.response).toEqual({ error: { message: "nope" } });
    expect(e instanceof Error).toBe(true);
  });
});
