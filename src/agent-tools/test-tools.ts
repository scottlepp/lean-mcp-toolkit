import { tool } from "ai";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveSafePath, type SafePathOptions } from "../agent-safety/safe-path.js";

const execFileAsync = promisify(execFile);

/**
 * Tools for running tests / build / lint.
 *
 * SECURITY: each tool runs a single fixed `npm` subcommand with an explicit
 * argv array. The model can choose `runTests`, `runTypeCheck`, `runLint`, or
 * `installDependencies` — but cannot pass arbitrary commands. There is no
 * `executeCommand` / `shell` escape hatch by design.
 *
 * `runLint` will surface "script not found" as a tool failure if the host
 * repo has no `lint` script — the model sees the error and moves on rather
 * than crashing the agent loop.
 */
export interface CreateTestToolsOptions {
  safePathOptions?: SafePathOptions;
  /** Timeout for `runTests` in ms. Default 300_000. */
  testsTimeoutMs?: number;
  /** Timeout for `runTypeCheck` and `runLint` in ms. Default 120_000. */
  buildTimeoutMs?: number;
  /** Timeout for `installDependencies` (npm ci) in ms. Default 300_000. */
  installTimeoutMs?: number;
}

export function createTestTools(
  workingDir: string,
  options: CreateTestToolsOptions = {},
) {
  const safe = options.safePathOptions;
  const testsTimeout = options.testsTimeoutMs ?? 300_000;
  const buildTimeout = options.buildTimeoutMs ?? 120_000;
  const installTimeout = options.installTimeoutMs ?? 300_000;

  async function npm(
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("npm", args, { cwd: workingDir, timeout: timeoutMs });
  }

  return {
    runTests: tool({
      description: "Run the project test suite",
      inputSchema: z.object({
        testFile: z
          .string()
          .optional()
          .describe("Specific test file to run (path relative to working directory)"),
        coverage: z.boolean().default(false).describe("Run with coverage"),
      }),
      execute: async ({
        testFile,
        coverage,
      }: {
        testFile?: string;
        coverage: boolean;
      }) => {
        const args: string[] = coverage ? ["run", "test:coverage"] : ["test"];
        if (testFile) {
          const decision = resolveSafePath(workingDir, testFile, safe);
          if (!decision.safe) {
            return { success: false, error: decision.reason };
          }
          args.push("--", testFile);
        }
        try {
          const { stdout, stderr } = await npm(args, testsTimeout);
          return { success: true, output: stdout, stderr };
        } catch (error: unknown) {
          const e = error as { stdout?: string; stderr?: string; message?: string };
          return {
            success: false,
            error: `Tests failed: ${e.message || "Unknown error"}`,
            output: e.stdout || "",
            stderr: e.stderr || "",
          };
        }
      },
    }),

    runTypeCheck: tool({
      description: "Run TypeScript type checking",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { stdout, stderr } = await npm(
            ["run", "build", "--", "--noEmit"],
            buildTimeout,
          );
          return { success: true, output: stdout, stderr };
        } catch (error: unknown) {
          const e = error as { stdout?: string; stderr?: string; message?: string };
          return {
            success: false,
            error: `Type check failed: ${e.message || "Unknown error"}`,
            output: e.stdout || "",
            stderr: e.stderr || "",
          };
        }
      },
    }),

    runLint: tool({
      description:
        "Run linter on the codebase (returns failure if the host repo has no `lint` script)",
      inputSchema: z.object({
        fix: z.boolean().default(false).describe("Auto-fix issues"),
      }),
      execute: async ({ fix }: { fix: boolean }) => {
        const args = ["run", "lint"];
        if (fix) args.push("--", "--fix");
        try {
          const { stdout, stderr } = await npm(args, buildTimeout);
          return { success: true, output: stdout, stderr };
        } catch (error: unknown) {
          const e = error as { stdout?: string; stderr?: string; message?: string };
          return {
            success: false,
            error: `Lint failed: ${e.message || "Unknown error"}`,
            output: e.stdout || "",
            stderr: e.stderr || "",
          };
        }
      },
    }),

    installDependencies: tool({
      description:
        "Install npm dependencies from package-lock.json (uses npm ci, never npm install)",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const { stdout, stderr } = await npm(["ci"], installTimeout);
          return { success: true, output: stdout, stderr };
        } catch (error: unknown) {
          const e = error as { stdout?: string; stderr?: string; message?: string };
          return {
            success: false,
            error: `Install failed: ${e.message || "Unknown error"}`,
            output: e.stdout || "",
            stderr: e.stderr || "",
          };
        }
      },
    }),
  };
}
