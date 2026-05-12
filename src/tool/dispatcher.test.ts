import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Client } from "../client/index.js";
import { createTrimRegistry } from "../core/trim-registry.js";
import type { Manifest } from "../core/manifest.js";

import {
  DispatchError,
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
    expect(Object.keys(schema.properties)).toEqual(["action"]);
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
});
