// Generic skill installer. Writes a SKILL.md file under
// `~/.claude/skills/<slug>/SKILL.md` so the Claude Code harness loads
// it on demand when the user mentions the relevant domain.
//
// The skill content is server-specific (each consumer supplies its
// own SKILL.md body); the install plumbing is shared.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface InstallSkillOpts {
  // The SKILL.md body to write. Each server passes its own.
  content: string;
  // Slug used for the directory name under `~/.claude/skills/`.
  // E.g. "jira", "confluence", "bitbucket".
  slug: string;
  // Force overwrite if SKILL.md already exists. Without this, an
  // existing file aborts the install — protects users from
  // accidentally clobbering customizations.
  force?: boolean;
  // Print the rendered SKILL.md to stdout instead of writing it.
  // Useful for piping into another location, or inspecting before
  // installing.
  print?: boolean;
  // Override target dir. Production uses ~/.claude/skills/<slug>;
  // tests pass a tmpdir. Not exposed as a CLI flag — the CLI builds
  // the production path from os.homedir().
  targetDir?: string;
}

export interface InstallSkillResult {
  // Where the file was written (or would be written, in --print mode).
  // Always the resolved absolute path, with ~ expanded.
  path: string;
  // What action was taken: "wrote" (new file), "overwrote" (--force
  // replaced an existing file), "exists" (refused — file already
  // present and --force not set), or "printed" (--print dumped to
  // stdout, no file touched).
  action: "wrote" | "overwrote" | "exists" | "printed";
}

export async function installSkill(
  opts: InstallSkillOpts,
): Promise<InstallSkillResult> {
  const dir =
    opts.targetDir ?? path.join(os.homedir(), ".claude", "skills", opts.slug);
  const file = path.join(dir, "SKILL.md");

  if (opts.print) {
    return { path: file, action: "printed" };
  }

  let existed = false;
  try {
    await fs.access(file);
    existed = true;
  } catch {
    // Doesn't exist — that's the happy path.
  }

  if (existed && !opts.force) {
    return { path: file, action: "exists" };
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, opts.content, "utf8");

  return {
    path: file,
    action: existed ? "overwrote" : "wrote",
  };
}
