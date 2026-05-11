// CLI help renderers.

import type { Manifest, Operation, ParamSpec } from "../core/manifest.js";

export interface TopLevelHelpOptions {
  cliName: string;
  socketEnvVar: string;
  manifest: Manifest;
  // Names of meta-commands (e.g. "install-skill") to surface in the
  // help text. Filled in by the CLI builder.
  metaCommands?: ReadonlyArray<{ name: string; description: string }>;
  // Server-specific env vars to mention in the direct-mode section.
  // E.g. for jira: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"].
  directModeEnvVars?: readonly string[];
}

export function topLevelHelp(options: TopLevelHelpOptions): string {
  // Group operations by category prefix (the bit before the first dot)
  // so the listing stays scannable. Categories already cluster in the
  // manifest, but we re-derive here so re-orderings don't surprise the
  // help text.
  const byCategory = new Map<string, Operation[]>();
  for (const op of options.manifest) {
    const cat = op.name.split(".")[0];
    const list = byCategory.get(cat) ?? [];
    list.push(op);
    byCategory.set(cat, list);
  }

  const directEnvLine =
    options.directModeEnvVars && options.directModeEnvVars.length > 0
      ? `  direct   ${options.socketEnvVar} unset → read ${options.directModeEnvVars.join("/")} from env\n           (or .env.local) and call the API directly. No server required.`
      : `  direct   ${options.socketEnvVar} unset → call the API directly via this CLI's own env.`;

  const lines: string[] = [
    `${options.cliName} — call operations from a shell.`,
    "",
    "Two modes (auto-selected from env):",
    `  bridge   ${options.socketEnvVar} set → forward to a running MCP server.`,
    directEnvLine,
    "",
    "Usage:",
    `  ${options.cliName} <op> [--flag=value ...]`,
    `  ${options.cliName} <op> --help          show args for one operation`,
    `  ${options.cliName} --help               show this listing`,
  ];

  if (options.metaCommands && options.metaCommands.length > 0) {
    for (const meta of options.metaCommands) {
      lines.push(`  ${options.cliName} ${meta.name}`.padEnd(40) + meta.description);
    }
  }

  lines.push(
    "",
    "Flag forms:",
    "  --key=value         --key value         --key=@/path/to/file",
    "  --key=-             read value from stdin",
    "  --key=a --key=b     repeat to build an array (also: --key=a,b)",
    "",
    "On success: trimmed summary on stdout (JSON), full-response path",
    "on the final line as: ref: /tmp/.../...json",
    "",
    "Operations:",
  );

  const cats = Array.from(byCategory.keys()).sort();
  for (const cat of cats) {
    lines.push(`  ${cat}`);
    for (const op of byCategory.get(cat)!) {
      lines.push(`    ${op.name.padEnd(38)} ${op.description}`);
    }
  }
  return lines.join("\n");
}

export function operationHelp(op: Operation): string {
  const lines: string[] = [
    `${op.name} — ${op.description}`,
    `  HTTP: ${op.verb} ${op.pathTemplate}`,
    "",
    "Parameters:",
  ];
  if (op.params.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of op.params) {
      const req = p.required ? "required" : "optional";
      const desc = p.description ? ` — ${p.description}` : "";
      lines.push(
        `  --${p.name.padEnd(28)} ${(p.role as ParamSpec["role"]).padEnd(5)} ${req}${desc}`,
      );
    }
  }
  return lines.join("\n");
}
