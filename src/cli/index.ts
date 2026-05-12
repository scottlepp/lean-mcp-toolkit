// CLI scaffolding for bundled `<server>-cli` binaries.
//
// Each server's CLI is a thin file:
//
//   #!/usr/bin/env node
//   import { createCli } from "@scottlepper/mcp-toolkit/cli";
//   import { operations } from "../core/operations.js";
//   import { callDirect } from "./direct.js";
//   import { SKILL_CONTENT } from "./skill.js";
//   const cli = createCli({
//     cliName: "bitbucket-cli",
//     socketEnvVar: "BITBUCKET_MCP_SOCKET",
//     manifest: operations,
//     callDirect,
//     skillContent: SKILL_CONTENT,
//     skillSlug: "bitbucket",
//   });
//   void cli.run(process.argv.slice(2)).then(c => process.exit(c));
//
// The cli object exposes `run(argv)` — returns the exit code. Used
// directly by the CLI's main(), and by the integration tests.

import { callBridge } from "../bridge/client.js";
import { findOperation, type Manifest, type ParamSpec } from "../core/manifest.js";
import type { SandboxResult } from "../types/refs.js";
import { operationHelp, topLevelHelp } from "./help.js";
import { installSkill } from "./install-skill.js";
import { parseArgv, type ParsedArgv } from "./parse-argv.js";

// Servers without their own client (or running without an MCP server
// present) wire their own `callDirect` that builds a client in-process
// and dispatches through `invokeAndSandbox`. The SDK provides the
// signature; servers supply the implementation because Client
// construction is auth-specific.
export type CallDirectFn = (
  operation: string,
  args: Record<string, unknown>,
) => Promise<SandboxResult<unknown>>;

export interface CreateCliOpts {
  // Display name of the CLI binary, e.g. "bitbucket-cli".
  cliName: string;
  // Env var the CLI consults to find the bridge socket. E.g.
  // "BITBUCKET_MCP_SOCKET". When unset, falls through to direct mode.
  socketEnvVar: string;
  // The operation manifest the CLI dispatches against.
  manifest: Manifest;
  // Hook the CLI invokes when no socket is present. The server
  // provides this. If omitted, direct mode is unsupported and the
  // CLI errors with a clear message when the socket is missing.
  callDirect?: CallDirectFn;
  // SKILL.md body for the `install-skill` meta-command. Optional —
  // when omitted, `install-skill` is hidden from `--help`.
  skillContent?: string;
  // Slug used for the install path (~/.claude/skills/<slug>/SKILL.md).
  // Required if skillContent is set.
  skillSlug?: string;
  // Env vars to mention in the direct-mode help text (e.g.
  // ["JIRA_HOST","JIRA_EMAIL","JIRA_API_TOKEN"]).
  directModeEnvVars?: readonly string[];
  // Override stdout/stderr writers (tests).
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

export interface Cli {
  // Run the CLI with the given argv (excluding the node/binary
  // entries). Returns the process exit code.
  run(argv: readonly string[]): Promise<number>;
}

export function createCli(opts: CreateCliOpts): Cli {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const metaCommands: Array<{ name: string; description: string }> = [];
  if (opts.skillContent) {
    metaCommands.push({
      name: "install-skill",
      description: "install a Claude Code skill so agents discover this CLI",
    });
  }

  async function run(argv: readonly string[]): Promise<number> {
    let parsed: ParsedArgv;
    try {
      parsed = await parseArgv(argv);
    } catch (err) {
      stderr.write(`${opts.cliName}: ${(err as Error).message}\n`);
      return 2;
    }

    if (parsed.command === "" && parsed.help) {
      stdout.write(
        `${topLevelHelp({
          cliName: opts.cliName,
          socketEnvVar: opts.socketEnvVar,
          manifest: opts.manifest,
          metaCommands,
          directModeEnvVars: opts.directModeEnvVars,
        })}\n`,
      );
      return 0;
    }
    if (parsed.command === "") {
      stderr.write(
        `${opts.cliName}: missing operation. Try \`${opts.cliName} --help\`.\n`,
      );
      return 2;
    }

    if (parsed.command === "install-skill" && opts.skillContent) {
      return runInstallSkill(parsed, opts, stdout, stderr);
    }

    let op;
    try {
      op = findOperation(opts.manifest, parsed.command);
    } catch {
      stderr.write(
        `${opts.cliName}: unknown operation "${parsed.command}". Try \`${opts.cliName} --help\`.\n`,
      );
      return 2;
    }

    if (parsed.help) {
      stdout.write(`${operationHelp(op)}\n`);
      return 0;
    }

    // Pre-flight: surface unknown flags before opening a socket. The
    // bridge would accept and silently drop them (splitArgs records
    // them in `unknown` but the dispatcher doesn't reject), and the
    // user would never know their typo did nothing.
    const known = new Set(op.params.map((p: ParamSpec) => p.name));
    const unknown = Object.keys(parsed.flags).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      stderr.write(
        `${opts.cliName}: unknown flag(s) for ${op.name}: ${unknown.join(", ")}. ` +
          `Try \`${opts.cliName} ${op.name} --help\`.\n`,
      );
      return 2;
    }

    // Two modes:
    //   bridge mode: socket env var set → forward to running MCP server.
    //   direct mode: no socket → server's callDirect hook builds a
    //     client in-process and dispatches locally.
    const address = process.env[opts.socketEnvVar];
    let result: SandboxResult<unknown>;
    try {
      if (address) {
        result = await callBridge(address, op.name, parsed.flags);
      } else if (opts.callDirect) {
        result = await opts.callDirect(op.name, parsed.flags);
      } else {
        stderr.write(
          `${opts.cliName}: ${opts.socketEnvVar} is not set and direct mode is not enabled for this CLI.\n`,
        );
        return 1;
      }
    } catch (err) {
      stderr.write(
        `${opts.cliName}: ${(err as Error).name}: ${(err as Error).message}\n`,
      );
      return 1;
    }

    // Layout: the trimmed summary first (JSON, pretty-printed for
    // readability in a terminal), then a single trailing line pointing
    // at the on-disk ref. The `ref:` prefix is unambiguous and easy to
    // grep out programmatically.
    stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
    stdout.write(`ref: ${result.ref}\n`);
    return 0;
  }

