# ultra-mcp-toolkit

**Build token-efficient [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers that fit in your AI agent's context window.**

A TypeScript toolkit for building MCP servers that don't blow up your context budget. Server-side response trimming, content-addressed disk caching, two runtime modes, and a CLI bridge — extracted from production servers benchmarked at **17× smaller responses** and **99× smaller tool listings** versus naive MCP implementations.

Used in production by [`ultra-jira-mcp`](https://github.com/scottlepp/ultra-jira-mcp), [`ultra-bitbucket-mcp`](https://github.com/scottlepp/ultra-bitbucket-mcp), and [`confluence-mcp`](https://github.com/scottlepp/confluence-mcp).

## The problem

Naive MCP servers hand the model raw API JSON. A single Jira ticket fetch with comments can dump **270 KB (~67,000 tokens)** into your context window. Five calls and you've burned through Claude's working memory before the agent has done any actual reasoning. Tool listings alone — paid on **every** conversation — routinely run 10–40 KB.

If you've shipped an MCP server and watched it cost-spiral or drop accuracy as conversations grow, this is why.

## The fix

Real numbers from a [production benchmark](https://github.com/scottlepp/ultra-jira-mcp/blob/main/docs/BENCHMARK.md) against a live Jira instance:

### Tool-list cost (paid every conversation)

| approach                     |   bytes |  ~tokens | factor       |
| ---------------------------- | ------: | -------: | ------------ |
| naive (one tool per op)      |  38.9KB |    9,947 | 1×           |
| consolidated tools           |  25.1KB |    6,427 | **1.5×**     |
| consolidated + filtered      |  ~6 KB  |  ~1,600  | **5×**       |
| code-api mode (1 tool)       |    401B |      100 | **99×**      |

### Per-call response

| scenario                       |  naive   | with toolkit | factor       |
| ------------------------------ | -------: | -----------: | -----------: |
| fetch 1 simple ticket          |  20.3KB  |        1.2KB | **17.5×**    |
| investigate rich ticket        | 270.7KB  |       15.5KB | **17.5×**    |
| JQL search ~10 tickets         |  20.5KB  |        3.5KB | **5.8×**     |

That rich-ticket row is the headline: **270 KB → 15.5 KB**, ~67k tokens → ~3.9k tokens, on a single investigation. The full response still lands on disk; the agent reads it via a `ref` only when it needs the detail.

## How it works

Five design choices, all turned on by default:

1. **Trim before the model sees it.** Responses route through allowlist projection functions; the full payload lands in a content-addressed sandbox and surfaces as a `ref:` path the agent can dereference on demand. No model-side `Read`-in-chunks loops, no asking the LLM to filter.
2. **One manifest, many surfaces.** Operations are declared as pure data — name, verb, path template, params, trim key. The same manifest powers consolidated MCP tools, a bundled CLI binary, and **code-api mode** (one MCP tool + CLI bridge = 99× smaller tool listings).
3. **Two cache primitives.** Content-addressed sandbox for anonymous large payloads. Versioned-id page cache for stable-keyed resources (PR diffs by head SHA, Confluence pages by version number). Both deterministic, both with TTL cleanup.
4. **Allowlists, never denylists.** Trim functions declare what to *keep*; new API fields default to dropped. The contract between server and model stays stable when upstream APIs add noise.
5. **Batteries included.** Pooled retry-aware HTTP transport (`undici` + 429-aware retry), atomic stream-to-disk downloads, TTL+LRU in-memory cache, Zod-validated tool dispatch with a `full: true` escape hatch — all opt-in, all consistent.

## Quick start

```bash
npm install ultra-mcp-toolkit
```

```ts
import { createSandbox } from "ultra-mcp-toolkit/sandbox";
import { createTrimRegistry } from "ultra-mcp-toolkit/trim-registry";
import { invokeOperation, type Manifest } from "ultra-mcp-toolkit/manifest";
import { bootCodeApi, createCodeApiTool } from "ultra-mcp-toolkit/code-api";
import { createCli } from "ultra-mcp-toolkit/cli";

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

// MCP server entrypoint (code-api mode):
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

// Bundled CLI binary:
const cli = createCli({
  cliName: "my-server-cli",
  socketEnvVar: "MY_SERVER_MCP_SOCKET",
  manifest, skillContent, skillSlug: "my-server",
  callDirect: async (op, args) => { /* direct-mode dispatch */ },
});
process.exit(await cli.run(process.argv.slice(2)));
```

Full walkthrough lives in the [bundled Claude Code skill](#bundled-claude-code-skill). Agents auto-load it; humans can read the markdown directly.

## Bundled Claude Code skill

The package ships a Claude Code skill at `.claude/skills/ultra-mcp-toolkit/` — hub `SKILL.md` plus topic references covering manifest, trim, dispatcher, and server boot.

```bash
npm run install-skill                  # → ~/.claude/skills/ultra-mcp-toolkit/  (user-global)
npm run install-skill -- --project     # → ./.claude/skills/ultra-mcp-toolkit/  (cwd)
npm run install-skill -- --help        # flags: --force, --dry-run, --print
```

Non-Claude agents (Codex CLI, Cursor, Aider, Continue, Zed, Warp) read the skill files directly — see [AGENTS.md](AGENTS.md). The skill auto-loads in Claude Code when you mention building or extending an MCP server with this toolkit.

## Who's it for

- **You're shipping a public MCP server** and want it to scale to long conversations without burning the user's context budget.
- **You're integrating against a verbose REST API** (Jira, Confluence, Bitbucket, Linear, Notion, GitHub, GitLab, Asana, ServiceNow, Salesforce, …) and the raw payloads are way too big.
- **You're tired of hand-rolling pagination cursors, sandbox dirs, retry loops, and tool-dispatch boilerplate** for every new server.
- **You're optimizing AI agent latency or cost** — fewer tokens in means lower per-call cost and faster time-to-first-token.

If you only need to expose two endpoints to one agent on your laptop, this is overkill. If you're shipping to users, it isn't.

## Reference: subpath exports

Import what you need; prefer subpaths over the umbrella `ultra-mcp-toolkit` import for tree-shaking.

| Subpath                            | Purpose                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ultra-mcp-toolkit/manifest`       | Operation manifest (`Operation`, `ParamSpec`) + dispatcher (`invokeOperation`, `invokeOperationRaw`). Generic over a `Client` adapter with an `ExecuteFn` hook for multi-API routing.                  |
| `ultra-mcp-toolkit/sandbox`        | Content-addressed disk cache (SHA256 → JSON). Stores full responses out of model context; returns summary + ref. Session-isolated, TTL cleanup.                                                        |
| `ultra-mcp-toolkit/page-cache`     | Versioned-id disk cache (kind + id + version → JSON). For stable-keyed resources where the version invalidates the cache. Atomic writes via tmpfile+rename.                                            |
| `ultra-mcp-toolkit/trim`           | Response-shaping helpers: `pick`, `paginatedListSummary`, `bareListSummary`, `extractNextCursor`, `safeHref`.                                                                                          |
| `ultra-mcp-toolkit/trim-registry`  | Type-safe string-keyed registry of trim functions (`createTrimRegistry`).                                                                                                                              |
| `ultra-mcp-toolkit/tool`           | Consolidated-tool dispatcher (`dispatch`, `buildInputSchema`). Includes the `full: true` escape hatch. `ToolError` alias of `DispatchError`.                                                           |
| `ultra-mcp-toolkit/code-api`       | `bootCodeApi` (server startup glue) + `createCodeApiTool` (single MCP tool exposed in code-api mode).                                                                                                  |
| `ultra-mcp-toolkit/bridge`         | IPC socket bridge for code-api. `startBridge` (server), `callBridge` (client). Unix socket on POSIX, loopback TCP on Windows.                                                                          |
| `ultra-mcp-toolkit/cli`            | CLI scaffolding (`createCli`): argv parser, help renderer, install-skill subcommand, bridge dispatch, direct-mode hook.                                                                                |
| `ultra-mcp-toolkit/client`         | Generic `Client` interface (get/post/put/delete). Servers provide their own concrete implementations.                                                                                                  |
| `ultra-mcp-toolkit/http-client`    | `createHttpClient` — opinionated `Client` over `undici.request`. Handles redirects, basic/bearer/custom auth, 204 → `{}`. Opt-in `retry` switches to the pooled transport.                             |
| `ultra-mcp-toolkit/transport`      | Pooled retry-aware HTTP transport. Module-level `undici.Agent` singleton (8 connections, keep-alive). 429-aware retry honoring `Retry-After`.                                                          |
| `ultra-mcp-toolkit/streaming`      | `downloadToFile` (atomic stream-to-disk with sha256), `sanitizeFilename` (path-traversal safe), `guardSingleConsumption` (one-shot body wrapper).                                                      |
| `ultra-mcp-toolkit/lru`            | `TtlLruCache<K, V>` — in-memory TTL + LRU for short-lived metadata (field defs, status enums).                                                                                                         |
| `ultra-mcp-toolkit/disk-cache`     | Generic `readDiskCache` / `writeDiskCache` keyed under `<rootDir>/<scope>/<sha256(key)>.json`. Corrupt files return `undefined` rather than throw.                                                     |
| `ultra-mcp-toolkit/config`         | `parseToolFilterEnv` (`enabled_categories` + `disabled_actions` from env), `parseToolMode`. Server-specific env var names stay in the server.                                                          |
| `ultra-mcp-toolkit/mutation-ack`   | `createMutationAck` — minimal mutation acknowledgement envelope (`{ ok, kind, id, url }`).                                                                                                             |
| `ultra-mcp-toolkit/stdio`          | `startStdioServer` — MCP stdio boot helper. Hides the "don't `process.exit` after connect" + SIGINT/SIGTERM footguns.                                                                                  |
| `ultra-mcp-toolkit/schemas`        | Shared Zod schemas (`positiveInt`, etc.).                                                                                                                                                              |
| `ultra-mcp-toolkit/agent-safety`   | Defense-in-depth validators for autonomous-agent harnesses: `resolveSafePath`, `verifyResolvedRealpath`, `isProtectedPath`, `SafetyChecker`. Caller-extensible denylist + harmful/secret/shell scans.   |
| `ultra-mcp-toolkit/agent-tools`    | Pre-built Vercel-AI `tool({...})` factories wired through `agent-safety`: `createFileTools`, `createGitTools`, `createGitHubTools`, `createTestTools`. Optional peers: `ai`, `@octokit/rest`, `zod`.    |

<details>
<summary><strong>Module deep-dives (v0.3+)</strong></summary>

### `lru` — TTL + LRU in-memory cache

```ts
import { TtlLruCache } from "ultra-mcp-toolkit/lru";

const fieldDefs = new TtlLruCache<string, FieldDef>({
  maxSize: 500,
  ttlMs: 10 * 60 * 1000,
});
fieldDefs.set("summary", def);
fieldDefs.get("summary"); // touch-on-read promotes recency
```

### `transport` — pooled retry-aware HTTP

```ts
import { httpRequest, DEFAULT_RETRY, closeHttpPool } from "ultra-mcp-toolkit/transport";

const res = await httpRequest(
  "https://api.example.com/v1/things",
  { method: "GET", headers: { Authorization: "Bearer …" } },
  DEFAULT_RETRY, // 3 retries, 500ms base, 10s cap; honors Retry-After
);

await closeHttpPool(); // on graceful shutdown
```

Or wire it into the high-level `Client`:

```ts
import { createHttpClient } from "ultra-mcp-toolkit/http-client";
import { DEFAULT_RETRY } from "ultra-mcp-toolkit/transport";

const client = createHttpClient({
  baseUrl: "https://api.example.com",
  auth: { kind: "bearer", token: process.env.TOKEN! },
  retry: DEFAULT_RETRY, // omit for single-shot behavior
});
```

### `streaming` — stream binary downloads to disk

```ts
import { downloadToFile } from "ultra-mcp-toolkit/streaming";

const ref = await downloadToFile({
  url: attachment.contentUrl,
  headers: { Authorization: basicAuth },
  targetDir: sandbox.sessionCacheDir(),
  filename: attachment.filename, // sanitized before writing
});
// → { absolutePath, size, sha256 }
```

### `disk-cache` — generic JSON K/V cache

```ts
import { readDiskCache, writeDiskCache } from "ultra-mcp-toolkit/disk-cache";

const opts = { rootDir: sandbox.rootCacheDir(), scope: "tenant",
               ttlMs: 24 * 60 * 60 * 1000 };
const cached = await readDiskCache<{ cloudId: string }>(opts, host);
if (!cached) {
  const fetched = await fetchTenantInfo(host);
  await writeDiskCache(opts, host, fetched);
}
```

### `tool/dispatcher` — `full: true` escape hatch

The dispatcher peels off `full: true` before per-action Zod validation and (for read-shaped GET ops) routes through `invokeOperationRaw` so the agent receives the untrimmed response — useful when the default summary drops content the caller wants. Mutation verbs reject `full: true` explicitly.

```ts
import { dispatch, FULL_META_KEY } from "ultra-mcp-toolkit/tool";

await dispatch(
  myTool,
  { action: "list", [FULL_META_KEY]: true, project: "ABC" },
  { manifest, client, trimRegistry },
);
```

</details>

## Status

`v0.5` — Bundles the toolkit's own Claude Code skill (`.claude/skills/ultra-mcp-toolkit/`) plus a `npm run install-skill` script. Pure addition: skill is opt-in, no API changes.

`v0.4` — Adds the optional `tool?: string` field to `DispatchError` / `ToolError` so catch sites can recover the consolidated tool name. Constructor arg is optional → v0.3 callers compile unchanged.

`v0.3` — Adds `lru`, `disk-cache`, `transport` (retry + pool), `streaming` (atomic download), and the `full: true` escape hatch / `ToolError` alias on the dispatcher. All v0.2 APIs preserved without breaking change.

## Contributing

See [AGENTS.md](AGENTS.md) for build/test commands, conventions, and the cross-agent contributor guide.

## License

MIT

---

<sub>**Keywords:** Model Context Protocol, MCP, MCP server, MCP toolkit, Anthropic Claude, AI agent tooling, token-efficient AI, context window optimization, Claude Code, MCP TypeScript, agent infrastructure, LLM tool calling.</sub>
