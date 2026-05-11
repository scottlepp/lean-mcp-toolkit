import { describe, expect, it, vi } from "vitest";

import type { Client } from "../client/index.js";
import {
  type Manifest,
  type Operation,
  OperationError,
  assertOperationEnabled,
  defaultExecute,
  extractPathParams,
  findOperation,
  interpolatePath,
  invokeOperation,
  invokeOperationRaw,
  splitArgs,
} from "./manifest.js";
import { createTrimRegistry } from "./trim-registry.js";

const stubClient = (): Client & {
  calls: Array<{ verb: string; path: string; body?: unknown; q?: unknown }>;
} => {
  const calls: Array<{ verb: string; path: string; body?: unknown; q?: unknown }> = [];
  return {
    calls,
    async get(path, q) {
      calls.push({ verb: "GET", path, q });
      return { ok: true, path };
    },
    async post(path, body, q) {
      calls.push({ verb: "POST", path, body, q });
      return { ok: true, path, body };
    },
    async put(path, body, q) {
      calls.push({ verb: "PUT", path, body, q });
      return { ok: true, path, body };
    },
    async delete(path, q) {
      calls.push({ verb: "DELETE", path, q });
      return { ok: true, path };
    },
  };
};

describe("path templating", () => {
  it("extractPathParams pulls out placeholders", () => {
    expect(extractPathParams("/issue/{key}/comment/{commentId}")).toEqual([
      "key",
      "commentId",
    ]);
    expect(extractPathParams("/no-placeholders")).toEqual([]);
  });

  it("interpolatePath URI-encodes values", () => {
    expect(interpolatePath("/issue/{key}", { key: "PROJ-1" })).toBe(
      "/issue/PROJ-1",
    );
    expect(interpolatePath("/issue/{key}", { key: "hello world" })).toBe(
      "/issue/hello%20world",
    );
  });

  it("interpolatePath throws on missing required placeholder", () => {
    expect(() => interpolatePath("/issue/{key}", {})).toThrow(
      /Missing required path parameter: key/,
    );
  });
});

describe("splitArgs", () => {
  const op: Operation = {
    name: "issue.update",
    description: "update",
    verb: "PUT",
    pathTemplate: "/issue/{key}",
    params: [
      { name: "key", role: "path", required: true },
      { name: "expand", role: "query" },
      { name: "fields", role: "body" },
      { name: "summary", role: "body" },
    ],
  };

  it("buckets args by role", () => {
    const r = splitArgs(op, {
      key: "PROJ-1",
      expand: "names",
      fields: { foo: 1 },
      summary: "new",
    });
    expect(r.pathParams).toEqual({ key: "PROJ-1" });
    expect(r.queryParams).toEqual({ expand: "names" });
    expect(r.body).toEqual({ fields: { foo: 1 }, summary: "new" });
    expect(r.unknown).toEqual([]);
    expect(r.missingRequired).toEqual([]);
  });

  it("flags missing required params", () => {
    const r = splitArgs(op, { expand: "names" });
    expect(r.missingRequired).toContain("key");
  });

  it("collects unknown args", () => {
    const r = splitArgs(op, { key: "K", bogus: 1 });
    expect(r.unknown).toEqual(["bogus"]);
  });

  it("returns undefined body when no body params provided", () => {
    const r = splitArgs(op, { key: "K" });
    expect(r.body).toBeUndefined();
  });

  it("treats null the same as undefined for required check", () => {
    const r = splitArgs(op, { key: null });
    expect(r.missingRequired).toContain("key");
  });
});

describe("findOperation + assertOperationEnabled", () => {
  const manifest: Manifest = [
    { name: "a.get", description: "", verb: "GET", pathTemplate: "/a", params: [] },
  ];

  it("findOperation returns op by name", () => {
    expect(findOperation(manifest, "a.get").name).toBe("a.get");
  });

  it("findOperation throws OperationError on miss", () => {
    expect(() => findOperation(manifest, "no.op")).toThrow(OperationError);
  });

  it("assertOperationEnabled passes by default", () => {
    expect(() => assertOperationEnabled("a.get", undefined)).not.toThrow();
    expect(() => assertOperationEnabled("a.get", [])).not.toThrow();
  });

  it("assertOperationEnabled throws on listed action", () => {
    expect(() => assertOperationEnabled("a.get", ["a.get"])).toThrow(
      OperationError,
    );
  });
});