  return { run };
}

async function runInstallSkill(
  parsed: ParsedArgv,
  opts: CreateCliOpts,
  stdout: { write(s: string): void },
  stderr: { write(s: string): void },
): Promise<number> {
  if (!opts.skillContent || !opts.skillSlug) {
    stderr.write(
      `${opts.cliName}: install-skill is not configured for this CLI.\n`,
    );
    return 2;
  }

  if (parsed.help) {
    stdout.write(
      [
        `${opts.cliName} install-skill — install a Claude Code skill that`,
        "teaches the agent how to call this CLI.",
        "",
        `Writes ~/.claude/skills/${opts.skillSlug}/SKILL.md. Once installed, the`,
        "skill loads on demand whenever the user mentions the domain.",
        "",
        "Flags:",
        "  --force    overwrite an existing SKILL.md",
        "  --print    print the rendered SKILL.md to stdout (no write)",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const known = new Set(["force", "print"]);
  const unknown = Object.keys(parsed.flags).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    stderr.write(
      `${opts.cliName}: unknown flag(s) for install-skill: ${unknown.join(", ")}.\n`,
    );
    return 2;
  }

  const force = "force" in parsed.flags;
  const print = "print" in parsed.flags;

  if (print) {
    stdout.write(opts.skillContent);
    return 0;
  }

  const result = await installSkill({
    content: opts.skillContent,
    slug: opts.skillSlug,
    force,
  });
  switch (result.action) {
    case "wrote":
      stdout.write(`Wrote ${result.path}\n`);
      return 0;
    case "overwrote":
      stdout.write(`Overwrote ${result.path}\n`);
      return 0;
    case "exists":
      stderr.write(
        `${result.path} already exists. Use --force to overwrite, or --print to dump the new content to stdout.\n`,
      );
      return 1;
    case "printed":
      return 0;
  }
}

export { parseArgv, type ParsedArgv } from "./parse-argv.js";
export { topLevelHelp, operationHelp } from "./help.js";
export { installSkill, type InstallSkillOpts, type InstallSkillResult } from "./install-skill.js";
