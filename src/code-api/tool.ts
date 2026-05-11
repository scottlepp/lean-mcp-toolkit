// The single MCP tool exposed in code-api mode.
//
// In code-api mode the server publishes only this tool. Calling it
// returns the path to the bundled `<server>-cli` binary and the
// socket address; the agent then drives the server through that CLI
// from its own shell and never calls an MCP tool again for reads.
//
// The handler is stateless — the heavy lifting (CLI binary already
// built into the package + bridge startup) happens once at server
// boot. We just describe to the agent what was set up.
//
// Generalized from jira-mcp/src/codeapi/tool.ts. Server-specific bits
// (tool name, CLI binary name, socket env var) are factory parameters.

export interface CodeApiToolContext {
  // Absolute path to the bundled CLI binary (e.g. .../build/cli/index.js).
  cliPath: string;
  // The address shown in `socketEnv=...` snippets and placed in the
  // host process env so subprocesses inherit it.
  socketAddress: string;
}

export interface CreateCodeApiToolOpts {
  // The MCP tool name surfaced in `tools/list`. Convention:
  // `<server>_code_api`. E.g. "jira_code_api", "bitbucket_code_api".
  toolName: string;
  // The CLI binary name shown in `usage` snippets. E.g. "jira-cli",
  // "bitbucket-cli".
  cliBinaryName: string;
  // The env var name the CLI consults to find the socket. Convention:
  // `<SERVER>_MCP_SOCKET`. E.g. "JIRA_MCP_SOCKET", "BITBUCKET_MCP_SOCKET".
  socketEnvVar: string;
  // Override the rendered tool description. Defaults to a generic
  // template using the cliBinaryName.
  description?: string;
}

export interface CodeApiToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, never>;
    required: never[];
    additionalProperties: false;
  };
}

export interface CodeApiToolResponse {
  cli: string;
  socketEnv: string;
  socketAddress: string;
  usage: string;
}

export interface CreateCodeApiToolResult {
  definition: CodeApiToolDefinition;
  buildResponse(ctx: CodeApiToolContext): CodeApiToolResponse;
}

function defaultDescription(cliBinaryName: string): string {
  // Description text rendered in the MCP tool listing. Kept tight so
  // the listing token cost stays under the ~500-token target for
  // code-api mode.
  return (
    `Access the upstream service via the bundled ${cliBinaryName} shell binary. ` +
    `Call once to get the binary path and socket address; every subsequent ` +
    `call is a \`${cliBinaryName} <op> --flag=value\` invocation that returns a ` +
    `trimmed summary on stdout and a ref path to the full response.`
  );
}

export function createCodeApiTool(
  opts: CreateCodeApiToolOpts,
): CreateCodeApiToolResult {
  const description = opts.description ?? defaultDescription(opts.cliBinaryName);

  const definition: CodeApiToolDefinition = {
    name: opts.toolName,
    description,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };

  function buildResponse(ctx: CodeApiToolContext): CodeApiToolResponse {
    // The agent typically runs this via Claude Code's Bash tool, whose
    // child shells *do not* inherit env vars from the MCP server
    // process. So the snippet must export the socket env var inline
    // rather than assume it's already set.
    //
    // We prefix invocations with `node` rather than relying on the
    // shebang + exec bit. `npm install` sets the exec bit when wiring
    // `bin` entries, but a freshly-built local checkout (the common
    // dev path) leaves the file non-executable, and the agent has no
    // reason to suspect that. `node <path>` works either way.
    const cmd = `node ${ctx.cliPath}`;
    const usage = [
      `# ${opts.socketEnvVar} prefix is load-bearing — child shells don't`,
      `# inherit the MCP server's env.`,
      `${opts.socketEnvVar}=${ctx.socketAddress} \\`,
      `  ${cmd} <op> --flag=value`,
      `# stdout: trimmed summary as JSON, then a final \`ref: /path\` line`,
      `# pointing at the full response on disk (\`cat\` it for detail).`,
      `# Discovery: \`${cmd} --help\` lists ops;`,
      `# \`${cmd} <op> --help\` lists flags.`,
    ].join("\n");

    return {
      cli: ctx.cliPath,
      socketEnv: opts.socketEnvVar,
      socketAddress: ctx.socketAddress,
      usage,
    };
  }

  return { definition, buildResponse };
}
