// Bridge module — IPC socket between the MCP host and the bundled
// CLI used by code-api mode. The server side runs inside the MCP
// process and listens; the client side runs inside `<server>-cli` and
// connects.

export * from "./wire.js";
export {
  startBridge,
  invokeAndSandbox,
  defaultBridgeAddress,
  type BridgeServer,
  type BridgeAddress,
  type DefaultBridgeAddressOpts,
  type StartBridgeOpts,
} from "./server.js";
export { callBridge, parseSocketAddress } from "./client.js";
