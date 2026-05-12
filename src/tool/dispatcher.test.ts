import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Client } from "../client/index.js";
import { createTrimRegistry } from "../core/trim-registry.js";
import type { Manifest } from "../core/manifest.js";

import {
  DispatchError,
  FULL_META_KEY,
  ToolError,
  buildInputSchema,
  dispatch,
  type ConsolidatedToolDef,
} from "./dispatcher.js";

const manifest: Manifest = [
  {
    name: "thing.get",
    description: "fetch",
    verb: "GET",
    pathTemplate: "/things/{id}",
    params: [{ name: "id", role: "path", required: true }],
    trim: "thing",
  },
];

const trimRegistry = createTrimRegistry({
  thing: (x: unknown) => ({ trimmed: x }),
});

function makeStubClient(): Client {
  return {
    async get(path) {
      return { from: "get", path };
    },
    async post() { return {}; },
    async put() { return {}; },
    async delete() { return {}; },
  };
}

const tool: ConsolidatedToolDef = {
  name: "test_tool",
  description: "test",
  actions: {
    get: {
      operation: "thing.get",
      schema: z.object({ id: z.string() }),
      description: "fetch one",
    },
  },
};

describe("buildInputSchema", () => {
  it("declares action enum from action keys", () => {
    const schema = buildInputSchema(tool);
    expect(schema.required).toContain("action");
    expect(schema.properties.action.enum).toEqual(["get"]);
  });

  it("hoists per-action fields into top-level properties with descriptions", () => {
    const multi: ConsolidatedToolDef = {
      name: "thing",
      description: "things",
      actions: {
        get: {
          operation: "thing.get",
          schema: z.object({
            id: z.number().int().positive().describe("the id"),
            workspace: z.string().optional(),
          }),
          description: "fetch",
        },
        list: {
          operation: "thing.list",
          schema: z.object({
            q: z.string().optional().describe("BBQL filter"),
            workspace: z.string().optional(),
          }),
          description: "list",
        },
      },
    };
    const schema = buildInputSchema(multi);
    // Action is required, everything else optional at top level.
    expect(schema.required).toEqual(["action"]);
    // Per-action fields surfaced.
    expect(schema.properties.id).toBeDefined();
    expect(schema.properties.id.type).toBe("integer");
    expect(schema.properties.q).toBeDefined();
    // Shared field shows up once, annotated with both actions.
    expect(schema.properties.workspace).toBeDefined();
    expect(schema.properties.workspace.description).toMatch(/used by: get, list/);
    // Action-specific fields are annotated with their single action.
    expect(schema.properties.id.description).toMatch(/used by: get\)/);
    expect(schema.properties.q.description).toMatch(/used by: list\)/);
    // additionalProperties: false forces LLMs to use declared fields.
    expect(schema.additionalProperties).toBe(false);
  });

  it("survives an action with no schema", () => {
    const tool: ConsolidatedToolDef = {
      name: "thing",
      description: "things",
      actions: {
        get: { operation: "thing.get", description: "fetch" }, // no schema
      },
    };
    const schema = buildInputSchema(tool);
    expect(schema.properties.action.enum).toEqual(["get"]);
    // `action` and the `full` meta-arg are always present.
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "full"]);
  });
});

