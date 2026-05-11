# @scottlepp/mcp-toolkit

Shared toolkit for building token-efficient [Model Context Protocol](https://modelcontextprotocol.io) servers.

Extracted from [`jira-mcp`](https://github.com/scottlepp/jira-mcp) and [`confluence-mcp`](https://github.com/scottlepp/confluence-mcp) (production token-optimized MCP servers achieving up to 114× per-call response reduction). Used by `jira-mcp`, `confluence-mcp`, and `bitbucket-mcp`.

## What's in the box

| Subpath | Purpose |
|---|---|
| `@scottlepp/mcp-toolkit/manifest` | Central operation manifest type (`Operation`, `ParamSpec`) + dispatcher (`invokeOperation`, `invokeOperationRaw`). Generic over a `Client` adapter with an `ExecuteFn` hook for multi-API routing. |
| `@scottlepp/mcp-toolkit/sandbox` | Content-addressed disk cache (SHA256 hash → JSON file). Stores full responses out of model context; returns summary + ref. Session-isolated, TTL cleanup. |
| `@scottlepp/mcp-toolkit/page-cache` | Versioned-id disk cache (kind + id + version → JSON file). For known-key resources where the version invalidates the cache (PR diffs by head SHA, Confluence pages by version). Atomic writes via tmpfile+rename. |
| `@scottlepp/mcp-toolkit/trim` | Helpers for response shaping: `pick`, `paginatedListSummary`, `bareListSummary`, `extractNextCursor`, `safeHref`. |
| `@scottlepp/mcp-toolkit/trim-registry` | Type-safe string-keyed registry of trim projection functions (`createTrimRegistry`). |
| `@scottlepp/mcp-toolkit/bridge` | IPC socket bridge for the code-api pattern. `startBridge` (server), `callBridge` (client). Unix domain socket on POSIX, loopback TCP on Windows. |
| `@scottlepp/mcp-toolkit/code-api` | `bootCodeApi` (server startup glue) + `createCodeApiTool` (the single MCP tool exposed in code-api mode). |
| `@scottlepp/mcp-toolkit/cli` | CLI scaffolding (`createCli`): argv parser, help renderer, install-skill subcommand, bridge dispatch, direct-mode hook. |
| `@scottlepp/mcp-toolkit/client` | Generic `Client` interface (get/post/put/delete). Servers provide their own concrete implementations. |
| `@scottlepp/mcp-toolkit/config` | `parseToolFilterEnv` (`enabled_categories` + `disabled_actions` from env), `parseToolMode`. Server-specific env var names stay in the server; the SDK provides the parsing logic. |

## Design principles

1. **The server does all deterministic filtering/chunking/shaping.** Never hand the model a file path and expect it to `Read` in chunks.
2. **Field allowlists, never denylists.** Trim functions declare what to keep.
3. **Operations are pure data.** The manifest is JSON-serializable; both MCP tools and the CLI bridge read it.
4. **Two cache primitives.** `sandbox` is content-addressed (anonymous large payloads); `page-cache` is versioned-id (known keys with version invalidation).
5. **Two runtime modes per server.** Classic mode (consolidated MCP tools) + code-api mode (single tool + bundled CLI binary, ~76× tool-list reduction).

## Minimum viable consumer

```ts
import { createSandbox } from "@scottlepp/mcp-toolkit/sandbox";
import { createTrimRegistry } from "@scottlepp/mcp-toolkit/trim-registry";
import { invokeOperation, type Manifest } from "@scottlepp/mcp-toolkit/manifest";
import { startBridge } from "@scottlepp/mcp-toolkit/bridge";
import { createCli } from "@scottlepp/mcp-toolkit/cli";
import { bootCodeApi, createCodeApiTool } from "@scottlepp/mcp-toolkit/code-api";

const sandbox = createSandbox({ rootName: "my-server-mcp" });
const trimRegistry = createTrimRegistry({
  thing: (raw: unknown) => /* project to compact summary */ raw,
});
const manifest: Manifest = [
  { name: "thing.get", description: "fetch one", verb: "GET",
    pathTemplate: "/things/{id}",
    params: [{ name: "id", role: "path", required: true }],
    trim: "thing" },
];

// In your MCP server entrypoint:
const { bridge, ctx } = await bootCodeApi({
  manifest, client, sandbox, trimRegistry,
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
  manifest, skillContent, skillSlug: "my-server",
  callDirect: async (op, args) => { /* server-specific direct-mode dispatch */ },
});
process.exit(await cli.run(process.argv.slice(2)));
```

## Status

`v0.1` — Phase 0 complete. SDK exports core/sandbox, core/page-cache, core/manifest, core/trim helpers, bridge, code-api, cli, config. TOON serialization deferred to v0.2.

Currently retrofitting `jira-mcp` and `confluence-mcp` onto the SDK as proof; expect API tweaks during that pass.

## License

MIT
