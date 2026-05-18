# Consolidated tools — the dispatcher

A consolidated tool exposes N actions through a single MCP tool with an `action` discriminator on its input. Reduces the tool-listing surface the model sees by 10×–30× vs one MCP tool per operation.

Example: instead of `issue_get`, `issue_list`, `issue_create`, `issue_comment` (4 tools), expose `jira_issue` with `action: "get" | "list" | "create" | "comment"`.

## Defining a consolidated tool

```ts
import { z } from "zod";
import type { ConsolidatedToolDef } from "ultra-mcp-toolkit/tool";

export const jiraIssueTool: ConsolidatedToolDef = {
  name: "jira_issue",
  description: "Read, list, and mutate Jira issues",
  actions: {
    get: {
      operation: "issue.get",                     // manifest op name
      schema: z.object({
        issueIdOrKey: z.string(),
        fields: z.string().optional(),
      }),
      description: "Fetch a single issue",
    },
    list: {
      operation: "issue.list",
      schema: z.object({
        jql: z.string(),
        maxResults: z.number().int().positive().optional(),
      }),
      description: "JQL search",
    },
    summarize: {
      // No `operation` → uses a custom handler instead of the manifest.
      schema: z.object({ jql: z.string() }),
      description: "LLM-side summary across many issues",
      handler: async (args, ctx) => {
        // Free to call invokeOperation directly, read the sandbox,
        // hit a different client, return any shape.
        return { summarized: true, count: 0 };
      },
    },
  },
};
```

## Wiring into an MCP server

```ts
import { buildInputSchema, dispatch } from "ultra-mcp-toolkit/tool";

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: jiraIssueTool.name,
    description: jiraIssueTool.description,
    inputSchema: buildInputSchema(jiraIssueTool),
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== jiraIssueTool.name) throw new Error("unknown tool");
  const { result } = await dispatch(jiraIssueTool, req.params.arguments, {
    manifest, client, trimRegistry, invokeOptions: { execute },
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
```

`buildInputSchema` produces a flat JSON Schema (not `oneOf`) — every action's fields hoisted to top level with `(used by: get, list)` annotations. MCP clients render flat schemas reliably; unions don't.

## The `dispatch` flow

1. Validate that `rawArgs` is an object with a string `action`.
2. Look up the action; reject unknowns with the valid-action list in the error.
3. Peel off the `full` meta-arg (boolean), strip the `action` discriminator.
4. Validate the remaining args with `action.schema.safeParse`. On failure, throws `DispatchError` with a `prettifyError`-formatted detail.
5. Apply `ctx.preprocess(operation, args)` if provided (inject workspace defaults, normalize keys, etc.).
6. If `action.handler` present → call it, return.
7. If `action.operation` present → `invokeOperation(...)` (or `invokeOperationRaw` when `full: true` on a GET op).

## The `full: true` escape hatch

```json
{ "action": "get", "issueIdOrKey": "PROJ-1", "full": true }
```

Skips the trim projection on a per-call basis; returns the raw API response. Only valid on **read-shaped (GET) actions** routed through the manifest. Rejected for:
- Custom handlers (bypass the manifest already).
- Non-GET ops (mutation-ack already carries everything).
- Non-boolean values.

Use it as an escape hatch when a trim drops a field a one-off agent task needs.

## Errors — `DispatchError` and `ToolError`

```ts
import { DispatchError, ToolError } from "ultra-mcp-toolkit/tool";
```

- `DispatchError(message, action, tool?)` — thrown for missing/invalid action, Zod failures, type errors on `full`, missing operation+handler, etc.
- `ToolError extends DispatchError` — same shape; just a name alias for catch sites that prefer `ToolError`. `instanceof DispatchError` is true.

Fields (since v0.4.0):
- `.action: string` — the action name, or `""` if rejected before action resolution.
- `.tool?: string` — the consolidated tool name (`"jira_issue"`). Populated for every throw inside `dispatch()`.
- `.message: string` — always prefixed with `${tool.name}.${actionName}: ...`.

Catch sites:
```ts
try {
  await dispatch(tool, args, ctx);
} catch (err) {
  if (err instanceof DispatchError) {
    log.warn({ tool: err.tool, action: err.action }, err.message);
    return errorEnvelope(err);
  }
  throw err; // OperationError, network errors, etc.
}
```

`OperationError` (thrown by `invokeOperation` itself — manifest layer) does **not** carry `tool`. The manifest layer has no notion of which consolidated tool initiated the call. If you need `tool` on those, wrap and rethrow in the catch site.

## The `DispatcherContext`

```ts
interface DispatcherContext {
  manifest: Manifest;
  client: Client;
  trimRegistry: TrimRegistry;
  invokeOptions?: InvokeOptions;       // execute, sandbox overrides
  preprocess?: (op: string, args: Record<string, unknown>)
    => Record<string, unknown>;        // inject defaults post-validation
}
```

`preprocess` runs *after* Zod validation, *before* dispatch. Common uses:
- Inject default `workspace` from env.
- Coerce `issueIdOrKey` casing.
- Resolve a short alias to a full ID.

## Conventions

- Action names are short verbs (`get`, `list`, `create`, `comment`) — never `getIssue`. The tool name already carries the noun.
- Per-action schemas use `z.object({...})` flat, not nested. The merged JSON Schema flattens regardless.
- Custom handlers should still register a `schema` — the merged input schema needs it for the LLM-facing menu.
- One consolidated tool per resource. `jira_issue`, `jira_project`, `jira_user` — not one mega-tool.
