# Server boot — wiring it all up

Every consumer server (jira-mcp, confluence-mcp, bitbucket-mcp) follows the same shape: build a `Client`, build a `sandbox`, build a `trimRegistry`, then boot in one of two modes.

## The two modes

| Mode | What runs | When to use |
|---|---|---|
| **Classic stdio** | N consolidated MCP tools (`jira_issue`, `jira_project`, …) over stdio | Default. Best when the tool list fits comfortably. |
| **Code-api** | Single MCP tool (`<server>_code_api`) that dispatches to a bundled CLI over a Unix-socket bridge | Use when the consolidated tool list is still too noisy for the host. ~76× tool-list reduction. |

The same manifest, trims, and operations power both. Only the *surface* differs.

## Building the `Client`

`Client` is an interface:

```ts
import type { Client } from "@scottlepper/mcp-toolkit/client";

// Most servers use the bundled HTTP client:
import { createHttpClient } from "@scottlepper/mcp-toolkit/http-client";

const client: Client = createHttpClient({
  baseUrl: "https://your.atlassian.net",
  auth: { type: "basic", username, password: apiToken },
  // or: { type: "bearer", token }
  // or: { type: "custom", header: "X-API-Key", value: key }
  retry: true,  // opt into the pooled retry-aware transport
});
```

`createHttpClient` handles redirects, auth, 204→`{}`, and (opt-in) retries via the pooled `undici.Agent`. Multi-base servers (jira-mcp routes between cloud + agile) instantiate two clients and pick inside `ExecuteFn`.

## Building the sandbox + registry

```ts
import { createSandbox } from "@scottlepper/mcp-toolkit/sandbox";
import { createTrimRegistry } from "@scottlepper/mcp-toolkit/trim-registry";

const sandbox = createSandbox({ rootName: "my-server-mcp" });
const trimRegistry = createTrimRegistry({
  issue: issueSummary,
  /* one entry per `op.trim` key in your manifest */
});
```

`rootName` becomes a directory under the OS temp area (e.g. `/tmp/my-server-mcp/<session>/`). Refs the model sees (`refs:abc...`) resolve back to files inside that root.

## Classic stdio mode

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { startStdioServer } from "@scottlepper/mcp-toolkit/stdio";
import { buildInputSchema, dispatch } from "@scottlepper/mcp-toolkit/tool";

const server = new Server({ name: "my-server-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({
    name: t.name, description: t.description,
    inputSchema: buildInputSchema(t),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find(t => t.name === req.params.name);
  if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
  const { result } = await dispatch(tool, req.params.arguments,
    { manifest, client, trimRegistry });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

await startStdioServer({
  server,
  banner: "my-server-mcp ready",
  onShutdown: async () => { /* cleanup */ },
});
// Do NOT call process.exit() — stdio keeps the event loop alive.
```

`startStdioServer` handles the two footguns: don't exit after `connect`, install SIGINT/SIGTERM.

## Code-api mode

```ts
import { bootCodeApi, createCodeApiTool } from "@scottlepper/mcp-toolkit/code-api";

const { bridge, ctx } = await bootCodeApi({
  manifest, client, sandbox, trimRegistry,
  cliPath: path.resolve("dist/cli/index.js"),    // bundled CLI binary
  socketEnvVar: "MY_SERVER_MCP_SOCKET",
});

const codeApiTool = createCodeApiTool({
  toolName: "my_server_code_api",
  cliBinaryName: "my-server-cli",
  socketEnvVar: "MY_SERVER_MCP_SOCKET",
});

// Register the single code-api tool on the server and boot as normal stdio.
```

How it works:
1. `bootCodeApi` opens a Unix-socket bridge (loopback TCP on Windows) and exports `MY_SERVER_MCP_SOCKET` into the bundled CLI's env.
2. The MCP host sees one tool (`my_server_code_api`).
3. The model writes shell snippets that invoke `my-server-cli issue.get --issueIdOrKey PROJ-1`.
4. The CLI sees the socket env, dispatches over the bridge into the running server, returns `{ summary, ref }`.

## The bundled CLI

```ts
// dist/cli/index.js
#!/usr/bin/env node
import { createCli } from "@scottlepper/mcp-toolkit/cli";
import { manifest } from "../core/manifest.js";
import { callDirect } from "./direct.js";        // optional direct-mode hook
import { SKILL_CONTENT } from "./skill.js";       // optional install-skill body

const cli = createCli({
  cliName: "my-server-cli",
  socketEnvVar: "MY_SERVER_MCP_SOCKET",
  manifest,
  callDirect,                                     // when no socket: build client in-process
  skillContent: SKILL_CONTENT,                    // enables `my-server-cli install-skill`
  skillSlug: "my-server",
  directModeEnvVars: ["MY_SERVER_HOST", "MY_SERVER_TOKEN"],
});

process.exit(await cli.run(process.argv.slice(2)));
```

`createCli` gives you two modes for free:
- **Bridge mode** — `MY_SERVER_MCP_SOCKET` is set (because the MCP server set it) → forward to the running server.
- **Direct mode** — no socket → call `callDirect` which builds a client in-process. Lets the CLI work standalone for debugging or scripting.

## The `install-skill` subcommand

`createCli` adds an `install-skill` subcommand when `skillContent` + `skillSlug` are set. Writes `~/.claude/skills/<slug>/SKILL.md` so the agent picks up the server-specific skill on demand.

- `my-server-cli install-skill` — write the file.
- `--force` — overwrite an existing one.
- `--print` — dump the rendered SKILL.md to stdout instead.

The `skillContent` body should describe *this server's* tools and patterns — not toolkit internals (those are in this skill).

## Common pitfalls

- **`process.exit(0)` after `server.connect()`** kills the server before it handles any request. Use `startStdioServer` and don't exit.
- **Stdout writes in stdio mode** are interpreted as MCP JSON-RPC frames. Use stderr for logs/banners.
- **The manifest must be JSON-serializable.** No functions, no closures — the CLI bridge passes it across processes.
- **`cliPath` for `bootCodeApi` must be absolute.** Relative paths break under different CWDs.
- **The bridge socket lives in the OS temp dir** with a hash of the working dir. Killing the parent unlinks it; orphaned sockets are cleaned on next boot.
