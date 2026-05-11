// Argv parser shared between every server's bundled CLI.
//
// Flag value resolution rules:
//   --key=value          → flags.key = "value"
//   --key value          → flags.key = "value"
//   --key=@/path/file    → flags.key = (contents of /path/file)
//   --key=-              → flags.key = (read all of stdin)
//   --key=value --key=2  → flags.key = ["value", "2"]
//
// Operation flags must carry a value — every manifest param does, so
// a bare `--flag` for an op is almost certainly a typo and we error.
// A small allowlist of *boolean* flag names (passed in `booleanFlags`)
// is recognized for meta-commands like `install-skill`; bare presence
// stores `""` and callers check existence via `key in flags`.

import * as fs from "node:fs/promises";

export interface ParsedArgv {
  // The positional <resource>.<op> identifier, or a meta command.
  // Empty string when invoked with no positional (we show top-level help).
  command: string;
  // --key=value flags. Repeated flags collapse to an array;
  // comma-separated values stay as single strings (server-side
  // coerces to comma-separated for query params anyway, so passing
  // them through verbatim is correct).
  flags: Record<string, string | string[]>;
  // --help anywhere on the line.
  help: boolean;
}

export interface ParseArgvOptions {
  // Boolean flags accepted in bare form (presence-only). Defaults to
  // a small set used by built-in meta commands: ["force", "print"].
  booleanFlags?: ReadonlySet<string>;
}

const DEFAULT_BOOLEAN_FLAGS = new Set(["force", "print"]);

export async function parseArgv(
  argv: readonly string[],
  options: ParseArgvOptions = {},
): Promise<ParsedArgv> {
  const booleanFlags = options.booleanFlags ?? DEFAULT_BOOLEAN_FLAGS;
  const out: ParsedArgv = { command: "", flags: {}, help: false };
  let positional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) {
      if (positional === null) positional = a;
      else throw new Error(`Unexpected positional argument: ${a}`);
      continue;
    }
    const eq = a.indexOf("=");
    let key: string;
    let value: string;
    if (eq >= 0) {
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      const lookahead = next === undefined || next.startsWith("--");
      if (lookahead && booleanFlags.has(key)) {
        // Bare boolean meta flag — store presence, no value to consume.
        value = "";
      } else if (lookahead) {
        throw new Error(
          `Flag --${key} expects a value (use --${key}=value or --${key} value).`,
        );
      } else {
        value = next;
        i++;
      }
    }
    if (!key) throw new Error(`Empty flag name in argument: ${a}`);
    const resolved = await resolveValue(value);
    const existing = out.flags[key];
    if (existing === undefined) {
      out.flags[key] = resolved;
    } else if (Array.isArray(existing)) {
      existing.push(resolved);
    } else {
      out.flags[key] = [existing, resolved];
    }
  }

  out.command = positional ?? "";
  return out;
}

async function resolveValue(value: string): Promise<string> {
  if (value === "-") {
    return readStdin();
  }
  if (value.startsWith("@")) {
    return fs.readFile(value.slice(1), "utf8");
  }
  return value;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}
