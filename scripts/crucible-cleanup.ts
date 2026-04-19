#!/usr/bin/env bun

/**
 * Crucible cleanup CLI.
 *
 * Reverts Crucible agent work for a given repo while preserving the repo itself
 * and its GitHub issues. Closes PRs, deletes crucible branches (remote + local),
 * removes worktrees under `.crucible-worktrees/`, clears `.crucible/progress/`
 * contents, wipes the SQLite run records + NDJSON event logs for the repo,
 * resets `.crucible/feature-list.json` `passes` flags, and asks the running
 * Crucible server to drop in-memory runs.
 *
 * Safe to re-run; every step is idempotent and tolerates "already gone".
 */

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = Path.dirname(fileURLToPath(import.meta.url));
const MONO_ROOT = Path.resolve(SCRIPT_DIR, "..");
const CRUCIBLE_DB_PATH = Path.join(MONO_ROOT, ".crucible-data", "crucible.db");
const CRUCIBLE_LOG_DIR = Path.join(MONO_ROOT, "repos", ".crucible-logs");

interface Args {
  readonly repo: string;
  readonly repoPath: string;
  readonly dryRun: boolean;
}

interface CliFlags {
  readonly repo?: string;
  readonly "repo-path"?: string;
  readonly "dry-run"?: boolean;
  readonly "keep-issues"?: boolean;
  readonly help?: boolean;
}

function printUsage(): void {
  console.log(
    [
      "Usage: bun scripts/crucible-cleanup.ts --repo <owner/name> [options]",
      "",
      "Reverts Crucible agent work for a repo while keeping the repo itself",
      "and its GitHub issues intact.",
      "",
      "Options:",
      "  --repo <owner/name>   Target repo (required).",
      "  --repo-path <path>    Absolute path to the cloned repo on disk.",
      "                        Auto-detected from the Crucible workspace when omitted.",
      "  --dry-run             Print each action without executing.",
      "  --keep-issues         No-op. Issues are always kept.",
      "  --help, -h            Show this message.",
      "",
      "Steps:",
      "  1. gh pr close --delete-branch for every open PR whose branch starts with 'crucible/'.",
      "  2. git push origin --delete for any remaining 'crucible/*' remote refs.",
      "  3. git worktree remove --force for every worktree under '.crucible-worktrees/'.",
      "     Then rm -rf '.crucible-worktrees/'.",
      "  4. git branch -D for every local 'crucible/*' branch.",
      "  5. rm -rf '.crucible/progress/*' (keeps agents.md, init.sh, config.json, etc.).",
      "  6. Clear persisted run records (SQLite 'crucible_runs' + NDJSON event logs).",
      "     Uses DELETE /api/crucible/runs when the Crucible server is running; otherwise",
      "     opens '.crucible-data/crucible.db' directly with bun:sqlite.",
      "  7. Reset every '.crucible/feature-list.json' feature's 'passes' flag to false.",
    ].join("\n"),
  );
}

