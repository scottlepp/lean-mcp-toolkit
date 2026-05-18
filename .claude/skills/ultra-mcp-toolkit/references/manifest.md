# Manifest — declaring operations

The manifest is the single source of truth for every API operation a server exposes. It's pure data, JSON-serializable, and read at runtime by the tool dispatcher, the CLI, and the code-api bridge.

## Operation shape

```ts
import type { Manifest, Operation } from "ultra-mcp-toolkit/manifest";

const issueGet: Operation = {
  name: "issue.get",                  // stable id, used by CLI + dispatcher
  description: "Fetch a single issue",
  verb: "GET",                        // GET | POST | PUT | DELETE
  pathTemplate: "/rest/api/3/issue/{issueIdOrKey}",
  params: [
    { name: "issueIdOrKey", role: "path", required: true },
    { name: "fields", role: "query", required: false,
      description: "Comma-separated list of field names" },
  ],
  trim: "issue",                      // key into the trim registry
  // Optional:
  // bodyShape: "object" | "rawString" — defaults to "object"
  // meta: { ...arbitrary } — per-server routing hint, read by ExecuteFn
};

export const manifest: Manifest = [issueGet, /* ... */];
```

### `ParamSpec.role`

- `path` — interpolated into `pathTemplate` (`{name}` placeholders).
- `query` — appended as `?name=...`.
- `body` — bundled into the request body (`{ paramA, paramB }` by default).

`required: true` fails fast at the dispatcher; missing optional params are dropped from the request.

### `bodyShape: "rawString"`

For the rare endpoint that takes a bare JSON scalar (e.g. `"acc-123"` with quotes) instead of an object. Declare exactly one body param; its value is sent as the raw stringified JSON body.

### `meta`

Opaque to the SDK. Servers attach routing hints here — e.g. jira-mcp uses `meta: { isAgile: true }` to pick the agile API base URL inside its `ExecuteFn`.

## Dispatching against the manifest

```ts
import { invokeOperation } from "ultra-mcp-toolkit/manifest";

const result = await invokeOperation(
  manifest,
  client,
  "issue.get",
  { issueIdOrKey: "PROJ-123", fields: "summary,status" },
  trimRegistry,
  { /* InvokeOptions: execute?, sandbox?, ... */ },
);
// → { summary, ref }
```

What it does, in order:
1. Find the op by `name`.
2. Validate required params present.
3. Interpolate `pathTemplate` with path params; collect query and body params per their role.
4. Call `client[verb](path, ...)` (or your `ExecuteFn` if you passed one).
5. Run the trim projection registered under `op.trim`.
6. Hand the raw response to `sandbox()`, return `{ summary, ref }`.

Use `invokeOperationRaw` to bypass the trim step and return the raw response — the dispatcher's `full: true` escape hatch routes through this.

## Multi-API routing — `ExecuteFn`

Default behavior: `client[verb](path, body, queryParams)`. To route based on `meta` (e.g. agile vs cloud APIs):

```ts
await invokeOperation(manifest, client, "sprint.list", args, trimRegistry, {
  execute: async ({ op, path, body, query }) => {
    const c = op.meta?.isAgile ? agileClient : cloudClient;
    return c[op.verb.toLowerCase()](path, body, query);
  },
});
```

## Conventions

- Name pattern: `<resource>.<action>` (`issue.get`, `pullrequest.list`, `page.create`). The CLI parses this same syntax verbatim.
- One op = one API call. Don't fold "get + transform" into a single op; do that in the trim.
- `trim: "issue"` keys must match a key registered in `createTrimRegistry({ issue: ... })`. Mismatches throw at dispatch time, not boot.
- Keep `description` to one line — it surfaces in `--help` lists and consolidated-tool action enums.

## Validating the manifest

`src/core/manifest.ts` exposes a typed `Manifest = readonly Operation[]`. There's no runtime validator helper; rely on TS for shape, and on tests for behavior (use the manifest tests as a template — see `src/core/manifest.test.ts`).

## Common pitfalls

- **`pathTemplate` placeholder name must match `ParamSpec.name`.** A typo here surfaces as "missing path param" at runtime.
- **Required body params and required path params are both `required: true`** — the role determines wiring, not the requiredness.
- **Don't put closures in `meta`.** The manifest must JSON-serialize; the CLI bridge transfers it across processes.
- **`trim: "..."` is a *string key*, not a function.** Register the function in the trim registry — see [trim.md](trim.md).
