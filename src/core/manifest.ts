// Central operation manifest.
//
// Single declaration of every operation an MCP server exposes. Two
// consumers read this at runtime:
//
//   - Layer 2 (classic MCP tools): a consolidated tool like
//     `jira_issue` takes `{ action, ...args }` and dispatches through
//     `invokeOperation` against the manifest entry whose name matches.
//
//   - Layer 3 (code-api): a bundled CLI binary reads this manifest to
//     validate `<resource>.<op>` invocations from the command line,
//     build `--help` output, and forward calls over the local IPC
//     bridge.
//
// The manifest is deliberately stringly-typed: operations declare
// their params by name + role (path/query/body), not by a static
// TypeScript shape. Validation/coercion is the dispatcher's job.
// Keeping the manifest shape small means we can iterate it generically
// without type gymnastics.

import type { Client, QueryParams } from "../client/index.js";
import type { TrimRegistry } from "./trim-registry.js";

// --- Types ------------------------------------------------------------

export type HttpVerb = "GET" | "POST" | "PUT" | "DELETE";

export type ParamRole = "path" | "query" | "body";

export interface ParamSpec {
  name: string;
  role: ParamRole;
  required?: boolean;
  description?: string;
}

// How the request body is shaped on the wire.
//
//   "object"    (default) — body params are wrapped into a single
//                JSON object: { paramA: ..., paramB: ... }. This is
//                what 99% of REST endpoints expect.
//   "rawString" — the operation must declare exactly one body param.
//                That param's value is sent as a raw JSON string body
//                (e.g. `"acc123"`, with quotes). Required by the
//                handful of endpoints that take a bare scalar rather
//                than an object.
export type BodyShape = "object" | "rawString";

// Per-server metadata bag. The SDK ignores its contents; servers use
// it to drive their own `ExecuteFn` (e.g. jira marks operations with
// `meta: { isAgile: true }` to route to the agile API base URL).
export type OperationMeta = Record<string, unknown>;

export interface Operation {
  // Stable identifier — stable across minor versions. The CLI accepts
  // this verbatim as its positional argument (`jira-cli issue.get
  // ...`) and uses it to look up the right entry in the manifest.
  name: string;
  // Human-readable single-line summary. Surfaces in CLI `--help`
  // listings and in Layer 2 tool schemas.
  description: string;
  verb: HttpVerb;
  // Path template with `{paramName}` placeholders. Every placeholder
  // must appear in `params` with `role: "path"`.
  pathTemplate: string;
  params: ParamSpec[];
  // How body params are serialized on the wire. Defaults to "object".
  bodyShape?: BodyShape;
  // Optional: trim projection key. Looked up in the registry passed
  // to `invokeOperation`. The SDK doesn't enforce a key set; the
  // registry's key type is parameterized so servers get type safety.
  trim?: string;
  // Server-specific routing hints. SDK is agnostic. Servers consume
  // via `ExecuteFn`.
  meta?: OperationMeta;
}

export type Manifest = readonly Operation[];

// --- Path templating ---------------------------------------------------

// Extract all `{name}` placeholders from a template. Exported because
// manifest test suites assert every placeholder shows up as a
// `role: "path"` param.
export function extractPathParams(template: string): string[] {
  const out: string[] = [];
  const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const match of template.matchAll(re)) out.push(match[1]);
  return out;
}

