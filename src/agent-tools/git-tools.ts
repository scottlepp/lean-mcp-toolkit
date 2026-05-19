import { tool } from "ai";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  resolveSafePath,
  isProtectedPath,
  type SafePathOptions,
} from "../agent-safety/safe-path.js";
import {
  SafetyChecker,
  type SafetyCheckerOptions,
} from "../agent-safety/safety-checker.js";

const execFileAsync = promisify(execFile);

/**
 * Git tools for repository operations.
 *
 * SECURITY: every git invocation uses `execFile("git", [...])` — argv array,
 * no shell. Model-supplied strings (branch names, commit messages, file
 * paths) are NEVER concatenated into a command string. This is the only
 * shape that's robust against `$()`, backticks, semicolons, and similar
 * shell metacharacters appearing in attacker-controlled content.
 *
 * Branch names and commit messages are additionally validated by
 * `SafetyChecker.checkPRMetadata()` before being passed to git.
 */
export interface CreateGitToolsOptions {
  safePathOptions?: SafePathOptions;
  safetyCheckerOptions?: SafetyCheckerOptions;
  /** Inject a pre-built checker. If omitted, one is constructed from `safetyCheckerOptions`. */
  safetyChecker?: SafetyChecker;
}

export function createGitTools(
  workingDir: string,
  options: CreateGitToolsOptions = {},
) {
  const safe = options.safePathOptions;
  const safetyChecker =
    options.safetyChecker ?? new SafetyChecker(options.safetyCheckerOptions);

  async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, { cwd: workingDir });
  }

  return {
    getCurrentBranch: tool({
      description: "Get the name of the current git branch",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
          return { success: true, branch: stdout.trim() };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get current branch: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    createBranch: tool({
      description: "Create and checkout a new git branch",
      inputSchema: z.object({
        branchName: z.string().describe("Name of the new branch"),
        baseBranch: z.string().default("main").describe("Base branch to create from"),
      }),
      execute: async ({
        branchName,
        baseBranch,
      }: {
        branchName: string;
        baseBranch: string;
      }) => {
        const nameCheck = safetyChecker.checkPRMetadata({ branchName });
        if (!nameCheck.safe) {
          return { success: false, error: nameCheck.reason };
        }
        const baseCheck = safetyChecker.checkPRMetadata({ branchName: baseBranch });
        if (!baseCheck.safe) {
          return { success: false, error: `baseBranch: ${baseCheck.reason}` };
        }
        try {
          await git(["checkout", baseBranch]);
          await git(["pull", "origin", baseBranch]);
          await git(["checkout", "-b", branchName]);
          return { success: true, branch: branchName };
        } catch (error) {
          return {
            success: false,
            error: `Failed to create branch: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    stageFiles: tool({
      description:
        'Stage specific files for commit (no wildcards, no "."; pass each file explicitly)',
      inputSchema: z.object({
        files: z
          .array(z.string())
          .min(1)
          .describe('Explicit list of files to stage. Wildcards and "." are not accepted.'),
      }),
      execute: async ({ files }: { files: string[] }) => {
        const sanitized: string[] = [];
        for (const f of files) {
          if (typeof f !== "string" || f.length === 0) {
            return { success: false, error: `Invalid file entry: ${String(f)}` };
          }
          if (f === "." || f === "-A" || f === "--all" || f.startsWith("-")) {
            return { success: false, error: `Wildcard / flag entries are not permitted: ${f}` };
          }
          if (isProtectedPath(f, safe)) {
            return { success: false, error: `Refusing to stage protected path: ${f}` };
          }
          const decision = resolveSafePath(workingDir, f, safe);
          if (!decision.safe) {
            return { success: false, error: decision.reason };
          }
          sanitized.push(f);
        }
        try {
          await git(["add", "--", ...sanitized]);
          return { success: true, stagedFiles: sanitized };
        } catch (error) {
          return {
            success: false,
            error: `Failed to stage files: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    commit: tool({
      description: "Commit staged changes",
      inputSchema: z.object({
        message: z.string().min(1).max(2000).describe("Commit message"),
      }),
      execute: async ({ message }: { message: string }) => {
        const check = safetyChecker.checkPRMetadata({ commitMessage: message });
        if (!check.safe) {
          return { success: false, error: check.reason };
        }
        try {
          const { stdout } = await git(["commit", "-m", message]);
          return { success: true, message, output: stdout };
        } catch (error) {
          return {
            success: false,
            error: `Failed to commit: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    push: tool({
      description: "Push changes to remote repository",
      inputSchema: z.object({
        branch: z.string().describe("Branch to push"),
        setUpstream: z.boolean().default(true).describe("Set upstream tracking"),
      }),
      execute: async ({
        branch,
        setUpstream,
      }: {
        branch: string;
        setUpstream: boolean;
      }) => {
        const nameCheck = safetyChecker.checkPRMetadata({ branchName: branch });
        if (!nameCheck.safe) {
          return { success: false, error: nameCheck.reason };
        }
        try {
          const args = ["push"];
          if (setUpstream) args.push("-u");
          args.push("origin", branch);
          await git(args);
          return { success: true, branch };
        } catch (error) {
          return {
            success: false,
            error: `Failed to push: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    getStatus: tool({
      description: "Get git status showing changed files",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { stdout } = await git(["status", "--porcelain"]);
          const files = stdout
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => ({
              status: line.substring(0, 2).trim(),
              file: line.substring(3),
            }));
          return { success: true, files, hasChanges: files.length > 0 };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get status: ${error instanceof Error ? error.message : "Unknown error"}`,
            files: [],
          };
        }
      },
    }),

    getDiff: tool({
      description: "Get diff of changes",
      inputSchema: z.object({
        staged: z.boolean().default(false).describe("Show staged changes only"),
        file: z.string().optional().describe("Specific file to diff"),
      }),
      execute: async ({ staged, file }: { staged: boolean; file?: string }) => {
        const args = ["diff"];
        if (staged) args.push("--staged");
        if (file) {
          const decision = resolveSafePath(workingDir, file, safe);
          if (!decision.safe) {
            return { success: false, error: decision.reason };
          }
          args.push("--", file);
        }
        try {
          const { stdout } = await git(args);
          return { success: true, diff: stdout };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get diff: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),
  };
}
