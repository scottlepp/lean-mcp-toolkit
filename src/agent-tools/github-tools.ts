import { tool } from "ai";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { isProtectedPath, type SafePathOptions } from "../agent-safety/safe-path.js";
import {
  SafetyChecker,
  type SafetyCheckerOptions,
} from "../agent-safety/safety-checker.js";

/**
 * GitHub tools for interacting with the GitHub API.
 *
 * SECURITY: tools that publish model-authored text (PR title/body, review
 * body, issue comments) run that text through `SafetyChecker.checkPRMetadata`
 * first. Rejected calls return `{ success: false, error: ... }` so the model
 * sees the rejection and can retry with sanitized content.
 *
 * The toolkit does not reach into env vars. Callers pass the GitHub token
 * and, separately, whether auto-merge is permitted — agents must not be
 * able to flip auto-merge by editing their own workflow.
 */
export interface CreateGitHubToolsOptions {
  repoOwner: string;
  repoName: string;
  githubToken: string;
  /**
   * Allow the model to enable auto-merge after an APPROVE review. Defaults
   * to false. Set via your workflow harness, not via env-read inside the
   * toolkit.
   */
  allowAutoMerge?: boolean;
  /** Inject a pre-built Octokit (useful for tests). */
  octokit?: Octokit;
  safePathOptions?: SafePathOptions;
  safetyCheckerOptions?: SafetyCheckerOptions;
  safetyChecker?: SafetyChecker;
}

