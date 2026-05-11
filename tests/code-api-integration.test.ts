// End-to-end integration test for the code-api flow.
//
// Wires together: sandbox + manifest + trim registry + bridge server +
// bridge client + CLI scaffolding. Verifies that the same shape every
// consumer server will use round-trips correctly.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { callBridge, startBridge, type BridgeServer } from "../src/bridge/index.js";
import { createCli } from "../src/cli/index.js";
import { invokeAndSandbox } from "../src/bridge/server.js";
import type { Client } from "../src/client/index.js";
import { type Manifest } from "../src/core/manifest.js";
import { createSandbox } from "../src/core/sandbox.js";
import { createTrimRegistry } from "../src/core/trim-registry.js";

interface StubClient extends Client {
  calls: Array<{ verb: string; path: string }>;
}

function makeStubClient(): StubClient {
  const calls: StubClient["calls"] = [];
  return {
    calls,
    async get(path) {
      calls.push({ verb: "GET", path });
      return { id: 42, title: "hello", noise: "discard me" };
    },
    async post(path, body) {
      calls.push({ verb: "POST", path });
      return { ok: true, body };
    },
    async put(path) {
      calls.push({ verb: "PUT", path });
      return { ok: true };
    },
    async delete(path) {
      calls.push({ verb: "DELETE", path });
      return { ok: true };
    },
  };
}

const manifest: Manifest = [
  {
    name: "thing.get",
    description: "fetch one thing",
    verb: "GET",
    pathTemplate: "/things/{id}",
    params: [{ name: "id", role: "path", required: true }],
    trim: "thing",
  },
];

const trimRegistry = createTrimRegistry({
  // Drop the `noise` field — the in-band summary stays compact.
  thing: (raw: unknown) => {
    const r = raw as { id: number; title: string };
    return { id: r.id, title: r.title };
  },
});

describe("code-api integration", () => {
  let tmpDir: string;
  let bridge: BridgeServer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-toolkit-int-"));
  });

  afterEach(async () => {
    if (bridge) await bridge.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("bridge round-trips: client → server → sandbox → trim → summary + ref", async () => {
    const client = makeStubClient();
    const sandbox = createSandbox({
      rootName: "test-mcp",
      sessionId: "int1",
      tmpDir,
    });
    bridge = await startBridge({
      manifest,
      client,
      sandbox,
      trimRegistry,
    });

    const result = await callBridge(bridge.address, "thing.get", {
      id: "abc",
    });

    // Underlying client was called with interpolated path.
    expect(client.calls[0]).toEqual({ verb: "GET", path: "/things/abc" });
    // Trim projection dropped `noise`.
    expect(result.summary).toEqual({ id: 42, title: "hello" });
    // Full untrimmed response is on disk at the ref.
    const onDisk = await fs.readFile(result.ref, "utf8");
    expect(JSON.parse(onDisk)).toEqual({
      id: 42,
      title: "hello",
      noise: "discard me",
    });
  });

  it("invokeAndSandbox: direct dispatch primitive (no socket)", async () => {
    const client = makeStubClient();
    const sandbox = createSandbox({
      rootName: "test-mcp",
      sessionId: "int2",
      tmpDir,
    });

    const result = await invokeAndSandbox(
      { manifest, client, sandbox, trimRegistry },
      "thing.get",
      { id: "xyz" },
    );
    expect(result.summary).toEqual({ id: 42, title: "hello" });
    expect(client.calls[0].path).toBe("/things/xyz");
  });

  it("CLI bridge mode: env var set → calls into bridge", async () => {
    const client = makeStubClient();
    const sandbox = createSandbox({
      rootName: "test-mcp",
      sessionId: "int3",
      tmpDir,
    });
    bridge = await startBridge({
      manifest,
      client,
      sandbox,
      trimRegistry,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    const stdout = { write(s: string) { stdoutBuf += s; } };
    const stderr = { write(s: string) { stderrBuf += s; } };

    const cli = createCli({
      cliName: "test-cli",
      socketEnvVar: "TEST_MCP_SOCKET",
      manifest,
      stdout,
      stderr,
    });

    // Bridge mode is selected by the env var being set.
    process.env.TEST_MCP_SOCKET = bridge.address;
    try {
      const code = await cli.run(["thing.get", "--id=abc"]);
      expect(code).toBe(0);
      // Summary first, then a `ref: ...` line.
      const lines = stdoutBuf.trim().split("\n");
      const refLine = lines[lines.length - 1];
      expect(refLine.startsWith("ref: ")).toBe(true);
      // Summary lines parse as the trim projection.
      const summaryText = lines.slice(0, -1).join("\n");
      expect(JSON.parse(summaryText)).toEqual({ id: 42, title: "hello" });
      expect(stderrBuf).toBe("");
    } finally {
      delete process.env.TEST_MCP_SOCKET;
    }
  });

  it("CLI direct mode: no env var → calls callDirect hook", async () => {
    const client = makeStubClient();
    const sandbox = createSandbox({
      rootName: "test-mcp",
      sessionId: "int4",
      tmpDir,
    });

    let stdoutBuf = "";
    const stdout = { write(s: string) { stdoutBuf += s; } };
    const stderr = { write(_: string) {} };

    const cli = createCli({
      cliName: "test-cli",
      socketEnvVar: "NEVER_SET_THIS_VAR_FOR_TEST",
      manifest,
      callDirect: (op, args) =>
        invokeAndSandbox({ manifest, client, sandbox, trimRegistry }, op, args),
      stdout,
      stderr,
    });

    // Ensure the env var is unset.
    delete process.env.NEVER_SET_THIS_VAR_FOR_TEST;

    const code = await cli.run(["thing.get", "--id=direct"]);
    expect(code).toBe(0);
    expect(client.calls[0].path).toBe("/things/direct");
    const lines = stdoutBuf.trim().split("\n");
    expect(lines[lines.length - 1].startsWith("ref: ")).toBe(true);
  });

  it("CLI errors when neither bridge nor direct mode available", async () => {
    let stderrBuf = "";
    const stdout = { write(_: string) {} };
    const stderr = { write(s: string) { stderrBuf += s; } };

    const cli = createCli({
      cliName: "test-cli",
      socketEnvVar: "NEVER_SET_THIS_VAR_FOR_TEST_2",
      manifest,
      // no callDirect
      stdout,
      stderr,
    });

    delete process.env.NEVER_SET_THIS_VAR_FOR_TEST_2;

    const code = await cli.run(["thing.get", "--id=abc"]);
    expect(code).toBe(1);
    expect(stderrBuf).toContain("not set");
    expect(stderrBuf).toContain("direct mode is not enabled");
  });

  it("CLI surfaces unknown flags before opening the socket", async () => {
    let stderrBuf = "";
    const stdout = { write(_: string) {} };
    const stderr = { write(s: string) { stderrBuf += s; } };

    const cli = createCli({
      cliName: "test-cli",
      socketEnvVar: "TEST_MCP_SOCKET_X",
      manifest,
      stdout,
      stderr,
    });

    process.env.TEST_MCP_SOCKET_X = "/nonexistent.sock";
    try {
      const code = await cli.run(["thing.get", "--id=abc", "--bogus=1"]);
      expect(code).toBe(2);
      expect(stderrBuf).toContain("unknown flag");
    } finally {
      delete process.env.TEST_MCP_SOCKET_X;
    }
  });
});