// Substitute `{name}` placeholders with URI-encoded values from args.
// Throws if a required placeholder is missing — callers should have
// validated already, but the dispatcher double-checks.
export function interpolatePath(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = args[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

// --- Argument partitioning ---------------------------------------------

export interface SplitArgs {
  pathParams: Record<string, unknown>;
  queryParams: Record<string, unknown>;
  body: Record<string, unknown> | undefined;
  unknown: string[];
  missingRequired: string[];
}

export function splitArgs(
  op: Operation,
  args: Record<string, unknown>,
): SplitArgs {
  const pathParams: Record<string, unknown> = {};
  const queryParams: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  const known = new Set<string>();
  const missingRequired: string[] = [];
  let hasBody = false;

  for (const spec of op.params) {
    known.add(spec.name);
    const raw = args[spec.name];
    // Treat explicit null the same as undefined: it can't satisfy a
    // required param, and it'd be wrong to forward as a path segment
    // or JSON body value. Falling through would produce a plain Error
    // from interpolatePath instead of the OperationError callers
    // expect.
    if (raw === undefined || raw === null) {
      if (spec.required) missingRequired.push(spec.name);
      continue;
    }
    switch (spec.role) {
      case "path":
        pathParams[spec.name] = raw;
        break;
      case "query":
        queryParams[spec.name] = raw;
        break;
      case "body":
        body[spec.name] = raw;
        hasBody = true;
        break;
    }
  }

  const unknown = Object.keys(args).filter((k) => !known.has(k));

  return {
    pathParams,
    queryParams,
    body: hasBody ? body : undefined,
    unknown,
    missingRequired,
  };
}

// --- Errors ------------------------------------------------------------

export class OperationError extends Error {
  constructor(message: string, public readonly operationName: string) {
    super(message);
    this.name = "OperationError";
  }
}

// --- Lookup + guards --------------------------------------------------

export function findOperation(manifest: Manifest, name: string): Operation {
  const op = manifest.find((o) => o.name === name);
  if (!op) {
    throw new OperationError(`Unknown operation: ${name}`, name);
  }
  return op;
}

export function assertOperationEnabled(
  name: string,
  disabledActions: readonly string[] | undefined,
): void {
  if (!disabledActions || disabledActions.length === 0) return;
  if (disabledActions.includes(name)) {
    throw new OperationError(
      `Operation ${name} is disabled.`,
      name,
    );
  }
}

// --- Execute hook -----------------------------------------------------

// `ExecuteFn` is the per-server hook for routing a fully-resolved
// operation call to the right underlying HTTP method. The SDK ships a
// `defaultExecute` that dispatches on `op.verb` against the supplied
// Client. Servers with multi-API routing (jira's agile-vs-platform)
// supply their own implementation that inspects `op.meta`.
export interface ExecuteContext {
  op: Operation;
  client: Client;
  path: string;
  queryParams: QueryParams;
  body: unknown;
}

export type ExecuteFn = (ctx: ExecuteContext) => Promise<unknown>;

export const defaultExecute: ExecuteFn = async (ctx) => {
  const { op, client, path, queryParams, body } = ctx;
  switch (op.verb) {
    case "GET":
      return client.get(path, queryParams);
    case "POST":
      return client.post(path, body, queryParams);
    case "PUT":
      return client.put(path, body, queryParams);
    case "DELETE":
      return client.delete(path, queryParams);
  }
};

// --- Dispatcher --------------------------------------------------------

// Normalizes raw query param values into the QueryParams shape Clients
// expect. Arrays collapse to comma-separated strings (the common REST
// convention); objects are JSON-stringified as a fallback.
function normalizeQueryParams(
  raw: Record<string, unknown>,
): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      out[k] = v.map((x) => String(x)).join(",");
    } else if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

export interface InvokeOptions {
  // The user's blocklist of operations (typically loaded from a
  // server-specific env var). When set, calls to listed ops throw
  // OperationError before any HTTP request.
  disabledActions?: readonly string[];
  // Per-server execution hook. Defaults to verb dispatch over the
  // supplied Client.
  execute?: ExecuteFn;
}

// Executes an operation by name and returns the raw response — no
// trim projection applied. Used by the bridge layer, which sandboxes
// the full response separately from applying the trim to the summary.
export async function invokeOperationRaw(
  manifest: Manifest,
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options: InvokeOptions = {},
): Promise<{ op: Operation; response: unknown }> {
  const op = findOperation(manifest, name);
  assertOperationEnabled(name, options.disabledActions);

  const split = splitArgs(op, args);
  if (split.missingRequired.length > 0) {
    throw new OperationError(
      `Missing required param(s) for ${name}: ${split.missingRequired.join(", ")}`,
      name,
    );
  }

  const path = interpolatePath(op.pathTemplate, split.pathParams);
  const queryParams = normalizeQueryParams(split.queryParams);

  // Reshape the body for non-default shapes. "rawString" forwards the
  // single body param's raw value; the Client's underlying JSON
  // serialization then emits a JSON-encoded scalar (`"acc123"` rather
  // than `{"accountId":"acc123"}`).
  let body: unknown = split.body;
  if (op.bodyShape === "rawString") {
    const bodyParamSpecs = op.params.filter((p) => p.role === "body");
    if (bodyParamSpecs.length !== 1) {
      throw new OperationError(
        `Operation ${op.name} declared bodyShape="rawString" but has ${bodyParamSpecs.length} body params (must be exactly 1)`,
        op.name,
      );
    }
    const onlyName = bodyParamSpecs[0].name;
    body =
      split.body && Object.prototype.hasOwnProperty.call(split.body, onlyName)
        ? split.body[onlyName]
        : undefined;
  }

  const execute = options.execute ?? defaultExecute;
  const response = await execute({ op, client, path, queryParams, body });
  return { op, response };
}

// Executes an operation and applies the trim projection (if any).
// This is what Layer 2 (classic tools) typically uses. Layer 3 (the
// bridge) uses invokeOperationRaw directly so it can sandbox the full
// response while still applying the trim to the in-band summary.
//
// Type parameter `R` is the server's trim registry — its keys are the
// valid `trim:` strings on operations, and its values are the
// projection functions to apply.
export async function invokeOperation<R extends TrimRegistry>(
  manifest: Manifest,
  client: Client,
  name: string,
  args: Record<string, unknown>,
  registry: R,
  options: InvokeOptions = {},
): Promise<unknown> {
  const { op, response } = await invokeOperationRaw(
    manifest,
    client,
    name,
    args,
    options,
  );
  if (op.trim && op.trim in registry) {
    const projection = (registry as Record<string, (input: unknown) => unknown>)[op.trim];
    return projection(response);
  }
  return response;
}

