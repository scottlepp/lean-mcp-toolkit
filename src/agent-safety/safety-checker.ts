import { isProtectedPath, type SafePathOptions } from "./safe-path.js";

/**
 * Coarse content filter for autonomous-agent inputs and outputs.
 *
 * This is NOT the primary defense. The primary defenses are:
 *   - path restriction (see safe-path.ts)
 *   - argv-style shelling (no shell interpolation in command construction)
 *   - the maintainer label gate at the workflow level
 *
 * Treat these patterns as defense-in-depth: they catch the most common naive
 * injection attempts and shouldn't be relied on alone.
 */
const HARMFUL_PATTERNS: readonly RegExp[] = [
  // Security bypass
  /bypass.*auth/i,
  /disable.*security/i,
  /remove.*validation/i,
  /skip.*check/i,
  /turn off.*safety/i,
  /ignore (your|previous|the) (rules|instructions|safety)/i,

  // Credential exposure
  /hardcode.*password/i,
  /expose.*secret/i,
  /log.*credential/i,
  /print.*token/i,
  /console\.log\s*\([^)]*(?:token|secret|key|password|credential)/i,

  // Destructive operations
  /\bdelete.*all\b/i,
  /\bdrop\s+(?:database|table)/i,
  /\brm\s+-rf/i,
  /truncate\s+table/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,

  // Code-execution sinks
  /\beval\s*\(/i,
  /\bnew\s+Function\s*\(/i,
  /child_process/i,
  /\bexec(?:Sync)?\s*\(/i,
  /\bspawn(?:Sync)?\s*\(/i,
  /\b__import__\b/i,
];

/** Shell metacharacters that must never appear in model-written shell args. */
const SHELL_INJECTION_PATTERNS: readonly RegExp[] = [
  /\$\(/,
  /`[^`]*`/,
  />\s*\/dev\//,
  /\|\s*(?:sh|bash|zsh|curl|wget|nc|netcat)\b/i,
];

/**
 * Heuristic detector for plaintext secrets the agent might be tricked into
 * embedding into commit messages, PR bodies, or file contents. Patterns are
 * intentionally narrow to keep false positives low.
 */
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/,
];

export interface ProposedChange {
  filePath: string;
  content?: string;
}

export interface SafetyCheckResult {
  safe: boolean;
  reason?: string;
  severity?: "low" | "medium" | "high" | "critical";
}

export interface SafetyCheckerOptions extends SafePathOptions {
  /** Extra harmful-content regexes appended to the defaults. */
  extraHarmfulPatterns?: readonly RegExp[];
  /** Extra shell-injection regexes appended to the defaults. */
  extraShellInjectionPatterns?: readonly RegExp[];
  /** Extra secret-shape regexes appended to the defaults. */
  extraSecretPatterns?: readonly RegExp[];
}

export class SafetyChecker {
  private readonly pathOptions: SafePathOptions;
  private readonly harmful: readonly RegExp[];
  private readonly shell: readonly RegExp[];
  private readonly secrets: readonly RegExp[];

  constructor(options: SafetyCheckerOptions = {}) {
    this.pathOptions = {
      extraProtected: options.extraProtected,
      replaceProtected: options.replaceProtected,
      allowlist: options.allowlist,
    };
    this.harmful = options.extraHarmfulPatterns
      ? [...HARMFUL_PATTERNS, ...options.extraHarmfulPatterns]
      : HARMFUL_PATTERNS;
    this.shell = options.extraShellInjectionPatterns
      ? [...SHELL_INJECTION_PATTERNS, ...options.extraShellInjectionPatterns]
      : SHELL_INJECTION_PATTERNS;
    this.secrets = options.extraSecretPatterns
      ? [...SECRET_SHAPE_PATTERNS, ...options.extraSecretPatterns]
      : SECRET_SHAPE_PATTERNS;
  }

  /** Check if a tool call is safe to execute. */
  async checkToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<SafetyCheckResult> {
    const pathLikeKeys = ["filePath", "path", "dirPath", "file"];
    for (const key of pathLikeKeys) {
      const v = args[key];
      if (typeof v === "string" && isProtectedPath(v, this.pathOptions)) {
        return {
          safe: false,
          reason: `Tool ${toolName} attempted to touch a protected path: ${v}`,
          severity: "critical",
        };
      }
    }

    if (toolName === "stageFiles" && Array.isArray(args.files)) {
      for (const f of args.files) {
        if (
          typeof f !== "string" ||
          isProtectedPath(f, this.pathOptions) ||
          f === "." ||
          f === "-A" ||
          f.startsWith("-")
        ) {
          return {
            safe: false,
            reason: `stageFiles rejected entry: ${String(f)}`,
            severity: "high",
          };
        }
      }
    }

    return { safe: true };
  }

  /** Check if a proposed change is safe to apply. */
  async checkChange(change: ProposedChange): Promise<SafetyCheckResult> {
    if (isProtectedPath(change.filePath, this.pathOptions)) {
      return {
        safe: false,
        reason: `Cannot modify protected file: ${change.filePath}`,
        severity: "critical",
      };
    }

    if (change.content && this.containsHarmfulPattern(change.content)) {
      return {
        safe: false,
        reason: "Content contains potentially harmful patterns",
        severity: "high",
      };
    }

    if (change.content && this.containsSecretShape(change.content)) {
      return {
        safe: false,
        reason: "Content matches a known secret shape (token / private key)",
        severity: "critical",
      };
    }

    return { safe: true };
  }

  /**
   * Validate an issue body for auto-fix eligibility. This is a secondary
   * content filter; the real trust gate is a maintainer-applied label
   * enforced at the workflow level.
   */
  validateIssueForAutoFix(title: string, body: string): SafetyCheckResult {
    const combined = `${title}\n${body}`;

    if (this.containsHarmfulPattern(combined)) {
      return {
        safe: false,
        reason: "Issue contains potentially harmful request patterns",
      };
    }

    if (this.containsSecretShape(combined)) {
      return {
        safe: false,
        reason: "Issue body contains what looks like a credential",
      };
    }

    return { safe: true };
  }

  /**
   * Scan model-authored text that is about to be persisted to a public
   * surface (PR title, PR body, commit message, branch name). These strings
   * hit shell positions and end up in the commit log forever, so the bar is
   * high: no shell metacharacters, no secret shapes, no harmful patterns.
   * Branch names are further restricted to `[A-Za-z0-9._/-]`, no leading dash.
   */
  checkPRMetadata(parts: {
    title?: string;
    body?: string;
    commitMessage?: string;
    branchName?: string;
  }): SafetyCheckResult {
    const fields: Array<[string, string | undefined]> = [
      ["title", parts.title],
      ["body", parts.body],
      ["commitMessage", parts.commitMessage],
      ["branchName", parts.branchName],
    ];

    for (const [name, value] of fields) {
      if (!value) continue;

      if (name === "branchName") {
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(value)) {
          return {
            safe: false,
            reason: `Branch name has disallowed characters: ${value}`,
            severity: "high",
          };
        }
        continue;
      }

      if (this.containsShellInjection(value)) {
        return {
          safe: false,
          reason: `${name} contains shell metacharacters`,
          severity: "high",
        };
      }

      if (this.containsSecretShape(value)) {
        return {
          safe: false,
          reason: `${name} contains what looks like a credential`,
          severity: "critical",
        };
      }

      if (this.containsHarmfulPattern(value)) {
        return {
          safe: false,
          reason: `${name} contains a harmful pattern`,
          severity: "high",
        };
      }
    }

    return { safe: true };
  }

  private containsHarmfulPattern(content: string): boolean {
    return this.harmful.some((p) => p.test(content));
  }

  private containsSecretShape(content: string): boolean {
    return this.secrets.some((p) => p.test(content));
  }

  private containsShellInjection(content: string): boolean {
    return this.shell.some((p) => p.test(content));
  }
}
