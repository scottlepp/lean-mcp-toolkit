// Generic dispatcher for consolidated MCP tools.
//
// Each consolidated tool (jira_issue, bitbucket_pullrequest,
// confluence_page, ...) follows the same shape: an `action`
// discriminator on input, a per-action Zod schema, and a manifest
// operation it routes to. This module factors out the common dispatch
// logic so every server doesn't reimplement it.
//
// Two dispatch paths are supported per action:
//   - `operation`: route through the SDK's invokeOperation against
//                   the consumer's manifest.
//   - `handler`:   custom callback that bypasses the manifest entirely.
//                  Used for actions that need text responses, server-
//                  side filtering, or other shapes the manifest can't
//                  express.

import { z, type ZodTypeAny } from "zod";

import {
  findOperation,
  invokeOperation,
  invokeOperationRaw,
  type InvokeOptions,
  type Manifest,
} from "../core/manifest.js";
import type { Client } from "../client/index.js";
import type { TrimRegistry } from "../core/trim-registry.js";

// Meta-arg key the dispatcher peels off before per-action Zod
// validation. Setting it to `true` bypasses the trim projection and
// returns the raw API response — escape hatch for actions whose
// trimmed shape drops content the caller needs.
export const FULL_META_KEY = "full";

export interface ToolAction {
  // Manifest operation name (`pullrequest.get`, etc.). Required for
  // standard manifest-dispatched actions; omit when supplying a
  // custom `handler` instead.
  operation?: string;
  // Per-action Zod schema. Validates and coerces flat args after the
  // dispatcher strips the `action` discriminator. Optional — actions
  // without input beyond the discriminator pass z.object({}).
  schema?: ZodTypeAny;
  // Per-action description rendered in tool listing JSON.
  description: string;
  // Custom handler that bypasses the manifest/invokeOperation path.
  // When present, the dispatcher calls this instead of routing through
  // the SDK. Used for actions that need text responses, server-side
  // filtering, or other special handling that the manifest can't
  // express.
  handler?: (args: Record<string, unknown>, ctx: DispatcherContext) => Promise<unknown>;
}

export interface ConsolidatedToolDef {
  name: string;
  description: string;
  actions: Record<string, ToolAction>;
}

export interface DispatcherContext {
  manifest: Manifest;
  client: Client;
  trimRegistry: TrimRegistry;
  invokeOptions?: InvokeOptions;
  // Pre-process resolved args before dispatch (e.g. inject a default
  // workspace, project key, or other context-derived defaults).
  // Identity by default.
  preprocess?: (operation: string, args: Record<string, unknown>) => Record<string, unknown>;
}

// Shape compatible with what we hand back to MCP hosts. Loose typing
// because JSON Schema has many optional fields and we don't enforce
// them here — the JSON is consumed by clients, not by us.
export interface MergedActionInputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: boolean;
}

// Per-action spec used by mergeActionSchemas. Consolidated tools and
// custom (non-consolidated) tools that still want the merge behavior
// can shape their actions this way.
export interface ActionSchemaSpec {
  schema?: ZodTypeAny;
  description: string;
}

// Union the per-action Zod schemas into one flat JSON Schema object
// suitable for an MCP tool's `inputSchema`. Why flat instead of
// `oneOf` discriminated: MCP clients render unions inconsistently;
// a flat schema with rich per-field descriptions is more reliably
// rendered and read by LLMs.
//
// Required-ness at the top level is just `action` — per-action
// required fields are enforced at runtime by the dispatcher's Zod
// validation. The JSON Schema serves as a *menu* for the LLM, not
// the source of truth for validation.
export function mergeActionSchemas(
  actions: Record<string, ActionSchemaSpec>,
): MergedActionInputSchema {
  const actionNames = Object.keys(actions);

  const properties: Record<string, Record<string, unknown>> = {
    action: {
      type: "string",
      enum: actionNames,
      description: Object.entries(actions)
        .map(([name, a]) => `\`${name}\`: ${a.description}`)
        .join(" | "),
    },
  };

  // Track which actions reference each field so we can annotate the
  // description ("used by: get, list"). Helps the LLM pick which
  // fields to send for a given action.
  const fieldToActions: Record<string, string[]> = {};

  for (const [actionName, action] of Object.entries(actions)) {
    if (!action.schema) continue;
    let jsonSchema: Record<string, unknown>;
    try {
      // `io: "input"` surfaces the *caller-facing* shape, which
      // matters for actions that use `.transform()` to reshape into
      // the API's nested body shape (e.g. flat `content` + `inline_path`
      // reshaped to nested `{ content: { raw }, inline: { path } }`).
      jsonSchema = z.toJSONSchema(action.schema, { io: "input" }) as Record<string, unknown>;
    } catch {
      // Schema not convertible at all (extremely unusual); skip
      // silently so a single weird action doesn't break the tool.
      continue;
    }
    const props = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props) continue;
    for (const [fieldName, fieldSchema] of Object.entries(props)) {
      if (fieldName === "action") continue;
      if (!fieldToActions[fieldName]) fieldToActions[fieldName] = [];
      fieldToActions[fieldName].push(actionName);
      // First action to declare a field wins. In practice fields
      // shared across actions should have matching definitions (same
      // type, same description); this is a defensive default rather
      // than a correctness mechanism.
      if (!properties[fieldName]) {
        properties[fieldName] = { ...fieldSchema };
      }
    }
  }

  // Annotate each non-action field with its applicable actions.
  for (const [field, actionList] of Object.entries(fieldToActions)) {
    const prop = properties[field];
    const original = typeof prop.description === "string" ? `${prop.description} ` : "";
    prop.description = `${original}(used by: ${actionList.join(", ")})`;
  }

  // Surface the `full` meta-arg as a declared top-level field so a
  // strict `additionalProperties: false` schema doesn't reject calls
  // that use the escape hatch. The dispatcher strips `full` before
  // per-action Zod validation, so it never reaches the action schema.
  properties[FULL_META_KEY] = {
    type: "boolean",
    description:
      "If true, skip the trim projection and return the raw API response. Only valid for read-shaped (GET) actions.",
  };

  return {
    type: "object",
    properties,
    required: ["action"],
    // `false` forces the LLM to use declared fields — fewer guesses,
    // earlier rejection of typos. Runtime Zod still enforces per-
    // action shape after the dispatcher strips `action`.
    additionalProperties: false,
  };
}