describe("defaultExecute", () => {
  it("dispatches GET via client.get", async () => {
    const c = stubClient();
    await defaultExecute({
      op: { name: "x", description: "", verb: "GET", pathTemplate: "/x", params: [] },
      client: c,
      path: "/x",
      queryParams: { a: 1 },
      body: undefined,
    });
    expect(c.calls).toEqual([{ verb: "GET", path: "/x", q: { a: 1 } }]);
  });

  it("dispatches POST with body", async () => {
    const c = stubClient();
    await defaultExecute({
      op: { name: "x", description: "", verb: "POST", pathTemplate: "/x", params: [] },
      client: c,
      path: "/x",
      queryParams: {},
      body: { hello: "world" },
    });
    expect(c.calls[0].verb).toBe("POST");
    expect(c.calls[0].body).toEqual({ hello: "world" });
  });
});

describe("invokeOperationRaw", () => {
  const manifest: Manifest = [
    {
      name: "issue.get",
      description: "fetch",
      verb: "GET",
      pathTemplate: "/issue/{key}",
      params: [
        { name: "key", role: "path", required: true },
        { name: "fields", role: "query" },
      ],
      trim: "issue",
    },
    {
      name: "watcher.add",
      description: "add",
      verb: "POST",
      pathTemplate: "/issue/{key}/watchers",
      params: [
        { name: "key", role: "path", required: true },
        { name: "accountId", role: "body", required: true },
      ],
      bodyShape: "rawString",
      trim: "issue",
    },
  ];

  it("invokes with interpolated path and normalized query", async () => {
    const c = stubClient();
    const r = await invokeOperationRaw(manifest, c, "issue.get", {
      key: "PROJ-1",
      fields: ["summary", "status"],
    });
    expect(c.calls[0].path).toBe("/issue/PROJ-1");
    expect(c.calls[0].q).toEqual({ fields: "summary,status" });
    expect(r.op.name).toBe("issue.get");
  });

  it("rawString bodyShape forwards the single body param verbatim", async () => {
    const c = stubClient();
    await invokeOperationRaw(manifest, c, "watcher.add", {
      key: "PROJ-1",
      accountId: "acc123",
    });
    expect(c.calls[0].verb).toBe("POST");
    expect(c.calls[0].body).toBe("acc123");
  });

  it("rejects missing required params with OperationError", async () => {
    const c = stubClient();
    await expect(
      invokeOperationRaw(manifest, c, "issue.get", {}),
    ).rejects.toThrow(OperationError);
  });

  it("honors disabledActions", async () => {
    const c = stubClient();
    await expect(
      invokeOperationRaw(manifest, c, "issue.get", { key: "K" }, {
        disabledActions: ["issue.get"],
      }),
    ).rejects.toThrow(OperationError);
    expect(c.calls).toHaveLength(0);
  });

  it("allows a custom execute hook to override routing", async () => {
    const c = stubClient();
    const customExecute = vi.fn(async () => ({ custom: true }));
    const r = await invokeOperationRaw(manifest, c, "issue.get", { key: "K" }, {
      execute: customExecute,
    });
    expect(customExecute).toHaveBeenCalledOnce();
    expect(r.response).toEqual({ custom: true });
    expect(c.calls).toHaveLength(0);
  });
});

describe("invokeOperation", () => {
  const manifest: Manifest = [
    {
      name: "issue.get",
      description: "fetch",
      verb: "GET",
      pathTemplate: "/issue/{key}",
      params: [{ name: "key", role: "path", required: true }],
      trim: "issue",
    },
    {
      name: "raw.get",
      description: "no trim",
      verb: "GET",
      pathTemplate: "/raw",
      params: [],
    },
  ];

  it("applies trim projection by registry key", async () => {
    const c = stubClient();
    const registry = createTrimRegistry({
      issue: (x: unknown) => ({ trimmed: true, original: x }),
    });
    const r = await invokeOperation(manifest, c, "issue.get", { key: "K" }, registry);
    expect(r).toEqual({ trimmed: true, original: { ok: true, path: "/issue/K" } });
  });

  it("passes response through unchanged when op has no trim", async () => {
    const c = stubClient();
    const registry = createTrimRegistry({});
    const r = await invokeOperation(manifest, c, "raw.get", {}, registry);
    expect(r).toEqual({ ok: true, path: "/raw" });
  });

  it("silently skips trim if key is missing from registry", async () => {
    const c = stubClient();
    const registry = createTrimRegistry({}); // empty
    const r = await invokeOperation(manifest, c, "issue.get", { key: "K" }, registry);
    expect(r).toEqual({ ok: true, path: "/issue/K" }); // unchanged
  });
});
