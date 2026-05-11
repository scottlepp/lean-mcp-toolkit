// Generic config helpers for SDK consumers.
//
// Server-specific env var names (JIRA_HOST, BITBUCKET_WORKSPACE, etc.)
// stay in each consumer's `config.ts`. The SDK provides only the
// shared parsing logic: tool filtering, mode selection, CSV splitting.

export interface ToolFilterConfig {
  // Whitelist of consolidated tool categories. Empty = no filter
  // (all categories enabled).
  enabledCategories: string[];
  // Blacklist of fine-grained manifest operation names like
  // "issue.delete", "branching.project_settings_update". Empty = no
  // actions disabled.
  disabledActions: string[];
}

export interface ParseToolFilterOpts {
  // Raw value of the "enabled categories" env var. Typically
  // process.env.JIRA_ENABLED_CATEGORIES / BITBUCKET_ENABLED_CATEGORIES.
  enabledCategoriesEnv: string | undefined;
  // Raw value of the "disabled actions" env var.
  disabledActionsEnv: string | undefined;
  // Valid category names. Unknown values in the env are dropped with
  // a stderr warning rather than thrown — a typo shouldn't crash the
  // server.
  validCategories: readonly string[];
  // Env var name used in the warning message. Defaults to a generic
  // string; pass the actual var name (e.g. "BITBUCKET_ENABLED_CATEGORIES")
  // for a useful diagnostic.
  envVarName?: string;
  // Override stderr writer (tests).
  stderr?: { write(s: string): void };
}

// Generic CSV parser shared between filter parsers. Trims whitespace
// and drops empty entries.
export function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse the `enabled categories` + `disabled actions` env-var pair
// into a normalized config. Server passes the raw env values plus the
// set of categories it actually defines; the SDK handles trimming,
// CSV splitting, and unknown-category warnings.
//
// disabledActions are NOT validated here — the SDK doesn't know the
// server's manifest. Validate at dispatch time against
// `assertOperationEnabled` in core/manifest.
export function parseToolFilterEnv(
  opts: ParseToolFilterOpts,
): ToolFilterConfig {
  const stderr = opts.stderr ?? process.stderr;
  const requested = splitCsv(opts.enabledCategoriesEnv);
  const valid = new Set<string>(opts.validCategories);
  const enabledCategories: string[] = [];
  const envVarName = opts.envVarName ?? "ENABLED_CATEGORIES";

  for (const cat of requested) {
    if (valid.has(cat)) {
      enabledCategories.push(cat);
    } else {
      stderr.write(
        `Warning: Unknown category "${cat}" in ${envVarName}. ` +
          `Valid categories: ${opts.validCategories.join(", ")}\n`,
      );
    }
  }

  return {
    enabledCategories,
    disabledActions: splitCsv(opts.disabledActionsEnv),
  };
}

// Tool mode parser. Most servers expose two modes: "classic"
// (consolidated MCP tools) and "code-api" (single tool + CLI bridge).
// Pass the raw env value; returns one of "classic" | "code-api".
// Throws on invalid input.
export type ToolMode = "classic" | "code-api";

export function parseToolMode(
  raw: string | undefined,
  options: { envVarName?: string; default?: ToolMode } = {},
): ToolMode {
  const dflt = options.default ?? "classic";
  if (raw === undefined || raw === "") return dflt;
  if (raw === "classic" || raw === "code-api") return raw;
  const envVarName = options.envVarName ?? "TOOL_MODE";
  throw new Error(
    `Invalid ${envVarName}=${raw}. Expected "classic" (default) or "code-api".`,
  );
}
