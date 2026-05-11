// Bridge client — runs inside the bundled CLI process.
//
// Connects to the bridge server's local socket, sends one
// newline-delimited JSON request, reads one response, closes.
// The bridge supports multiplexing on a single connection but a CLI
// invocation is single-shot — keeping the connection short-lived
// avoids any need to track in-flight requests.

import * as net from "node:net";

import type { SandboxResult } from "../types/refs.js";
import type { BridgeRequest } from "./wire.js";

export interface BridgeCallError extends Error {
  name: string;
}

// Parse a server-supplied socket address. POSIX paths come through
// verbatim; Windows TCP addresses arrive as "tcp:host:port" so the
// caller can distinguish them.
export function parseSocketAddress(address: string): net.Socket {
  if (address.startsWith("tcp:")) {
    const rest = address.slice(4);
    const colon = rest.lastIndexOf(":");
    if (colon < 0) throw new Error(`Malformed socket address: ${address}`);
    const host = rest.slice(0, colon);
    const port = Number(rest.slice(colon + 1));
    return net.connect({ host, port });
  }
  return net.connect({ path: address });
}

// Open the socket, send one request, read one response, close.
export function callBridge(
  address: string,
  operation: string,
  args: Record<string, unknown>,
): Promise<SandboxResult<unknown>> {
  return new Promise((resolve, reject) => {
    const socket = parseSocketAddress(address);
    let buffer = "";
    let settled = false;
    const finish = (
      kind: "ok" | "err",
      payload: SandboxResult<unknown> | { name: string; message: string },
    ) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (kind === "ok") {
        resolve(payload as SandboxResult<unknown>);
      } else {
        const e = payload as { name: string; message: string };
        const err = new Error(e.message);
        err.name = e.name;
        reject(err);
      }
    };

    socket.setEncoding("utf8");
    socket.on("error", (err) =>
      finish("err", { name: "SocketError", message: err.message }),
    );
    socket.on("close", () => {
      if (!settled) {
        finish("err", {
          name: "SocketError",
          message: "socket closed before response",
        });
      }
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      try {
        const resp = JSON.parse(line) as
          | { id: string; result: SandboxResult<unknown> }
          | { id: string; error: { name: string; message: string } };
        if ("error" in resp) finish("err", resp.error);
        else finish("ok", resp.result);
      } catch (err) {
        finish("err", {
          name: "ParseError",
          message: `Invalid response from bridge: ${(err as Error).message}`,
        });
      }
    });

    socket.on("connect", () => {
      const req: BridgeRequest = {
        id: "1",
        method: "invoke",
        params: { operation, args },
      };
      socket.write(`${JSON.stringify(req)}\n`);
    });
  });
}
