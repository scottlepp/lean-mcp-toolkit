# ultra-mcp-toolkit

Shared toolkit for building token-efficient [Model Context Protocol](https://modelcontextprotocol.io) servers.

## What's in the box

| Subpath                                  | Purpose                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ultra-mcp-toolkit/manifest`      | Central operation manifest type (`Operation`, `ParamSpec`) + dispatcher (`invokeOperation`, `invokeOperationRaw`). Generic over a `Client` adapter with an `ExecuteFn` hook for multi-API routing.                                                           |
| `ultra-mcp-toolkit/sandbox`       | Content-addressed disk cache (SHA256 hash → JSON file). Stores full responses out of model context; returns summary + ref. Session-isolated, TTL cleanup.                                                                                                    |
| `ultra-mcp-toolkit/page-cache`    | Versioned-id disk cache (kind + id + version → JSON file). For known-key resources where the version invalidates the cache (PR diffs by head SHA, Confluence pages by version). Atomic writes via tmpfile+rename.                                            |
| `ultra-mcp-toolkit/trim`          | Helpers for response shaping: `pick`, `paginatedListSummary`, `bareListSummary`, `extractNextCursor`, `safeHref`.                                                                                                                                            |
| `ultra-mcp-toolkit/trim-registry` | Type-safe string-keyed registry of trim projection functions (`createTrimRegistry`).                                                                                                                                                                         |
| `ultra-mcp-toolkit/bridge`        | IPC socket bridge for the code-api pattern. `startBridge` (server), `callBridge` (client). Unix domain socket on POSIX, loopback TCP on Windows.                                                                                                             |
| `ultra-mcp-toolkit/code-api`      | `bootCodeApi` (server startup glue) + `createCodeApiTool` (the single MCP tool exposed in code-api mode).                                                                                                                                                    |
| `ultra-mcp-toolkit/cli`           | CLI scaffolding (`createCli`): argv parser, help renderer, install-skill subcommand, bridge dispatch, direct-mode hook.                                                                                                                                      |
| `ultra-mcp-toolkit/client`        | Generic `Client` interface (get/post/put/delete). Servers provide their own concrete implementations.                                                                                                                                                        |
| `ultra-mcp-toolkit/http-client`   | `createHttpClient` — opinionated `Client` over `undici.request`. Handles redirects, basic/bearer/custom auth, 204 → `{}`. Opt-in `retry` switches to the pooled transport.                                                                                   |
| `ultra-mcp-toolkit/transport`     | Pooled retry-aware HTTP transport. `httpRequest`, `RetryOptions`, `DEFAULT_RETRY`, `computeBackoffMs`, `closeHttpPool`, `__setTransportForTests`. Module-level `undici.Agent` singleton (8 connections, keep-alive). 429-aware retry honoring `Retry-After`. |
| `ultra-mcp-toolkit/streaming`     | `downloadToFile` (atomic stream-to-disk with sha256), `sanitizeFilename` (path-traversal safe), `guardSingleConsumption` (one-shot body wrapper).                                                                                                            |
| `ultra-mcp-toolkit/lru`           | `TtlLruCache<K, V>` — in-memory TTL + LRU cache for short-lived metadata (field defs, status enums).                                                                                                                                                         |
| `ultra-mcp-toolkit/disk-cache`    | Generic `readDiskCache` / `writeDiskCache` keyed under `<rootDir>/<scope>/<sha256(key)>.json`. Corrupt files return `undefined` rather than throw.                                                                                                           |
| `ultra-mcp-toolkit/tool`          | Consolidated-tool dispatcher (`dispatch`, `buildInputSchema`). Includes the `full: true` escape hatch (skip trim, return raw response) on read-shaped actions. `ToolError` alias of `DispatchError`.                                                         |
| `ultra-mcp-toolkit/config`        | `parseToolFilterEnv` (`enabled_categories` + `disabled_actions` from env), `parseToolMode`. Server-specific env var names stay in the server; the SDK provides the parsing logic.                                                                            |

## Design principles

1. **The server does all deterministic filtering/chunking/shaping.** Never hand the model a file path and expect it to `Read` in chunks.
2. **Field allowlists, never denylists.** Trim functions declare what to keep.
3. **Operations are pure data.** The manifest is JSON-serializable; both MCP tools and the CLI bridge read it.
4. **Two cache primitives.** `sandbox` is content-addressed (anonymous large payloads); `page-cache` is versioned-id (known keys with version invalidation).
5. **Two runtime modes per server.** Classic mode (consolidated MCP tools) + code-api mode (single tool + bundled CLI binary, ~76× tool-list reduction).

## Minimum viable consumer

```ts
import { createSandbox } from "ultra-mcp-toolkit/sandbox";
import { createTrimRegistry } from "ultra-mcp-toolkit/trim-registry";
import {
  invokeOperation,
  type Manifest,
} from "ultra-mcp-toolkit/manifest";
import { startBridge } from "ultra-mcp-toolkit/bridge";
import { createCli } from "ultra-mcp-toolkit/cli";
import {
  bootCodeApi,
  createCodeApiTool,
} from "ultra-mcp-toolkit/code-api";

const sandbox = createSandbox({ rootName: "my-server-mcp" });
const trimRegistry = createTrimRegistry({
  thing: (raw: unknown) => /* project to compact summary */ raw,
});
const manifest: Manifest = [
  {
    name: "thing.get",
    description: "fetch one",
    verb: "GET",
    pathTemplate: "/things/{id}",
    params: [{ name: "id", role: "path", required: true }],
    trim: "thing",
  },
];

// In your MCP server entrypoint:
const { bridge, ctx } = await bootCodeApi({
  manifest,
  client,
  sandbox,
  trimRegistry,
  cliPath: "/abs/path/to/my-server-cli/index.js",
  socketEnvVar: "MY_SERVER_MCP_SOCKET",
});

const codeApiTool = createCodeApiTool({
  toolName: "my_server_code_api",
  cliBinaryName: "my-server-cli",
  socketEnvVar: "MY_SERVER_MCP_SOCKET",
});
```

```ts
// In your bundled CLI binary (#!/usr/bin/env node):
const cli = createCli({
  cliName: "my-server-cli",
  socketEnvVar: "MY_SERVER_MCP_SOCKET",
  manifest,
  skillContent,
  skillSlug: "my-server",
  callDirect: async (op, args) => {
    /* server-specific direct-mode dispatch */
  },
});
process.exit(await cli.run(process.argv.slice(2)));
```

## v0.3 modules

### `lru` — TTL + LRU in-memory cache

```ts
import { TtlLruCache } from "ultra-mcp-toolkit/lru";

const fieldDefs = new TtlLruCache<string, FieldDef>({
  maxSize: 500,
  ttlMs: 10 * 60 * 1000, // 10 min
});
fieldDefs.set("summary", def);
fieldDefs.get("summary"); // touch-on-read promotes recency
```

### `transport` — pooled retry-aware HTTP

```ts
import {
  httpRequest,
  DEFAULT_RETRY,
  closeHttpPool,
} from "ultra-mcp-toolkit/transport";

const res = await httpRequest(
  "https://api.example.com/v1/things",
  { method: "GET", headers: { Authorization: "Bearer …" } },
  DEFAULT_RETRY, // 3 retries, 500ms base, 10s cap; honors Retry-After
);
if (res.statusCode === 200) console.log(await res.text());

// On graceful shutdown:
await closeHttpPool();
```

Or wire it into the high-level `Client` via the opt-in `retry` option:

```ts
import { createHttpClient } from "ultra-mcp-toolkit/http-client";
import { DEFAULT_RETRY } from "ultra-mcp-toolkit/transport";

const client = createHttpClient({
  baseUrl: "https://api.example.com",
  auth: { kind: "bearer", token: process.env.TOKEN! },
  userAgent: "my-mcp/0.1",
  retry: DEFAULT_RETRY, // omit for v0.2-compatible single-shot behavior
});
```

### `streaming` — stream binary downloads to disk

```ts
import { downloadToFile } from "ultra-mcp-toolkit/streaming";

const ref = await downloadToFile({
  url: attachment.contentUrl,
  headers: { Authorization: basicAuth },
  targetDir: sandbox.sessionCacheDir(), // resolved at runtime
  filename: attachment.filename, // sanitized before writing
});
// ref: { absolutePath, size, sha256 }
```

### `disk-cache` — generic JSON K/V cache

```ts
import {
  readDiskCache,
  writeDiskCache,
} from "ultra-mcp-toolkit/disk-cache";

const opts = {
  rootDir: sandbox.rootCacheDir(),
  scope: "tenant",
  ttlMs: 24 * 60 * 60 * 1000,
};
const cached = await readDiskCache<{ cloudId: string }>(opts, host);
if (!cached) {
  const fetched = await fetchTenantInfo(host);
  await writeDiskCache(opts, host, fetched);
}
```

### `tool/dispatcher` — `full: true` escape hatch

The dispatcher peels off `full: true` before per-action Zod validation and (for read-shaped GET ops) routes through `invokeOperationRaw` so the agent receives the untrimmed response — useful when the default summary drops content the caller wants. Mutation verbs reject `full: true` explicitly. The `ToolError` class is an alias of `DispatchError` for consumers that prefer the "tool error" name.

```ts
import {
  dispatch,
  FULL_META_KEY,
  ToolError,
} from "ultra-mcp-toolkit/tool";

await dispatch(
  myTool,
  { action: "list", [FULL_META_KEY]: true, project: "ABC" },
  { manifest, client, trimRegistry },
);
```

## Bundled Claude Code skill

The package ships a Claude Code skill at `.claude/skills/ultra-mcp-toolkit/` — hub `SKILL.md` plus topic references covering manifest, trim, dispatcher, and server boot. Install with:

```bash
npm run install-skill                  # → ~/.claude/skills/ultra-mcp-toolkit/  (user-global)
npm run install-skill -- --project     # → ./.claude/skills/ultra-mcp-toolkit/  (cwd)
npm run install-skill -- --help        # flags: --force, --dry-run, --print
```

Non-Claude agents (Codex CLI, Cursor, Aider, etc.) can read the skill files directly — see [AGENTS.md](AGENTS.md). The skill auto-loads in Claude Code when you mention building or extending an MCP server with this toolkit.

## Status

`v0.5` — Bundles the toolkit's own Claude Code skill (`.claude/skills/ultra-mcp-toolkit/`) plus a `npm run install-skill` script. Pure addition: skill is opt-in, no API changes.

`v0.4` — Adds the optional `tool?: string` field to `DispatchError` / `ToolError` so catch sites can recover the consolidated tool name. Constructor arg is optional → v0.3 callers compile unchanged. Populated automatically by `dispatch()` for every internal throw.

`v0.3` — Gap-close release prior to the `jira-mcp` consumption swap. Adds `lru`, `disk-cache`, `transport` (retry + pool), `streaming` (atomic download), and the `full: true` escape hatch / `ToolError` alias on the dispatcher. All v0.2 APIs are preserved without breaking change.

## License

MIT