export function createGitHubTools(options: CreateGitHubToolsOptions) {
  const {
    repoOwner,
    repoName,
    githubToken,
    allowAutoMerge = false,
    safePathOptions,
    safetyCheckerOptions,
  } = options;
  const octokit = options.octokit ?? new Octokit({ auth: githubToken });
  const safetyChecker =
    options.safetyChecker ?? new SafetyChecker(safetyCheckerOptions);

  return {
    getIssues: tool({
      description: "Get issues from the repository",
      inputSchema: z.object({
        labels: z.array(z.string()).optional().describe("Filter by labels"),
        state: z.enum(["open", "closed", "all"]).default("open").describe("Issue state"),
        limit: z.number().default(10).describe("Maximum number of issues"),
      }),
      execute: async ({
        labels,
        state,
        limit,
      }: {
        labels?: string[];
        state: "open" | "closed" | "all";
        limit: number;
      }) => {
        try {
          const { data } = await octokit.issues.listForRepo({
            owner: repoOwner,
            repo: repoName,
            labels: labels?.join(","),
            state,
            per_page: limit,
          });

          const issues = data
            .filter((issue) => !issue.pull_request)
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
              createdAt: issue.created_at,
              author: issue.user?.login,
            }));

          return { success: true, issues, count: issues.length };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get issues: ${error instanceof Error ? error.message : "Unknown error"}`,
            issues: [],
          };
        }
      },
    }),

    getIssue: tool({
      description: "Get details of a specific issue",
      inputSchema: z.object({
        issueNumber: z.number().describe("Issue number"),
      }),
      execute: async ({ issueNumber }: { issueNumber: number }) => {
        try {
          const { data } = await octokit.issues.get({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
          });

          return {
            success: true,
            issue: {
              number: data.number,
              title: data.title,
              body: data.body,
              state: data.state,
              labels: data.labels.map((l) => (typeof l === "string" ? l : l.name)),
              createdAt: data.created_at,
              author: data.user?.login,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get issue: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    commentOnIssue: tool({
      description: "Add a comment to an issue",
      inputSchema: z.object({
        issueNumber: z.number().describe("Issue number"),
        body: z.string().describe("Comment body"),
      }),
      execute: async ({ issueNumber, body }: { issueNumber: number; body: string }) => {
        const check = safetyChecker.checkPRMetadata({ body });
        if (!check.safe) {
          return { success: false, error: `Comment rejected: ${check.reason}` };
        }
        try {
          const { data } = await octokit.issues.createComment({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
            body,
          });
          return { success: true, commentId: data.id, url: data.html_url };
        } catch (error) {
          return {
            success: false,
            error: `Failed to create comment: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    createPullRequest: tool({
      description: "Create a new pull request",
      inputSchema: z.object({
        title: z.string().describe("PR title"),
        body: z.string().describe("PR body/description"),
        head: z.string().describe("Branch containing changes"),
        base: z.string().default("main").describe("Base branch"),
      }),
      execute: async ({
        title,
        body,
        head,
        base,
      }: {
        title: string;
        body: string;
        head: string;
        base: string;
      }) => {
        const check = safetyChecker.checkPRMetadata({ title, body, branchName: head });
        if (!check.safe) {
          return { success: false, error: `PR rejected: ${check.reason}` };
        }
        const baseCheck = safetyChecker.checkPRMetadata({ branchName: base });
        if (!baseCheck.safe) {
          return { success: false, error: `Base branch rejected: ${baseCheck.reason}` };
        }
        try {
          const { data } = await octokit.pulls.create({
            owner: repoOwner,
            repo: repoName,
            title,
            body,
            head,
            base,
          });
          return {
            success: true,
            prNumber: data.number,
            url: data.html_url,
            title: data.title,
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to create PR: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    createReview: tool({
      description:
        "Submit a review on a pull request with optional inline comments. If approving, can also enable auto-merge (only when the harness allows it).",
      inputSchema: z.object({
        prNumber: z.number().describe("PR number"),
        body: z.string().describe("Review summary"),
        event: z
          .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
          .describe("Review action"),
        comments: z
          .array(
            z.object({
              path: z.string().describe("File path"),
              line: z.number().describe("Line number in the diff to comment on"),
              body: z.string().describe("Comment text"),
            }),
          )
          .optional()
          .describe("Optional inline comments on specific lines of code"),
        enableAutoMerge: z
          .boolean()
          .optional()
          .describe("Enable auto-merge after approval (only works with APPROVE event)"),
      }),
      execute: async ({
        prNumber,
        body,
        event,
        comments,
        enableAutoMerge,
      }: {
        prNumber: number;
        body: string;
        event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
        comments?: Array<{ path: string; line: number; body: string }>;
        enableAutoMerge?: boolean;
      }) => {
        const bodyCheck = safetyChecker.checkPRMetadata({ body });
        if (!bodyCheck.safe) {
          return { success: false, error: `Review body rejected: ${bodyCheck.reason}` };
        }
        for (const c of comments ?? []) {
          const ck = safetyChecker.checkPRMetadata({ body: c.body });
          if (!ck.safe) {
            return {
              success: false,
              error: `Inline comment rejected (${c.path}:${c.line}): ${ck.reason}`,
            };
          }
        }
        if (enableAutoMerge && !allowAutoMerge) {
          return {
            success: false,
            error:
              "Auto-merge is disabled by the harness (allowAutoMerge=false). The agent must not merge without human approval.",
          };
        }
        try {
          const { data } = await octokit.pulls.createReview({
            owner: repoOwner,
            repo: repoName,
            pull_number: prNumber,
            body,
            event,
            comments: comments?.map((c) => ({
              path: c.path,
              line: c.line,
              body: c.body,
            })),
          });

          let autoMergeEnabled = false;

          if (enableAutoMerge && event === "APPROVE") {
            try {
              const { data: pr } = await octokit.pulls.get({
                owner: repoOwner,
                repo: repoName,
                pull_number: prNumber,
              });

              await octokit.graphql(
                `
                mutation EnableAutoMerge($pullRequestId: ID!) {
                  enablePullRequestAutoMerge(input: {
                    pullRequestId: $pullRequestId,
                    mergeMethod: SQUASH
                  }) {
                    pullRequest {
                      autoMergeRequest {
                        enabledAt
                      }
                    }
                  }
                }
              `,
                { pullRequestId: pr.node_id },
              );
              autoMergeEnabled = true;
            } catch (autoMergeError) {
              console.warn("Failed to enable auto-merge:", autoMergeError);
            }
          }

          return {
            success: true,
            reviewId: data.id,
            state: data.state,
            commentsCount: comments?.length || 0,
            autoMergeEnabled,
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to create review: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),

    getFileContents: tool({
      description: "Get the contents of a file from the repository via GitHub API",
      inputSchema: z.object({
        path: z.string().describe("Path to the file in the repository"),
        ref: z.string().optional().describe("Branch, tag, or commit SHA"),
      }),
      execute: async ({ path: filePath, ref }: { path: string; ref?: string }) => {
        if (isProtectedPath(filePath, safePathOptions)) {
          return {
            success: false,
            error: `Refusing to fetch protected path from repo: ${filePath}`,
            path: filePath,
          };
        }
        try {
          const { data } = await octokit.repos.getContent({
            owner: repoOwner,
            repo: repoName,
            path: filePath,
            ref,
          });

          if (!("content" in data) || Array.isArray(data)) {
            return { success: false, error: `Path ${filePath} is not a file`, path: filePath };
          }

          const content = Buffer.from(data.content, "base64").toString("utf-8");

          return {
            success: true,
            content,
            path: filePath,
            sha: data.sha,
            size: data.size,
          };
        } catch (error) {
          return {
            success: false,
            error: `Failed to get file contents: ${error instanceof Error ? error.message : "Unknown error"}`,
            path: filePath,
          };
        }
      },
    }),
  };
}
