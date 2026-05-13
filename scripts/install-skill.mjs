#!/usr/bin/env node
// Install the bundled mcp-toolkit Claude Code skill to either
// ~/.claude/skills/mcp-toolkit/ (user-global, default) or
// ./.claude/skills/mcp-toolkit/ (project-local, with --project).
//
// Usage:
//   node scripts/install-skill.mjs [--project] [--force] [--dry-run] [--print]
//
// Pairs with the `install-skill` package.json script.

import { access, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SLUG = "mcp-toolkit";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(__dirname, "..", ".claude", "skills", SLUG);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const help = flag("help") || args.includes("-h");
const project = flag("project");
const force = flag("force");
const dryRun = flag("dry-run");
const print = flag("print");

const unknown = args.filter(
  (a) => !["--help", "-h", "--project", "--force", "--dry-run", "--print"].includes(a),
);
if (unknown.length > 0) {
  process.stderr.write(`install-skill: unknown flag(s): ${unknown.join(", ")}\n`);
  process.exit(2);
}

if (help) {
  process.stdout.write(
    [
      "install-skill — install the @scottlepper/mcp-toolkit Claude Code skill",
      "",
      "  Default target: ~/.claude/skills/mcp-toolkit/",
      "  --project      install to ./.claude/skills/mcp-toolkit/ in the cwd",
      "  --force        overwrite an existing skill directory",
      "  --dry-run      report what would be installed without writing",
      "  --print        dump all skill files to stdout instead of installing",
      "  --help, -h     this message",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

await ensureSourceExists();

if (print) {
  await printSkill();
  process.exit(0);
}

const baseDir = project
  ? resolve(process.cwd(), ".claude", "skills")
  : join(homedir(), ".claude", "skills");
const targetDir = join(baseDir, SLUG);

const existed = await pathExists(targetDir);
if (existed && !force) {
  process.stderr.write(
    `${targetDir} already exists. Use --force to overwrite, or --print to inspect without installing.\n`,
  );
  process.exit(1);
}

if (dryRun) {
  const files = await listSkillFiles();
  process.stdout.write(
    `Would ${existed ? "overwrite" : "install"} ${files.length} file(s) at ${targetDir}:\n`,
  );
  for (const f of files) process.stdout.write(`  ${f}\n`);
  process.exit(0);
}

if (existed) await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
await cp(SOURCE, targetDir, { recursive: true });

process.stdout.write(`${existed ? "Overwrote" : "Installed"} ${targetDir}\n`);

async function ensureSourceExists() {
  try {
    const s = await stat(SOURCE);
    if (!s.isDirectory()) throw new Error("not a directory");
  } catch {
    process.stderr.write(
      `install-skill: source skill directory missing at ${SOURCE}\n`,
    );
    process.exit(1);
  }
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function listSkillFiles(dir = SOURCE) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listSkillFiles(full)));
    } else {
      out.push(relative(SOURCE, full));
    }
  }
  return out.sort();
}

async function printSkill() {
  for (const rel of await listSkillFiles()) {
    const full = join(SOURCE, rel);
    const body = await readFile(full, "utf8");
    process.stdout.write(`===== ${rel} =====\n${body}\n`);
  }
}