function parseFlags(): CliFlags {
  const parsed = parseArgs({
    options: {
      repo: { type: "string" },
      "repo-path": { type: "string" },
      "dry-run": { type: "boolean" },
      "keep-issues": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  return parsed.values as CliFlags;
}

async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    const stats = await stat(absolutePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function parseOwnerNameFromRemote(remoteUrl: string): string | null {
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  const sshMatch = remoteUrl.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  return null;
}

function gitRemoteOrigin(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

async function findRepoPath(repo: string): Promise<string | null> {
  // Search candidate workspace roots for a git repo whose origin matches `repo`.
  const candidateRoots = new Set<string>();
  candidateRoots.add(MONO_ROOT);
  candidateRoots.add(Path.dirname(MONO_ROOT));
  candidateRoots.add(process.cwd());

  for (const root of candidateRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const candidate = Path.join(root, entry.name);
        if (!(await isDirectory(Path.join(candidate, ".git")))) continue;
        const remote = gitRemoteOrigin(candidate);
        const ownerName = remote ? parseOwnerNameFromRemote(remote) : null;
        if (ownerName === repo) {
          return candidate;
        }
      }
    } catch {
      // Ignore unreadable roots.
    }
  }
  return null;
}

async function resolveArgs(): Promise<Args | null> {
  const flags = parseFlags();
  if (flags.help) {
    printUsage();
    return null;
  }

  const repo = flags.repo?.trim();
  if (!repo) {
    printUsage();
    console.error("\nError: --repo <owner/name> is required.");
    process.exitCode = 1;
    return null;
  }

  let repoPath: string;
  if (flags["repo-path"]) {
    repoPath = Path.resolve(flags["repo-path"].trim());
  } else {
    const detected = await findRepoPath(repo);
    if (!detected) {
      console.error(
        `Error: could not auto-detect repo path for '${repo}'. Pass --repo-path <absolute-path>.`,
      );
      process.exitCode = 1;
      return null;
    }
    repoPath = detected;
  }

  if (!(await isDirectory(Path.join(repoPath, ".git")))) {
    console.error(`Error: '${repoPath}' is not a git repository (no .git directory).`);
    process.exitCode = 1;
    return null;
  }

  return {
    repo,
    repoPath,
    dryRun: flags["dry-run"] === true,
  };
}

function runGit(args: string[], cwd: string, timeoutMs = 60_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

function tryRunGit(args: string[], cwd: string, timeoutMs = 60_000): { ok: boolean; out: string } {
  try {
    return { ok: true, out: runGit(args, cwd, timeoutMs) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, out: message };
  }
}

function dryPrefix(dryRun: boolean): string {
  return dryRun ? "[dry-run] would: " : "";
}

// ---------------------------------------------------------------------------
// Step a) Close open Crucible PRs
// ---------------------------------------------------------------------------

interface PrEntry {
  number: number;
  title: string;
  headRefName: string;
}

async function closeCruciblePrs(args: Args): Promise<{ closed: number; closedBranches: string[] }> {
  console.log("\n[1/7] Closing Crucible PRs");

  let stdout: string;
  try {
    stdout = execFileSync(
      "gh",
      ["pr", "list", "--repo", args.repo, "--state", "open", "--json", "number,title,headRefName"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Skipped (gh pr list failed): ${message.split("\n")[0]}`);
    return { closed: 0, closedBranches: [] };
  }

  let prs: PrEntry[];
  try {
    prs = JSON.parse(stdout) as PrEntry[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Skipped (could not parse gh output): ${message}`);
    return { closed: 0, closedBranches: [] };
  }

  const cruciblePrs = prs.filter((pr) => pr.headRefName.startsWith("crucible/"));
  if (cruciblePrs.length === 0) {
    console.log("  No open Crucible PRs.");
    return { closed: 0, closedBranches: [] };
  }

  let closed = 0;
  const closedBranches: string[] = [];
  for (const pr of cruciblePrs) {
    console.log(
      `  ${dryPrefix(args.dryRun)}close PR #${pr.number} "${pr.title}" (branch: ${pr.headRefName})`,
    );
    if (args.dryRun) {
      closed++;
      closedBranches.push(pr.headRefName);
      continue;
    }
    try {
      execFileSync(
        "gh",
        ["pr", "close", String(pr.number), "--repo", args.repo, "--delete-branch"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      );
      closed++;
      closedBranches.push(pr.headRefName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`    Failed: ${message.split("\n")[0]}`);
    }
  }

  return { closed, closedBranches };
}

// ---------------------------------------------------------------------------
// Step b) Delete leftover remote crucible branches
// ---------------------------------------------------------------------------

async function deleteRemoteCrucibleBranches(
  args: Args,
  alreadyDeleted: ReadonlySet<string>,
): Promise<number> {
  console.log("\n[2/7] Deleting remote crucible/* branches");

  const lsRemote = tryRunGit(["ls-remote", "--heads", "origin"], args.repoPath, 30_000);
  if (!lsRemote.ok) {
    console.warn(`  Skipped (git ls-remote failed): ${lsRemote.out.split("\n")[0]}`);
    return 0;
  }

  const branches = lsRemote.out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // "<sha>\trefs/heads/<branch>"
      const parts = line.split(/\s+/);
      const ref = parts[1] ?? "";
      return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    })
    .filter((branch): branch is string => branch !== null && branch.startsWith("crucible/"))
    .filter((branch) => !alreadyDeleted.has(branch));

  if (branches.length === 0) {
    console.log("  No leftover remote crucible branches.");
    return 0;
  }

  let deleted = 0;
  for (const branch of branches) {
    console.log(`  ${dryPrefix(args.dryRun)}git push origin --delete ${branch}`);
    if (args.dryRun) {
      deleted++;
      continue;
    }
    const result = tryRunGit(["push", "origin", "--delete", branch], args.repoPath, 30_000);
    if (result.ok) {
      deleted++;
    } else {
      console.warn(`    Failed: ${result.out.split("\n")[0]}`);
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Step c) Remove local git worktrees under .crucible-worktrees/
// ---------------------------------------------------------------------------

async function removeWorktrees(args: Args): Promise<number> {
  console.log("\n[3/7] Removing .crucible-worktrees/");
  const worktreesDir = Path.join(args.repoPath, ".crucible-worktrees");
  if (!(await pathExists(worktreesDir))) {
    console.log("  No .crucible-worktrees/ directory.");
    return 0;
  }

  const list = tryRunGit(["worktree", "list", "--porcelain"], args.repoPath);
  if (!list.ok) {
    console.warn(`  git worktree list failed: ${list.out.split("\n")[0]}`);
  }

  const worktreePaths: string[] = [];
  if (list.ok) {
    for (const line of list.out.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length).trim();
      if (path.startsWith(worktreesDir + Path.sep) || path === worktreesDir) {
        worktreePaths.push(path);
      }
    }
  }

  let removed = 0;
  for (const worktreePath of worktreePaths) {
    console.log(`  ${dryPrefix(args.dryRun)}git worktree remove --force ${worktreePath}`);
    if (args.dryRun) {
      removed++;
      continue;
    }
    const result = tryRunGit(["worktree", "remove", worktreePath, "--force"], args.repoPath);
    if (result.ok) {
      removed++;
    } else {
      console.warn(`    Failed: ${result.out.split("\n")[0]}`);
    }
  }

  console.log(`  ${dryPrefix(args.dryRun)}rm -rf ${worktreesDir}`);
  if (!args.dryRun) {
    try {
      await rm(worktreesDir, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`    Failed to rm -rf ${worktreesDir}: ${message}`);
    }
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Step d) Delete local crucible branches
// ---------------------------------------------------------------------------

async function deleteLocalCrucibleBranches(args: Args): Promise<number> {
  console.log("\n[4/7] Deleting local crucible/* branches");
  const list = tryRunGit(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/crucible/"],
    args.repoPath,
  );
  if (!list.ok) {
    console.warn(`  Skipped (for-each-ref failed): ${list.out.split("\n")[0]}`);
    return 0;
  }

  const branches = list.out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (branches.length === 0) {
    console.log("  No local crucible branches.");
    return 0;
  }

  let deleted = 0;
  for (const branch of branches) {
    console.log(`  ${dryPrefix(args.dryRun)}git branch -D ${branch}`);
    if (args.dryRun) {
      deleted++;
      continue;
    }
    const result = tryRunGit(["branch", "-D", branch], args.repoPath);
    if (result.ok) {
      deleted++;
    } else {
      console.warn(`    Failed: ${result.out.split("\n")[0]}`);
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Step e) Clear .crucible/progress/*
// ---------------------------------------------------------------------------

async function clearProgressFiles(args: Args): Promise<number> {
  console.log("\n[5/7] Clearing .crucible/progress/");
  const progressDir = Path.join(args.repoPath, ".crucible", "progress");
  if (!(await pathExists(progressDir))) {
    console.log("  No .crucible/progress/ directory.");
    return 0;
  }

  let entries: string[];
  try {
    entries = await readdir(progressDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Failed to read ${progressDir}: ${message}`);
    return 0;
  }

  if (entries.length === 0) {
    console.log("  Already empty.");
    return 0;
  }

  console.log(`  ${dryPrefix(args.dryRun)}remove ${entries.length} entry(s) under ${progressDir}`);
  if (args.dryRun) {
    return entries.length;
  }

  let removed = 0;
  for (const entry of entries) {
    const target = Path.join(progressDir, entry);
    try {
      await rm(target, { recursive: true, force: true });
      removed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`    Failed to remove ${target}: ${message}`);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Step f) Clear persisted run state (SQLite + NDJSON logs) and in-memory runs
// ---------------------------------------------------------------------------

async function readJsonIfExists(filePath: string): Promise<{ readonly origin?: string } | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { readonly origin?: unknown };
    if (typeof parsed.origin === "string" && parsed.origin.trim().length > 0) {
      return { origin: parsed.origin.trim() };
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function probeOrigin(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/crucible/config`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveServerOrigin(): Promise<string | null> {
  const explicit = process.env.T3CODE_SERVER_ORIGIN?.trim();
  if (explicit) return explicit;

  const baseDir = process.env.T3CODE_HOME?.trim();
  const candidates = [...(baseDir ? [baseDir] : []), Path.join(OS.homedir(), ".t3")];

  for (const root of candidates) {
    for (const candidate of [
      Path.join(root, "dev", "server-runtime.json"),
      Path.join(root, "userdata", "server-runtime.json"),
    ]) {
      const state = await readJsonIfExists(candidate);
      if (state?.origin) {
        return state.origin;
      }
    }
  }

  // Fallback: probe common localhost ports. The dev server defaults to 13773
  // but some users run on 3000/8080 etc. If a Crucible server answers the
  // config probe, use it.
  const fallbackOrigins = [
    "http://127.0.0.1:13773",
    "http://localhost:13773",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ];
  for (const origin of fallbackOrigins) {
    if (await probeOrigin(origin)) {
      return origin;
    }
  }

  return null;
}

/**
 * Opens the Crucible SQLite DB read-only and returns every run ID that belongs
 * to `repo`, including children reachable transitively through `child_run_ids`.
 * Returns an empty array if the DB does not exist or cannot be opened.
 */
function dbExists(): boolean {
  try {
    return Bun.file(CRUCIBLE_DB_PATH).size > 0;
  } catch {
    return false;
  }
}

function collectPersistedRunIds(repo: string): string[] {
  if (!dbExists()) return [];

  let db: Database;
  try {
    db = new Database(CRUCIBLE_DB_PATH, { readonly: true });
  } catch {
    return [];
  }

  try {
    const direct = db
      .query<{ id: string }, { $repo: string }>("SELECT id FROM crucible_runs WHERE repo = $repo")
      .all({ $repo: repo })
      .map((row) => row.id);

    const all = new Set(direct);
    const queue = [...direct];
    const childQuery = db.query<{ child_run_ids: string }, { $id: string }>(
      "SELECT child_run_ids FROM crucible_runs WHERE id = $id",
    );

    while (queue.length > 0) {
      const parentId = queue.pop()!;
      const row = childQuery.get({ $id: parentId });
      if (!row) continue;
      let childIds: string[];
      try {
        childIds = JSON.parse(row.child_run_ids) as string[];
      } catch {
        continue;
      }
      for (const childId of childIds) {
        if (!all.has(childId)) {
          all.add(childId);
          queue.push(childId);
        }
      }
    }

    return [...all];
  } finally {
    db.close();
  }
}

function deleteSqliteRunsDirect(ids: ReadonlyArray<string>): number {
  if (ids.length === 0) return 0;
  let db: Database;
  try {
    db = new Database(CRUCIBLE_DB_PATH);
  } catch {
    return 0;
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    const stmt = db.prepare("DELETE FROM crucible_runs WHERE id = $id");
    let deleted = 0;
    const txn = db.transaction((batch: ReadonlyArray<string>) => {
      for (const id of batch) {
        const result = stmt.run({ $id: id });
        deleted += typeof result.changes === "number" ? result.changes : 0;
      }
    });
    txn(ids);
    return deleted;
  } finally {
    db.close();
  }
}

async function deleteNdjsonLogs(ids: ReadonlyArray<string>, dryRun: boolean): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    const logPath = Path.join(CRUCIBLE_LOG_DIR, `${id}.ndjson`);
    if (!(await pathExists(logPath))) continue;
    console.log(`    ${dryPrefix(dryRun)}rm ${logPath}`);
    if (dryRun) {
      removed++;
      continue;
    }
    try {
      await unlink(logPath);
      removed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`      Failed: ${message}`);
    }
  }
  return removed;
}

interface ClearPersistedResult {
  readonly runsCleared: number;
  readonly logsCleared: number;
  readonly viaServer: boolean;
}

async function clearPersistedRuns(args: Args): Promise<ClearPersistedResult> {
  console.log("\n[6/7] Clearing persisted runs (SQLite + NDJSON logs)");

  // Enumerate affected run IDs from SQLite first so we know which NDJSON logs
  // to delete regardless of which path (server vs direct) handles the DB.
  const ids = collectPersistedRunIds(args.repo);
  console.log(
    `  Found ${ids.length} persisted run(s) for '${args.repo}'${ids.length > 0 ? " (incl. transitive children)" : ""}.`,
  );

  const origin = await resolveServerOrigin();
  const token = process.env.T3CODE_BEARER_TOKEN?.trim();
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  let runsCleared = 0;
  let viaServer = false;

  if (origin) {
    const url = `${origin}/api/crucible/runs?repo=${encodeURIComponent(args.repo)}`;
    console.log(`  ${dryPrefix(args.dryRun)}DELETE ${url}`);
    if (args.dryRun) {
      runsCleared = ids.length;
      viaServer = true;
    } else {
      try {
        const response = await fetch(url, { method: "DELETE", headers });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          console.warn(`    Failed with status ${response.status}: ${text}`);
        } else {
          const data = (await response.json()) as { deleted?: number };
          runsCleared = typeof data.deleted === "number" ? data.deleted : 0;
          viaServer = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`    Request failed: ${message}`);
      }
    }
  } else {
    console.log("  Server not running; falling back to direct SQLite write.");
  }

  // If the server didn't handle it (down, failed, or no runtime state), delete
  // sqlite rows directly. When the server DID handle it, do a belt-and-suspenders
  // sweep for any rows still matching `repo` (guards against partial failures).
  const residualIds = args.dryRun ? [] : collectPersistedRunIds(args.repo);
  const idsToDelete = viaServer ? residualIds : ids;
  if (idsToDelete.length > 0) {
    const label = viaServer ? "residual SQLite row(s)" : `SQLite row(s) from ${CRUCIBLE_DB_PATH}`;
    console.log(`  ${dryPrefix(args.dryRun)}direct SQLite DELETE ${idsToDelete.length} ${label}`);
    if (!args.dryRun) {
      try {
        const deleted = deleteSqliteRunsDirect(idsToDelete);
        if (!viaServer) {
          runsCleared = deleted;
        } else if (deleted > 0) {
          console.log(`    Swept ${deleted} residual row(s) the server missed.`);
          runsCleared += deleted;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`    Direct SQLite delete failed: ${message}`);
      }
    } else if (!viaServer) {
      runsCleared = idsToDelete.length;
    }
  }

  // Delete per-run NDJSON event logs. The server never removes these itself.
  const logsCleared = ids.length > 0 ? await deleteNdjsonLogs(ids, args.dryRun) : 0;

  return { runsCleared, logsCleared, viaServer };
}

// ---------------------------------------------------------------------------
// Step g) Reset feature-list.json passes
// ---------------------------------------------------------------------------

interface FeatureListFile {
  readonly version?: number;
  readonly repo?: string;
  readonly generatedAt?: string;
  readonly features?: ReadonlyArray<{
    readonly id?: string;
    readonly source?: string;
    readonly title?: string;
    readonly description?: string;
    passes?: boolean;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

async function resetFeatureList(args: Args): Promise<boolean> {
  console.log("\n[7/7] Resetting .crucible/feature-list.json");
  const filePath = Path.join(args.repoPath, ".crucible", "feature-list.json");
  if (!(await pathExists(filePath))) {
    console.log("  No feature-list.json.");
    return false;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Failed to read ${filePath}: ${message}`);
    return false;
  }

  let parsed: FeatureListFile;
  try {
    parsed = JSON.parse(raw) as FeatureListFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  Failed to parse ${filePath}: ${message}`);
    return false;
  }

  const features = Array.isArray(parsed.features) ? parsed.features : [];
  const resetFeatures = features.map((feature) => {
    const copy = Object.assign({}, feature);
    copy.passes = false;
    return copy;
  });
  const next: FeatureListFile = Object.assign({}, parsed, { features: resetFeatures });

  console.log(
    `  ${dryPrefix(args.dryRun)}set passes=false on ${resetFeatures.length} feature(s) in ${filePath}`,
  );
  if (args.dryRun) {
    return true;
  }

  try {
    await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`    Failed to write ${filePath}: ${message}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = await resolveArgs();
  if (!args) return;

  console.log(
    `Crucible cleanup ${args.dryRun ? "(dry-run) " : ""}for repo '${args.repo}' at ${args.repoPath}`,
  );

  const { closed, closedBranches } = await closeCruciblePrs(args);
  const remoteDeleted = await deleteRemoteCrucibleBranches(args, new Set(closedBranches));
  const worktreesRemoved = await removeWorktrees(args);
  const localDeleted = await deleteLocalCrucibleBranches(args);
  const progressCleared = await clearProgressFiles(args);
  const persisted = await clearPersistedRuns(args);
  await resetFeatureList(args);

  const branchesDeleted = closed + remoteDeleted + localDeleted;

  console.log(
    [
      "",
      `Cleanup complete${args.dryRun ? " (dry-run)" : ""}:`,
      `  ${closed} PR(s) closed,`,
      `  ${branchesDeleted} branch(es) deleted,`,
      `  ${worktreesRemoved} worktree(s) removed,`,
      `  ${progressCleared} progress file(s) cleared,`,
      `  ${persisted.runsCleared} run(s) cleared (${persisted.viaServer ? "via server" : "direct SQLite"}),`,
      `  ${persisted.logsCleared} NDJSON event log(s) removed`,
      args.dryRun ? "  (no changes were made)" : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
