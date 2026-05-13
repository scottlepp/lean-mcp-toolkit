# AGENTS.md

Guidance for coding agents (Claude Code, Codex CLI, Cursor, Aider, Continue, Zed, etc.) working in this repo.

## What this repo is

`@scottlepper/mcp-toolkit` — shared infrastructure for building token-efficient [MCP](https://modelcontextprotocol.io) servers. Extracted from production servers (`jira-mcp`, `confluence-mcp`, `bitbucket-mcp`).

Two distinct concerns when working here:
1. **Contributing to the toolkit** (this file) — build, test, conventions.
2. **Using the toolkit to build an MCP server** — see [.claude/skills/mcp-toolkit/SKILL.md](.claude/skills/mcp-toolkit/SKILL.md) and its `references/`. Plain markdown; non-Claude agents can be pointed at these files directly.

## Project layout

```
src/
  boot/        startStdioServer — MCP stdio boot helper
  bridge/      IPC socket bridge (code-api mode)
  cli/         createCli — CLI scaffolding for bundled <server>-cli binaries
  client/      Client interface + bundled HTTP client + transport
  code-api/    bootCodeApi + createCodeApiTool (single-MCP-tool mode)
  config/      env-var parsing helpers
  core/        manifest, trim, trim-registry, sandbox, page-cache, LRU
  schemas/     shared Zod schemas (positiveInt, etc.)
  tool/        consolidated-tool dispatcher (dispatch, buildInputSchema)
  trim/        mutation-ack envelope
  types/       SandboxResult, ref types
tests/         integration tests (Vitest)
scripts/       install-skill.mjs and other dev scripts
.claude/       Claude-specific skill content (plain markdown)
build/         compiled output (gitignored)
```

Public API surface is declared via `package.json` `exports` — each subpath maps to a `build/.../*.js` + `.d.ts`. Adding a new subpath requires both an export entry and (if it should ship) the source under `src/`.

## Build, test, lint

```bash
npm install
npm run build         # tsc → ./build (also runs on `npm prepare`)
npm run dev           # tsc --watch
npm test              # vitest run (162+ tests)
npm run test:watch    # vitest --watch
npm run clean         # rm -rf build
npm run install-skill # install the bundled Claude Code skill (--help for flags)
```

No linter is configured. TypeScript is the only static check (`strict: true`).

## Conventions

### Manifest is pure data
Operations are JSON-serializable. No functions, no closures in `Operation` or its `meta`. The CLI bridge serializes the manifest across processes.

### Trim functions are allowlists
Declare what to keep; never what to drop. New API fields default to dropped. Helpers: `pick`, `paginatedListSummary`, `bareListSummary`.

### One concern per module
Don't grow `core/manifest.ts` to include HTTP. Don't grow `core/trim.ts` to include trim-registry logic. Each subpath in `package.json` exports is its own concern; splits should be clean.

### Stdio mode rules
- Do not call `process.exit()` after `server.connect()` — stdio keeps the event loop alive.
- Stdout is the MCP JSON-RPC channel; write banners and logs to stderr.

### Errors carry context
`DispatchError(message, action, tool?)` — populate `tool` from inside `dispatch()` so consumer catch sites can read it. `ToolError` is an alias for the same shape.

### Tests live next to source
`foo.ts` → `foo.test.ts` in the same dir. Vitest's `include` glob picks up both `src/**/*.test.ts` and `tests/**/*.test.ts`. Add a test for every new exported function.

### Type-only re-exports
For umbrella exports, prefer `export type *` when no runtime code crosses (`types/refs.ts` is type-only).

### No emojis in code or docs
Unless the user explicitly asks. This applies to skill content too.

### Commits and PRs
- One PR = one cohesive change. Bug fix doesn't drag in surrounding refactors.
- Bump `package.json` version in the PR that ships breaking or notable changes; tag and publish are manual.
- Version planning lives in `V<n>_PLAN.md` files at repo root while in flight (deleted on merge). See `V0.4_PLAN.md` for the current shape.

## Agent-specific notes

### Claude Code
- This repo ships a Claude Code skill at [.claude/skills/mcp-toolkit/](.claude/skills/mcp-toolkit/) — hub `SKILL.md` plus topic references. Install with `npm run install-skill` (user-global) or `npm run install-skill -- --project` (cwd).
- `CLAUDE.md` at repo root just points back here — single source of truth.

### Codex CLI, Cursor, Aider, Continue, Zed, Warp, etc.
- Read this file first.
- For toolkit-usage guidance (building an MCP server *with* the toolkit), point yourself at the skill markdown:
  - [.claude/skills/mcp-toolkit/SKILL.md](.claude/skills/mcp-toolkit/SKILL.md) (entry / mental model)
  - [.claude/skills/mcp-toolkit/references/manifest.md](.claude/skills/mcp-toolkit/references/manifest.md)
  - [.claude/skills/mcp-toolkit/references/trim.md](.claude/skills/mcp-toolkit/references/trim.md)
  - [.claude/skills/mcp-toolkit/references/dispatcher.md](.claude/skills/mcp-toolkit/references/dispatcher.md)
  - [.claude/skills/mcp-toolkit/references/server-boot.md](.claude/skills/mcp-toolkit/references/server-boot.md)
- These files are plain markdown — no Claude-specific format dependencies in the body. Frontmatter (`---name: ... ---`) is Claude-only metadata and can be ignored.

## Don'ts

- Don't add a runtime dependency without checking the bundle impact. Toolkit deps stay minimal (`@modelcontextprotocol/sdk`, `undici`; `zod` is a peer).
- Don't introduce model-side chunking. If a response needs paging or filtering, the server does it deterministically.
- Don't break public exports across minor versions. Add new subpaths; rename via deprecation cycles.
- Don't put functions or closures in the manifest's `meta` — it must JSON-serialize.
- Don't write code comments that restate what well-named code already says.

## Where things are documented

- **README.md** — user-facing: what's in the box, MVP consumer example, per-version module deep-dives, status notes.
- **AGENTS.md** (this file) — contributor-facing, agent-agnostic.
- **CLAUDE.md** — pointer to AGENTS.md.
- **.claude/skills/mcp-toolkit/** — building-MCP-servers guide for agents.
- **V<n>_PLAN.md** — in-flight version plan (transient).
