#!/usr/bin/env bun

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import {
  buildInitializerPrompt,
  type InitializerPromptParams,
} from "../apps/server/src/crucible/prompts.ts";

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = Path.dirname(fileURLToPath(import.meta.url));
void SCRIPTS_DIR;

type SpawnSubtaskOptions = {
  readonly prompt: string;
  readonly directory: string;
  readonly title?: string;
  readonly expectedFilePath?: string;
  readonly expectedText?: string;
  readonly parentRunId?: string;
  readonly origin?: string;
  readonly baseDir?: string;
  readonly token?: string;
  readonly repo?: string;
};

const argv = parseArgs({
  options: {
    prompt: { type: "string" },
    directory: { type: "string" },
    title: { type: "string" },
    "expected-file": { type: "string" },
    "expected-text": { type: "string" },
    "parent-run-id": { type: "string" },
    origin: { type: "string" },
    "base-dir": { type: "string" },
    token: { type: "string" },
    repo: { type: "string" },
    "repo-path": { type: "string" },
    initializer: { type: "boolean" },
    "no-worktree": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  spawn-subtask [--origin <url>] [--base-dir <path>] [--token <bearer>]",
      "                [--directory <dir>] [--title <title>]",
      "                [--expected-file <path>] [--expected-text <text>]",
      "                [--parent-run-id <id>] [--repo <owner/name>]",
      "                [--repo-path <absolute-path>]",
      "                [--initializer | --no-worktree]",
      "                <prompt...>",
      "",
      "By default, spawn-subtask creates a git worktree for the child agent:",
      "  <repo-path>/.crucible-worktrees/<uuid8>  on branch  crucible/task-<uuid8>",
      "This gives the child a full repo checkout on its own branch, so it can commit and open PRs.",
      "",
      "Flags:",
      "  --repo-path <path>   Parent repo on disk (defaults to cwd).",
      "  --initializer        Run the Crucible initializer agent on a fresh branch",
      "                       `crucible/init-<uuid8>`. --prompt is inferred from the",
      "                       canonical initializer template.",
      "  --no-worktree        Skip worktree creation; fall back to the legacy",
      "                       `.crucible-subtasks/<uuid8>` mkdir behaviour.",
      "  --directory <dir>    Pin the child directory explicitly (overrides all",
      "                       worktree logic).",
      "",
      "Environment:",
      "  T3CODE_SERVER_ORIGIN   Explicit Crucible server origin.",
      "  T3CODE_BEARER_TOKEN    Bearer token for authenticated Crucible requests.",
      "  T3CODE_HOME            Used to discover the local server-runtime.json file.",
      "  CRUCIBLE_PARENT_RUN_ID Fallback for --parent-run-id.",
      "  CRUCIBLE_REPO          Fallback for --repo.",
    ].join("\n"),
  );
}

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
    throw error;
  }
}

async function resolveOrigin(options: SpawnSubtaskOptions): Promise<string> {
  const explicitOrigin = options.origin?.trim() || process.env.T3CODE_SERVER_ORIGIN?.trim();
  if (explicitOrigin) {
    return explicitOrigin;
  }

  const baseDir = options.baseDir?.trim() || process.env.T3CODE_HOME?.trim();
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

  throw new Error(
    "Unable to resolve the Crucible server origin. Pass --origin or set T3CODE_SERVER_ORIGIN/T3CODE_HOME.",
  );
}

async function readParentRunIdFromDirectory(directory: string): Promise<string | undefined> {
  try {
    const raw = await readFile(Path.join(directory, ".crucible-run-id"), "utf8");
    const runId = raw.trim();
    return runId.length > 0 ? runId : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function buildLegacyChildDirectory(baseDirectory: string): string {
  return Path.join(baseDirectory, ".crucible-subtasks", randomUUID().slice(0, 8));
}

function getPrompt(positionals: ReadonlyArray<string>, promptFlag: string | undefined): string {
  const prompt = (promptFlag ?? positionals.join(" ")).trim();
  if (prompt.length === 0) {
    throw new Error("A prompt is required.");
  }
  return prompt;
}

async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    const stats = await stat(absolutePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function assertGitRepo(repoPath: string): Promise<void> {
  if (!(await isDirectory(Path.join(repoPath, ".git")))) {
    // Also accept worktrees (.git is a file that points at main repo's .git dir).
    try {
      await stat(Path.join(repoPath, ".git"));
    } catch {
      throw new Error(
        `--repo-path '${repoPath}' is not a git repository (no .git entry). Pass an explicit --repo-path or cd into a repo.`,
      );
    }
  }
}

async function resolveDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { timeout: 5_000 },
    );
    const ref = stdout.trim();
    // Format is typically "origin/main" - strip the remote prefix.
    const slash = ref.indexOf("/");
    if (slash !== -1 && slash < ref.length - 1) {
      return ref.slice(slash + 1);
    }
    if (ref.length > 0) {
      return ref;
    }
  } catch {
    // Fall through to fallback.
  }
  return "main";
}

interface WorktreeCreation {
  readonly worktreePath: string;
  readonly branch: string;
  readonly shortId: string;
}

