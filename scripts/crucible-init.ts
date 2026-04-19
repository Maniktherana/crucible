#!/usr/bin/env bun
/**
 * crucible-init - copy `.crucible-template/` into a target repository.
 *
 * What it does:
 *   1. Resolves the target directory (defaults to the current working dir).
 *   2. Copies the entire `.crucible-template/` tree into `<target>/.crucible/`.
 *   3. Rewrites `config.json` placeholders (`{{PROJECT_NAME}}`, `{{REPO_OWNER}}`,
 *      `{{REPO_NAME}}`, `{{REMOTE_URL}}`) by inspecting the target repo's git
 *      remote (falls back to sensible defaults when unavailable).
 *   4. `chmod +x` the installed `init.sh`.
 *
 * Idempotency:
 *   - Running twice with the same arguments is safe.
 *   - Existing files are left untouched unless `--force` is passed.
 *   - A special case: `config.json` whose placeholders have already been
 *     substituted is never rewritten (even with `--force` the user's edits
 *     are preserved unless the file is missing or still a raw template).
 *
 * Usage:
 *   bun scripts/crucible-init.ts [--target <dir>] [--template <dir>] [--force]
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile, chmod } from "node:fs/promises";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CliOptions {
  readonly target: string;
  readonly templateDir: string;
  readonly force: boolean;
}

interface RemoteMetadata {
  readonly remoteUrl: string;
  readonly owner: string;
  readonly name: string;
  readonly projectName: string;
}

const TEMPLATE_PLACEHOLDERS = [
  "{{PROJECT_NAME}}",
  "{{REPO_OWNER}}",
  "{{REPO_NAME}}",
  "{{REMOTE_URL}}",
];

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  bun scripts/crucible-init.ts [--target <dir>] [--template <dir>] [--force]",
      "",
      "Options:",
      "  --target <dir>     Repository to initialise (default: cwd).",
      "  --template <dir>   Template source (default: repo's .crucible-template).",
      "  --force            Overwrite existing files (config.json user edits",
      "                     are still preserved if placeholders are gone).",
      "  -h, --help         Print this help text.",
    ].join("\n"),
  );
}

function defaultTemplateDir(): string {
  const scriptPath = fileURLToPath(import.meta.url);
  // scripts/crucible-init.ts -> repo-root/.crucible-template
  return Path.resolve(Path.dirname(scriptPath), "..", ".crucible-template");
}

function parseCli(): CliOptions {
  const argv = parseArgs({
    options: {
      target: { type: "string" },
      template: { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (argv.values.help) {
    printUsage();
    process.exit(0);
  }

  const target = Path.resolve(argv.values.target?.trim() || process.cwd());
  const templateDir = Path.resolve(argv.values.template?.trim() || defaultTemplateDir());
  const force = argv.values.force === true;

  return { target, templateDir, force };
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    const stats = await stat(absolutePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function parseGitRemoteUrl(raw: string): { owner: string; name: string } | null {
  const url = raw.trim();
  if (url.length === 0) return null;

  // SSH: git@github.com:owner/name(.git)
  const sshMatch = /^[^@\s]+@[^:\s]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  // HTTPS / git:// / ssh://
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length >= 2) {
      const owner = segments.at(-2)!;
      const rawName = segments.at(-1)!;
      const name = rawName.endsWith(".git") ? rawName.slice(0, -".git".length) : rawName;
      if (owner.length > 0 && name.length > 0) {
        return { owner, name };
      }
    }
  } catch {
    // Fall through.
  }

  return null;
}

async function resolveRemoteMetadata(target: string): Promise<RemoteMetadata> {
  const fallback: RemoteMetadata = {
    remoteUrl: "",
    owner: "unknown",
    name: Path.basename(target),
    projectName: Path.basename(target),
  };

  if (!(await isDirectory(Path.join(target, ".git")))) {
    return fallback;
  }

  let remoteUrl = "";
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: target,
    });
    remoteUrl = stdout.trim();
  } catch {
    return fallback;
  }

  const parsed = parseGitRemoteUrl(remoteUrl);
  if (!parsed) {
    return { ...fallback, remoteUrl };
  }

  return {
    remoteUrl,
    owner: parsed.owner,
    name: parsed.name,
    projectName: parsed.name,
  };
}

function renderConfigTemplate(template: string, metadata: RemoteMetadata): string {
  return template
    .replaceAll("{{PROJECT_NAME}}", metadata.projectName)
    .replaceAll("{{REPO_OWNER}}", metadata.owner)
    .replaceAll("{{REPO_NAME}}", metadata.name)
    .replaceAll("{{REMOTE_URL}}", metadata.remoteUrl);
}

function containsPlaceholders(contents: string): boolean {
  return TEMPLATE_PLACEHOLDERS.some((placeholder) => contents.includes(placeholder));
}

interface CopyStats {
  copied: number;
  skipped: number;
  renderedConfig: boolean;
}

async function copyTree(
  sourceDir: string,
  destinationDir: string,
  options: { force: boolean; isConfig: (absolute: string) => boolean },
  metadata: RemoteMetadata,
  stats: CopyStats,
): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = Path.join(sourceDir, entry.name);
    const destinationPath = Path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath, options, metadata, stats);
      continue;
    }

    if (!entry.isFile()) {
      // Ignore symlinks/sockets/etc - Crucible templates should never contain them.
      continue;
    }

    const exists = await pathExists(destinationPath);
    const isConfigJson = options.isConfig(sourcePath);

    if (isConfigJson) {
      await writeRenderedConfig({
        sourcePath,
        destinationPath,
        exists,
        force: options.force,
        metadata,
        stats,
      });
      continue;
    }

    if (exists && !options.force) {
      stats.skipped += 1;
      continue;
    }

    await copyFile(sourcePath, destinationPath);
    stats.copied += 1;
  }
}

interface WriteRenderedConfigArgs {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly exists: boolean;
  readonly force: boolean;
  readonly metadata: RemoteMetadata;
  readonly stats: CopyStats;
}

async function writeRenderedConfig(args: WriteRenderedConfigArgs): Promise<void> {
  const { sourcePath, destinationPath, exists, force, metadata, stats } = args;
  const template = await readFile(sourcePath, "utf8");
  const rendered = renderConfigTemplate(template, metadata);

  if (!exists) {
    await writeFile(destinationPath, rendered, "utf8");
    stats.copied += 1;
    stats.renderedConfig = true;
    return;
  }

  const existing = await readFile(destinationPath, "utf8");

  // User has already customised the config - never clobber their edits, even
  // with --force. The only exception is when the existing file still holds
  // raw placeholders, which means a previous run bailed out partway.
  if (!containsPlaceholders(existing)) {
    stats.skipped += 1;
    return;
  }

  if (!force && existing === template) {
    // Pre-substitution template identical to source - safe to re-render.
    await writeFile(destinationPath, rendered, "utf8");
    stats.copied += 1;
    stats.renderedConfig = true;
    return;
  }

  if (force) {
    await writeFile(destinationPath, rendered, "utf8");
    stats.copied += 1;
    stats.renderedConfig = true;
    return;
  }

  // Raw placeholder file present and no --force - replace it.
  await writeFile(destinationPath, rendered, "utf8");
  stats.copied += 1;
  stats.renderedConfig = true;
}

async function ensureExecutable(absolutePath: string): Promise<void> {
  if (!(await pathExists(absolutePath))) return;
  try {
    await chmod(absolutePath, 0o755);
  } catch (error) {
    // Non-fatal on platforms where chmod is a no-op (e.g. Windows).
    console.warn(`[crucible-init] chmod +x failed for ${absolutePath}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  const options = parseCli();

  if (!(await isDirectory(options.templateDir))) {
    throw new Error(
      `Template directory '${options.templateDir}' does not exist or is not a directory.`,
    );
  }
  if (!(await isDirectory(options.target))) {
    throw new Error(`Target directory '${options.target}' does not exist or is not a directory.`);
  }

  const metadata = await resolveRemoteMetadata(options.target);
  const destinationRoot = Path.join(options.target, ".crucible");
  const stats: CopyStats = { copied: 0, skipped: 0, renderedConfig: false };

  const configSource = Path.join(options.templateDir, "config.json");
  await copyTree(
    options.templateDir,
    destinationRoot,
    {
      force: options.force,
      isConfig: (absolute) => absolute === configSource,
    },
    metadata,
    stats,
  );

  await ensureExecutable(Path.join(destinationRoot, "init.sh"));

  console.log(
    `[crucible-init] target=${options.target} copied=${stats.copied} skipped=${stats.skipped} config=${
      stats.renderedConfig ? "rendered" : "preserved"
    } repo=${metadata.owner}/${metadata.name}`,
  );
}

main().catch((error) => {
  console.error(`[crucible-init] ${errorMessage(error)}`);
  process.exitCode = 1;
});
