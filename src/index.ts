// ultra-mcp-toolkit — umbrella export.
//
// Importing from the package root pulls in every public surface. For
// tree-shaking, prefer the namespaced subpath imports declared in
// package.json `exports`:
//
//   import { createSandbox } from "ultra-mcp-toolkit/sandbox";
//   import { createPageCache } from "ultra-mcp-toolkit/page-cache";
//   import { invokeOperation } from "ultra-mcp-toolkit/manifest";
//   import { pick, paginatedListSummary } from "ultra-mcp-toolkit/trim";
//   import { startBridge, callBridge } from "ultra-mcp-toolkit/bridge";
//   import { bootCodeApi, createCodeApiTool } from "ultra-mcp-toolkit/code-api";
//   import { createCli } from "ultra-mcp-toolkit/cli";
//   import { dispatch, buildInputSchema } from "ultra-mcp-toolkit/tool";
//   import { positiveInt } from "ultra-mcp-toolkit/schemas";
//   import { createHttpClient } from "ultra-mcp-toolkit/http-client";
//   import { createMutationAck } from "ultra-mcp-toolkit/mutation-ack";
//   import { startStdioServer } from "ultra-mcp-toolkit/stdio";
//   import { SafetyChecker, resolveSafePath } from "ultra-mcp-toolkit/agent-safety";
//   import { createFileTools, createGitTools } from "ultra-mcp-toolkit/agent-tools";
//
// agent-tools is intentionally NOT re-exported from the umbrella below —
// it pulls in `ai` and `@octokit/rest` (optional peers). Only consumers that
// explicitly import the subpath pay that dependency cost.

export * from "./core/sandbox.js";
export * from "./core/page-cache.js";
export * from "./core/manifest.js";
export * from "./core/trim.js";
export * from "./core/trim-registry.js";
export * from "./core/lru.js";
export * from "./core/disk-cache.js";
export * from "./bridge/index.js";
export * from "./code-api/index.js";
export * from "./cli/index.js";
export * from "./client/index.js";
export * from "./client/http.js";
export * from "./client/transport.js";
export * from "./client/streaming.js";
export * from "./config/index.js";
export * from "./tool/dispatcher.js";
export * from "./schemas/index.js";
export * from "./trim/mutation-ack.js";
export * from "./boot/stdio.js";
export * from "./agent-safety/index.js";
export type * from "./types/refs.js";
