// Wire format shared between the bridge server (in the MCP host) and
// the bridge client (in the bundled CLI). Newline-delimited JSON: each
// line is one request or one response.
//
//   request:  { "id": "<string>", "method": "invoke",
//               "params": { "operation": "<name>",
//                           "args": <object> } }
//   ok:       { "id": "<string>", "result": <SandboxResult> }
//   err:      { "id": "<string>",
//               "error": { "name": "<string>", "message": "<string>" } }
//
// The `id` field lets multiple in-flight requests on one connection
// be demultiplexed by the client. We use a small explicit envelope
// rather than full JSON-RPC 2.0 — no need for notification/batch
// semantics.

import type { SandboxResult } from "../types/refs.js";

export interface BridgeRequest {
  id: string;
  method: "invoke";
  params: {
    operation: string;
    args?: Record<string, unknown>;
  };
}

export interface BridgeOkResponse {
  id: string;
  result: SandboxResult<unknown>;
}

export interface BridgeErrResponse {
  id: string;
  error: {
    name: string;
    message: string;
  };
}

export type BridgeResponse = BridgeOkResponse | BridgeErrResponse;
