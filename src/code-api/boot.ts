// Code-api startup glue.
//
// Encapsulates the wiring (cleanup → resolve CLI path → start bridge
// → publish socket env var) so the host server's `index.ts` just
// imports `bootCodeApi` and forwards a client + manifest + sandbox.
//
// Generalized from jira-mcp/src/codeapi/boot.ts. Server-specific bits
// (CLI binary location, socket env var name) are parameters.

import type { Client } from "../client/index.js";
import type { ExecuteFn, Manifest } from "../core/manifest.js";
import type { SandboxInstance } from "../core/sandbox.js";
import type { TrimRegistry } from "../core/trim-registry.js";
import { startBridge, type BridgeServer } from "../bridge/server.js";
import type { CodeApiToolContext } from "./tool.js";

export interface BootedCodeApi {
  bridge: BridgeServer;
  ctx: CodeApiToolContext;
}

export interface BootCodeApiOpts {
  manifest: Manifest;
  client: Client;
  sandbox: SandboxInstance;
  // Looked up by `op.trim` keys to build summaries on bridge results.
  trimRegistry: TrimRegistry;
  // Absolute path to the bundled CLI binary. Resolve in the host
  // server (it knows its own package layout) and pass it in.
  cliPath: string;
  // Env var the CLI consults for the socket address. Set in the host
  // process env so child shells inherit it. E.g. "BITBUCKET_MCP_SOCKET".
  socketEnvVar: string;
  // Forwarded to startBridge so disabled-actions rules apply to
  // bridge dispatch.
  disabledActions?: readonly string[];
  // Optional execute hook for multi-API routing.
  execute?: ExecuteFn;
  // When false, skip the cleanup-stale-sessions sweep at startup.
  // Defaults to true. Tests turn this off to avoid touching siblings
  // of their session dir.
  cleanupSessions?: boolean;
}

export async function bootCodeApi(
  opts: BootCodeApiOpts,
): Promise<BootedCodeApi> {
  if (opts.cleanupSessions !== false) {
    await opts.sandbox.cleanupStaleSessions().catch(() => {
      // Best-effort. Permission failures on a stale dir shouldn't
      // block startup.
    });
  }

  const bridge = await startBridge({
    manifest: opts.manifest,
    client: opts.client,
    sandbox: opts.sandbox,
    trimRegistry: opts.trimRegistry,
    disabledActions: opts.disabledActions,
    execute: opts.execute,
  });

  // Place the socket in the *server* env so any subprocess (Claude
  // Code's Bash tool, a direct CLI invocation) inherits it without
  // the user having to configure anything.
  process.env[opts.socketEnvVar] = bridge.address;

  return {
    bridge,
    ctx: { cliPath: opts.cliPath, socketAddress: bridge.address },
  };
}