async function createWorktree(repoPath: string, kind: "task" | "init"): Promise<WorktreeCreation> {
  const shortId = randomUUID().slice(0, 8);
  const worktreePath = Path.join(repoPath, ".crucible-worktrees", shortId);
  const branch = `${kind === "init" ? "crucible/init" : "crucible/task"}-${shortId}`;

  try {
    await execFileAsync("git", ["-C", repoPath, "worktree", "add", worktreePath, "-b", branch], {
      timeout: 60_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git worktree add failed for ${worktreePath} on branch ${branch}: ${message}`, {
      cause: error,
    });
  }

  return { worktreePath, branch, shortId };
}

interface ChildDirectoryPlan {
  readonly directory: string;
  readonly worktreeBranch?: string;
  readonly worktreeCreated: boolean;
}

async function resolveChildDirectory(flags: {
  readonly directoryFlag: string | undefined;
  readonly repoPath: string;
  readonly noWorktree: boolean;
  readonly kind: "task" | "init";
}): Promise<ChildDirectoryPlan> {
  if (flags.directoryFlag && flags.directoryFlag.trim().length > 0) {
    // Explicit directory always wins.
    return {
      directory: Path.resolve(flags.directoryFlag.trim()),
      worktreeCreated: false,
    };
  }

  if (flags.noWorktree) {
    return {
      directory: buildLegacyChildDirectory(process.cwd()),
      worktreeCreated: false,
    };
  }

  await assertGitRepo(flags.repoPath);
  const worktree = await createWorktree(flags.repoPath, flags.kind);
  return {
    directory: worktree.worktreePath,
    worktreeBranch: worktree.branch,
    worktreeCreated: true,
  };
}

async function main(): Promise<void> {
  if (argv.values.help) {
    printUsage();
    return;
  }

  const initializerMode = argv.values.initializer === true;
  const noWorktree = argv.values["no-worktree"] === true;

  if (initializerMode && noWorktree) {
    throw new Error("--initializer requires a worktree. Do not combine with --no-worktree.");
  }

  const parentRunId =
    argv.values["parent-run-id"]?.trim() ||
    process.env.CRUCIBLE_PARENT_RUN_ID?.trim() ||
    (await readParentRunIdFromDirectory(process.cwd()));

  const repo = argv.values.repo?.trim() || process.env.CRUCIBLE_REPO?.trim();
  if (initializerMode && !repo) {
    throw new Error("--initializer requires --repo <owner/name>.");
  }

  const repoPath = Path.resolve(argv.values["repo-path"]?.trim() || process.cwd());

  const plan = await resolveChildDirectory({
    directoryFlag: argv.values.directory,
    repoPath,
    noWorktree,
    kind: initializerMode ? "init" : "task",
  });

  let prompt: string;
  if (initializerMode) {
    if (argv.values.prompt || argv.positionals.length > 0) {
      throw new Error(
        "--initializer ignores positional/flag prompt arguments. The initializer prompt is canonical.",
      );
    }
    const defaultBranch = await resolveDefaultBranch(repoPath);
    // `repo` is guaranteed non-empty here by the initializer-mode check above.
    const initParams: InitializerPromptParams = {
      repo: repo!,
      repoPath,
      defaultBranch,
      agentBrowserAvailable: true,
    };
    prompt = buildInitializerPrompt(initParams);
  } else {
    prompt = getPrompt(argv.positionals, argv.values.prompt);
  }

  const options: SpawnSubtaskOptions = {
    prompt,
    directory: plan.directory,
    ...(argv.values.title ? { title: argv.values.title.trim() } : {}),
    ...(argv.values["expected-file"]
      ? { expectedFilePath: argv.values["expected-file"].trim() }
      : {}),
    ...(argv.values["expected-text"] ? { expectedText: argv.values["expected-text"].trim() } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    ...(argv.values.origin ? { origin: argv.values.origin.trim() } : {}),
    ...(argv.values["base-dir"] ? { baseDir: argv.values["base-dir"].trim() } : {}),
    ...(argv.values.token
      ? { token: argv.values.token.trim() }
      : process.env.T3CODE_BEARER_TOKEN?.trim()
        ? { token: process.env.T3CODE_BEARER_TOKEN.trim() }
        : {}),
    ...(repo ? { repo } : {}),
  };

  const origin = await resolveOrigin(options);
  const spawnNote = initializerMode
    ? "spawn-subtask CLI (initializer)"
    : plan.worktreeCreated
      ? `spawn-subtask CLI (worktree: ${plan.worktreeBranch ?? "<unknown>"})`
      : "spawn-subtask CLI";

  const response = await fetch(`${origin}/api/crucible/runs`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      directory: options.directory,
      title: options.title,
      prompt: options.prompt,
      expectedFilePath: options.expectedFilePath,
      expectedText: options.expectedText,
      parentRunId: options.parentRunId,
      repo: options.repo,
      type: initializerMode ? "task" : "task",
      spawnCommand: initializerMode ? "spawn-subtask --initializer" : "spawn-subtask",
      spawnTool: "bash",
      spawnNote,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text.trim().length > 0 ? text : `Request failed with ${response.status}`);
  }

  const payload = text.trim().length > 0 ? JSON.parse(text) : null;
  const enriched = {
    ...(payload as object | null),
    worktree: plan.worktreeCreated
      ? {
          path: plan.directory,
          branch: plan.worktreeBranch,
        }
      : null,
    initializer: initializerMode,
  };
  console.log(JSON.stringify(enriched, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
