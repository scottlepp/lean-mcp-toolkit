// Stdio MCP-server startup helper.
//
// Hides two footguns:
//   1. `process.exit(0)` after `server.connect()` looks harmless but
//      terminates the process before any request can be handled.
//      Stdio transport keeps the event loop alive on its own —
//      the only correct behavior is to *return*.
//   2. SIGINT / SIGTERM should call a cleanup hook (if any) and then
//      exit cleanly. Most servers forget this; the result is dangling
//      sandbox dirs, half-written caches, etc.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export interface StdioBootOpts {
  server: Server;
  // One-line stderr banner emitted after server.connect(). Optional.
  // Convention: short name + mode/version, no trailing newline
  // (added by the helper).
  banner?: string;
  // Optional cleanup on SIGINT/SIGTERM. Called before process.exit(0).
  // Errors are swallowed (best-effort cleanup on shutdown).
  onShutdown?: (signal: NodeJS.Signals) => Promise<void> | void;
}

// Connects the server to a stdio transport, optionally writes a
// stderr banner, and installs SIGINT/SIGTERM handlers. Returns when
// the connect handshake completes — does NOT exit; stdio transport
// keeps the loop alive.
export async function startStdioServer(opts: StdioBootOpts): Promise<void> {
  const transport = new StdioServerTransport();
  await opts.server.connect(transport);

  if (opts.banner) {
    // Stderr because stdout is the MCP transport channel; anything
    // written there is interpreted as a JSON-RPC frame.
    process.stderr.write(`${opts.banner}\n`);
  }

  if (opts.onShutdown) {
    const onShutdown = opts.onShutdown;
    const handler = (signal: NodeJS.Signals) => {
      void (async () => {
        try {
          await onShutdown(signal);
        } catch {
          // Best-effort: we're shutting down anyway, don't block exit.
        }
        process.exit(0);
      })();
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }
}