describe("dispatch", () => {
  it("routes valid input to the manifest operation", async () => {
    const r = await dispatch(
      tool,
      { action: "get", id: "abc" },
      { manifest, client: makeStubClient(), trimRegistry },
    );
    expect(r.result).toEqual({ trimmed: { from: "get", path: "/things/abc" } });
  });

  it("throws DispatchError on missing action", async () => {
    await expect(
      dispatch(tool, { id: "abc" }, { manifest, client: makeStubClient(), trimRegistry }),
    ).rejects.toBeInstanceOf(DispatchError);
  });

  it("throws DispatchError on unknown action", async () => {
    await expect(
      dispatch(tool, { action: "bogus", id: "x" }, { manifest, client: makeStubClient(), trimRegistry }),
    ).rejects.toBeInstanceOf(DispatchError);
  });

  it("throws on invalid args via Zod", async () => {
    await expect(
      dispatch(tool, { action: "get", id: 42 }, { manifest, client: makeStubClient(), trimRegistry }),
    ).rejects.toThrow(/invalid args/);
  });

  it("preprocess hook fills in optional fields after validation", async () => {
    const toolWithOptional: ConsolidatedToolDef = {
      name: "test_tool",
      description: "test",
      actions: {
        get: {
          operation: "thing.get",
          schema: z.object({
            id: z.string(),
            workspace: z.string().optional(),
          }),
          description: "fetch one",
        },
      },
    };
    let capturedPath = "";
    const client: Client = {
      async get(path) {
        capturedPath = path;
        return { ok: true };
      },
      async post() { return {}; },
      async put() { return {}; },
      async delete() { return {}; },
    };

    const manifestWithWorkspace: Manifest = [
      {
        name: "thing.get",
        description: "fetch",
        verb: "GET",
        pathTemplate: "/workspaces/{workspace}/things/{id}",
        params: [
          { name: "workspace", role: "path", required: true },
          { name: "id", role: "path", required: true },
        ],
        trim: "thing",
      },
    ];

    await dispatch(
      toolWithOptional,
      { action: "get", id: "abc" },
      {
        manifest: manifestWithWorkspace,
        client,
        trimRegistry,
        preprocess: (_op, args) =>
          args.workspace ? args : { ...args, workspace: "default-ws" },
      },
    );
    expect(capturedPath).toBe("/workspaces/default-ws/things/abc");
  });

  it("custom handler bypasses the manifest", async () => {
    const tool: ConsolidatedToolDef = {
      name: "test_tool",
      description: "test",
      actions: {
        custom: {
          schema: z.object({ msg: z.string() }),
          description: "custom handler",
          handler: async (args) => ({ echoed: args.msg }),
        },
      },
    };
    const r = await dispatch(
      tool,
      { action: "custom", msg: "hi" },
      { manifest: [], client: makeStubClient(), trimRegistry },
    );
    expect(r.result).toEqual({ echoed: "hi" });
  });

  it("throws when action has neither operation nor handler", async () => {
    const bad: ConsolidatedToolDef = {
      name: "test_tool",
      description: "test",
      actions: {
        broken: { description: "missing both" },
      },
    };
    await expect(
      dispatch(bad, { action: "broken" }, { manifest: [], client: makeStubClient(), trimRegistry }),
    ).rejects.toBeInstanceOf(DispatchError);
  });

  it("full: true returns the raw response (skipping trim)", async () => {
    const r = await dispatch(
      tool,
      { action: "get", id: "abc", [FULL_META_KEY]: true },
      { manifest, client: makeStubClient(), trimRegistry },
    );
    // Trim wraps in { trimmed: ... }; raw bypasses it.
    expect(r.result).toEqual({ from: "get", path: "/things/abc" });
  });

  it("omitting full returns the trimmed envelope", async () => {
    const r = await dispatch(
      tool,
      { action: "get", id: "abc" },
      { manifest, client: makeStubClient(), trimRegistry },
    );
    expect(r.result).toEqual({ trimmed: { from: "get", path: "/things/abc" } });
  });

  it("full: true on a mutation (POST) is rejected", async () => {
    const mutationManifest: Manifest = [
      {
        name: "thing.create",
        description: "create",
        verb: "POST",
        pathTemplate: "/things",
        params: [],
        trim: "thing",
      },
    ];
    const mutationTool: ConsolidatedToolDef = {
      name: "thing",
      description: "things",
      actions: {
        create: {
          operation: "thing.create",
          schema: z.object({}),
          description: "create",
        },
      },
    };
    await expect(
      dispatch(
        mutationTool,
        { action: "create", [FULL_META_KEY]: true },
        { manifest: mutationManifest, client: makeStubClient(), trimRegistry },
      ),
    ).rejects.toThrow(/only valid for read-shaped/);
  });

  it("full as a non-boolean value is rejected", async () => {
    await expect(
      dispatch(
        tool,
        { action: "get", id: "abc", [FULL_META_KEY]: "yes" },
        { manifest, client: makeStubClient(), trimRegistry },
      ),
    ).rejects.toThrow(/must be a boolean/);
  });

  it("ToolError is interchangeable with DispatchError", () => {
    const e = new ToolError("nope", "act");
    expect(e instanceof DispatchError).toBe(true);
    expect(e instanceof ToolError).toBe(true);
    expect(e.action).toBe("act");

    const d = new DispatchError("nope", "act");
    expect(d instanceof DispatchError).toBe(true);
    // The plan asks for "ToolError instanceof DispatchError and vice
    // versa." `DispatchError instanceof ToolError` is structurally
    // false (the parent class isn't an instance of the subclass), but
    // we can verify catch sites that target the parent see a thrown
    // ToolError, which is the actual interop guarantee.
    expect((d as unknown) instanceof ToolError).toBe(false);
  });

  it("attaches tool name when dispatch throws on missing action", async () => {
    let caught: unknown;
    try {
      await dispatch(tool, { id: "abc" }, { manifest, client: makeStubClient(), trimRegistry });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchError);
    expect((caught as DispatchError).tool).toBe(tool.name);
  });

  it("attaches tool name on Zod validation failure", async () => {
    let caught: unknown;
    try {
      await dispatch(tool, { action: "get", id: 42 }, { manifest, client: makeStubClient(), trimRegistry });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DispatchError);
    expect((caught as DispatchError).tool).toBe(tool.name);
    expect((caught as DispatchError).action).toBe("get");
  });

  it("ToolError thrown as DispatchError retains the tool field", () => {
    const e: DispatchError = new ToolError("nope", "act", "test_tool");
    expect(e instanceof DispatchError).toBe(true);
    expect(e instanceof ToolError).toBe(true);
    expect(e.tool).toBe("test_tool");
    expect(e.action).toBe("act");
  });

  it("buildInputSchema surfaces the full flag", () => {
    const schema = buildInputSchema(tool);
    expect(schema.properties[FULL_META_KEY]).toBeDefined();
    expect(schema.properties[FULL_META_KEY].type).toBe("boolean");
  });
});
