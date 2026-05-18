---
name: ultra-mcp-toolkit
description: Use when building, extending, or debugging an MCP (Model Context Protocol) server with ultra-mcp-toolkit. Triggers include adding a new operation, writing a trim function, wiring a consolidated tool, booting stdio or code-api mode, or asking how the toolkit's manifest / trim / dispatcher patterns work. Skip for generic MCP questions unrelated to this toolkit.
---

# Building MCP servers with `ultra-mcp-toolkit`

This skill is the entry point for working with `ultra-mcp-toolkit` — the shared infrastructure that powers `jira-mcp`, `confluence-mcp`, and `bitbucket-mcp`. It optimizes for **token efficiency**: the server does deterministic filtering/chunking; the model never receives raw API blobs.

Load a topic reference (below) before writing code in that area — each one has the exact shapes, gotchas, and patterns the toolkit expects.

## Mental model — 5 things to internalize

1. **One manifest is the source of truth.** Every operation the server exposes is declared once as data (`{ name, verb, pathTemplate, params, trim }`). Tools, CLI, and dispatcher all read it.
2. **Trim functions are allowlists.** They declare what to *keep*, never what to drop. They produce the compact projection the model sees.
3. **Full responses live on disk, not in context.** A content-addressed sandbox stores the raw JSON; the model gets `{ summary, ref }`. The `ref` is how the agent fetches the rest if it needs to.
4. **Two runtime modes per server.** Classic (consolidated MCP tools, e.g. `jira_issue`) and code-api (single MCP tool + bundled CLI binary — ~76× tool-list reduction).
5. **Consolidated tools dispatch by `action`.** A single MCP tool exposes N actions; the dispatcher peels off `action`, validates per-action Zod schema, routes to the manifest op or a custom handler.

## Topic references — load on demand

| You're working on... | Load |
|---|---|
| Declaring operations, `pathTemplate`, `ParamSpec`, `ExecuteFn`, multi-API routing | [references/manifest.md](references/manifest.md) |
| Writing trim projections, registering them, sandbox+ref envelope, list summarizers | [references/trim.md](references/trim.md) |
| Building a consolidated MCP tool with `action`-discriminated input, Zod schemas, `full: true` escape hatch, `DispatchError`/`ToolError` | [references/dispatcher.md](references/dispatcher.md) |
| Wiring server startup — `Client` impl, `createSandbox`, `startStdioServer`, `bootCodeApi`, `createCli`, install-skill subcommand | [references/server-boot.md](references/server-boot.md) |

## Common starter tasks

- **"Add a new API operation"** — load `manifest.md` and `trim.md`. Declare the operation, register a trim, expose it via a consolidated tool (`dispatcher.md`) or directly as a CLI op.
- **"Add a new consolidated tool"** — load `dispatcher.md`. Define `ConsolidatedToolDef`, per-action Zod schemas, register in the server's tool list.
- **"Start a new server from scratch"** — load `server-boot.md` first, then `manifest.md`. Boot pattern, Client impl, two runtime modes.
- **"My trimmed response drops a field the model needs"** — `trim.md` (extend the projection) or `dispatcher.md` (use `full: true` for raw response on a per-call basis).
- **"Bump the toolkit version in my server"** — check `npm view ultra-mcp-toolkit version`; consult release notes for breaking changes in `DispatchError`/manifest shape.

## Design principles (do not violate)

- **No model-side chunking.** If a response needs paging or filtering, the server does it.
- **Field allowlists in trim, never denylists.** New API fields default to dropped, not included.
- **The manifest is pure data.** No closures, no functions — it must round-trip through JSON for the CLI bridge.
- **`Client` is generic.** Auth-specific construction stays in the server; the toolkit consumes `get/post/put/delete`.
- **Stderr for banners, stdout is reserved for the MCP transport** when running stdio mode.

## Quick package-export map

```
ultra-mcp-toolkit/manifest   — Operation, ParamSpec, invokeOperation
ultra-mcp-toolkit/trim       — pick, paginatedListSummary, helpers
ultra-mcp-toolkit/trim-registry — createTrimRegistry
ultra-mcp-toolkit/sandbox    — createSandbox (content-addressed)
ultra-mcp-toolkit/page-cache — versioned-id disk cache
ultra-mcp-toolkit/tool       — dispatch, buildInputSchema, DispatchError
ultra-mcp-toolkit/stdio      — startStdioServer
ultra-mcp-toolkit/code-api   — bootCodeApi, createCodeApiTool
ultra-mcp-toolkit/bridge     — startBridge, callBridge
ultra-mcp-toolkit/cli        — createCli (CLI scaffolding)
ultra-mcp-toolkit/client     — Client interface
ultra-mcp-toolkit/http-client — createHttpClient
ultra-mcp-toolkit/schemas    — shared Zod helpers (positiveInt, etc.)
```

Prefer the subpath imports over the umbrella `ultra-mcp-toolkit` import — better tree-shaking and clearer dependency intent.