// Build the MCP tool input schema for a consolidated tool. Thin wrapper
// around mergeActionSchemas; kept as a named export for stability.
export function buildInputSchema(tool: ConsolidatedToolDef): MergedActionInputSchema {
  return mergeActionSchemas(tool.actions);
}

export interface DispatchResult {
  // The trimmed projection of the operation's response.
  result: unknown;
}

export class DispatchError extends Error {
  constructor(message: string, public readonly action: string) {
    super(message);
    this.name = "DispatchError";
  }
}

// Alias for callers that prefer the "tool error" name. Same shape;
// preserved so consumers migrating from a per-server class don't have
// to rename catch sites. `ToolError instanceof DispatchError` and the
// reverse are both true.
export class ToolError extends DispatchError {
  constructor(message: string, action: string) {
    super(message, action);
    this.name = "ToolError";
  }
}

// Dispatch one tool invocation. Validates the action, parses
// per-action args via the action's schema, applies the optional
// preprocess hook, and routes through the SDK's `invokeOperation`
// (or the action's custom handler).
export async function dispatch(
  tool: ConsolidatedToolDef,
  rawArgs: unknown,
  ctx: DispatcherContext,
): Promise<DispatchResult> {
  if (!rawArgs || typeof rawArgs !== "object") {
    throw new DispatchError(
      `${tool.name}: expected an object input with an "action" field; got ${typeof rawArgs}`,
      "",
    );
  }
  const argsObj = rawArgs as Record<string, unknown>;
  const actionName = argsObj.action;
  if (typeof actionName !== "string") {
    throw new DispatchError(
      `${tool.name}: missing required "action" field (one of: ${Object.keys(tool.actions).join(", ")})`,
      "",
    );
  }
  const action = tool.actions[actionName];
  if (!action) {
    throw new DispatchError(
      `${tool.name}: unknown action "${actionName}". Valid: ${Object.keys(tool.actions).join(", ")}`,
      actionName,
    );
  }

  // Peel off `full` before per-action Zod validation so strict schemas
  // don't reject it as an unknown field. We validate the type here and
  // strip the key from the args.
  const fullRaw = argsObj[FULL_META_KEY];
  if (fullRaw !== undefined && typeof fullRaw !== "boolean") {
    throw new DispatchError(
      `${tool.name}.${actionName}: \`${FULL_META_KEY}\` must be a boolean if provided`,
      actionName,
    );
  }
  const wantFull = fullRaw === true;

  // Strip the action discriminator and `full` meta-arg, then validate
  // the rest.
  const { action: _drop, [FULL_META_KEY]: _drop2, ...flatArgs } = argsObj;
  let validated: Record<string, unknown> = flatArgs;
  if (action.schema) {
    const parsed = action.schema.safeParse(flatArgs);
    if (!parsed.success) {
      // Zod's `prettifyError` lands the issue list in a compact form
      // the agent can act on. Fallback to JSON in case of older zod.
      const detail = z.prettifyError(parsed.error);
      throw new DispatchError(
        `${tool.name}.${actionName}: invalid args:\n${detail}`,
        actionName,
      );
    }
    validated = parsed.data as Record<string, unknown>;
  }

  // Custom handler path: bypass the manifest/invokeOperation flow
  // entirely. Used for actions that fetch text, run server-side
  // filters, or otherwise need shapes the manifest can't express.
  if (action.handler) {
    if (wantFull) {
      throw new DispatchError(
        `${tool.name}.${actionName}: \`${FULL_META_KEY}\` is only valid for manifest-dispatched actions, not custom handlers`,
        actionName,
      );
    }
    const result = await action.handler(validated, ctx);
    return { result };
  }

  // Standard manifest dispatch path.
  if (!action.operation) {
    throw new DispatchError(
      `${tool.name}.${actionName}: action has neither \`operation\` nor \`handler\` — one is required`,
      actionName,
    );
  }
  const finalArgs = ctx.preprocess
    ? ctx.preprocess(action.operation, validated)
    : validated;

  if (wantFull) {
    // `full: true` only makes sense for read-shaped (GET) ops. Mutation
    // verbs go through the mutation-ack envelope, not a trim
    // projection, so bypassing the trim doesn't surface anything new.
    const op = findOperation(ctx.manifest, action.operation);
    if (op.verb !== "GET") {
      throw new DispatchError(
        `${tool.name}.${actionName}: \`${FULL_META_KEY}\` is only valid for read-shaped (GET) actions; ${action.operation} is ${op.verb}`,
        actionName,
      );
    }
    const { response } = await invokeOperationRaw(
      ctx.manifest,
      ctx.client,
      action.operation,
      finalArgs,
      ctx.invokeOptions,
    );
    return { result: response };
  }

  const result = await invokeOperation(
    ctx.manifest,
    ctx.client,
    action.operation,
    finalArgs,
    ctx.trimRegistry,
    ctx.invokeOptions,
  );

  return { result };
}
