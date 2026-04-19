/**
 * Crucible Eval - Task definitions and outcome verification.
 *
 * Declares a fixed set of benchmark tasks Crucible can drive an agent through
 * (currently targeted at the `manikrana.dev` repository) and provides a
 * post-run verifier that inspects the resulting working tree to decide
 * whether the agent satisfied the task's expected outcome.
 *
 * Outcome kinds supported:
 *   - `file_exists`      - a specific path exists under the run directory.
 *   - `file_contains`    - a specific path exists and contains a substring
 *                          (matched literally or via an optional regex).
 *   - `pr_created`       - git state shows commits on a non-default branch
 *                          (optionally matching a branch-name pattern); if
 *                          `gh` is available, a PR listing is also consulted.
 *   - `command_succeeds` - a shell command exits with status 0 inside the
 *                          run directory (e.g. `pnpm build`, `bun run lint`).
 *
 * This module is pure runtime logic and is intentionally Effect-free so it
 * can be consumed from both the HTTP surface and plain scripts. HTTP routing
 * lives in `./http.ts` (Stream 1 owner).
 *
 * @module crucible/eval
 */

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

// ==============================
// Types
// ==============================

/** Discriminated union describing how to validate an agent's output. */
export type ExpectedOutcome =
  | {
      readonly kind: "file_exists";
      /** Path relative to the run directory. */
      readonly path: string;
    }
  | {
      readonly kind: "file_contains";
      /** Path relative to the run directory. */
      readonly path: string;
      /** Literal substring or source for an optional regex. */
      readonly substring: string;
      /** When true, `substring` is compiled as a RegExp. */
      readonly regex?: boolean;
    }
  | {
      readonly kind: "pr_created";
      /**
       * Optional regex (as a string) the feature branch name must match.
       * When omitted any branch different from the default is accepted.
       */
      readonly branchPattern?: string;
      /** Default branch name - defaults to `main`. */
      readonly baseBranch?: string;
    }
  | {
      readonly kind: "command_succeeds";
      /** Executable (e.g. `bun`, `pnpm`, `node`). */
      readonly command: string;
      /** Arguments passed to the executable. */
      readonly args?: ReadonlyArray<string>;
      /** Optional timeout in milliseconds (defaults to 2 minutes). */
      readonly timeoutMs?: number;
    };

/** An eval task the agent should be given via a synthetic issue. */
export interface EvalTask {
  readonly id: string;
  readonly description: string;
  /** `owner/name` of the target GitHub repo. */
  readonly repo: string;
  readonly issueTitle: string;
  readonly issueBody: string;
  readonly expectedOutcome: ExpectedOutcome;
}

/** Result returned by {@link checkEvalOutcome}. */
export interface EvalResult {
  readonly taskId: string;
  readonly passed: boolean;
  /** Short, human-readable reason. Populated on failure. */
  readonly reason?: string;
  /** Extra structured diagnostic data (command output, matched path, etc.). */
  readonly details?: Readonly<Record<string, unknown>>;
}

// ==============================
// Task catalogue
// ==============================

const MANIKRANA_REPO = "manikrana/manikrana.dev";

export const EVAL_TASKS: ReadonlyArray<EvalTask> = [
  {
    id: "manikrana-readme-now-section",
    description: "Add a '## Now' section to the README summarising current focus.",
    repo: MANIKRANA_REPO,
    issueTitle: "docs(readme): add a '## Now' section",
    issueBody: [
      "Please add a new `## Now` section near the top of `README.md` (after the",
      "project introduction, before any deployment/setup instructions).",
      "",
      "The section should:",
      "- Briefly describe what I am currently focused on (1-3 bullet points).",
      "- Be written in the first person.",
      "- Mention that it follows the /now page convention (https://nownownow.com/about).",
      "",
      "Open a pull request titled `docs(readme): add Now section`.",
    ].join("\n"),
    expectedOutcome: {
      kind: "file_contains",
      path: "README.md",
      substring: "## Now",
    },
  },
  {
    id: "manikrana-footer-component",
    description: "Create a reusable <Footer /> component and render it on the home page.",
    repo: MANIKRANA_REPO,
    issueTitle: "feat(ui): add a shared Footer component",
    issueBody: [
      "Create a new React/Astro component at `src/components/Footer.tsx`",
      "(or `.astro` if the project uses Astro) that renders:",
      "",
      "- The current year followed by the site name.",
      "- Links to GitHub, Twitter/X and email.",
      "",
      "Then render the component on the home page layout so it appears on",
      "every page. Ship it via a pull request.",
    ].join("\n"),
    expectedOutcome: {
      kind: "file_exists",
      path: "src/components/Footer.tsx",
    },
  },
  {
    id: "manikrana-strict-typescript",
    description: "Enable TypeScript strict mode and ensure the project still type-checks.",
    repo: MANIKRANA_REPO,
    issueTitle: "chore(tsconfig): enable strict mode",
    issueBody: [
      "Enable TypeScript strict mode for the project.",
      "",
      '- In `tsconfig.json`, set `"strict": true` inside `compilerOptions`.',
      "- Fix any resulting type errors so `tsc --noEmit` (or the equivalent",
      "  `typecheck` script) exits cleanly.",
      "- Open a pull request when the type-check is green.",
    ].join("\n"),
    expectedOutcome: {
      kind: "file_contains",
      path: "tsconfig.json",
      substring: '"strict": true',
    },
  },
  {
    id: "manikrana-open-pr",
    description: "Open any pull request (sanity check that the agent can branch + commit + push).",
    repo: MANIKRANA_REPO,
    issueTitle: "chore: open a throwaway PR for eval",
    issueBody: [
      "Create a new branch, make any small, non-destructive change (e.g. a",
      "typo fix or comment tweak), commit it, and open a pull request.",
      "",
      "This task is intentionally loose - its purpose is to verify the agent",
      "can drive the full branch -> commit -> PR flow end to end.",
    ].join("\n"),
    expectedOutcome: {
      kind: "pr_created",
      baseBranch: "main",
    },
  },
];

// ==============================
// Outcome verification
// ==============================

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Inspect the post-run working tree for a given task and return whether the
 * expected outcome was satisfied.
 */
export async function checkEvalOutcome(task: EvalTask, runDirectory: string): Promise<EvalResult> {
  const outcome = task.expectedOutcome;
  switch (outcome.kind) {
    case "file_exists":
      return checkFileExists(task, runDirectory, outcome.path);
    case "file_contains":
      return checkFileContains(
        task,
        runDirectory,
        outcome.path,
        outcome.substring,
        outcome.regex ?? false,
      );
    case "pr_created":
      return checkPrCreated(
        task,
        runDirectory,
        outcome.baseBranch ?? "main",
        outcome.branchPattern,
      );
    case "command_succeeds":
      return checkCommandSucceeds(
        task,
        runDirectory,
        outcome.command,
        outcome.args ?? [],
        outcome.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function checkFileExists(
  task: EvalTask,
  runDirectory: string,
  relativePath: string,
): Promise<EvalResult> {
  const absolutePath = join(runDirectory, relativePath);
  const exists = await pathExists(absolutePath);
  if (exists) {
    return {
      taskId: task.id,
      passed: true,
      details: { path: relativePath },
    };
  }
  return {
    taskId: task.id,
    passed: false,
    reason: `Expected file '${relativePath}' does not exist.`,
    details: { path: relativePath },
  };
}

async function checkFileContains(
  task: EvalTask,
  runDirectory: string,
  relativePath: string,
  substring: string,
  isRegex: boolean,
): Promise<EvalResult> {
  const absolutePath = join(runDirectory, relativePath);
  if (!(await pathExists(absolutePath))) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Expected file '${relativePath}' does not exist.`,
      details: { path: relativePath },
    };
  }

  let contents: string;
  try {
    contents = await readFile(absolutePath, "utf8");
  } catch (error) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Failed to read '${relativePath}': ${errorMessage(error)}.`,
      details: { path: relativePath },
    };
  }

  const matched = isRegex
    ? safeRegexTest(substring, contents)
    : { ok: contents.includes(substring) };

  if (!matched.ok) {
    return {
      taskId: task.id,
      passed: false,
      reason:
        matched.error ??
        `File '${relativePath}' did not contain the expected ${isRegex ? "pattern" : "substring"}.`,
      details: { path: relativePath, pattern: substring, regex: isRegex },
    };
  }

  return {
    taskId: task.id,
    passed: true,
    details: { path: relativePath, pattern: substring, regex: isRegex },
  };
}

function safeRegexTest(source: string, value: string): { ok: boolean; error?: string } {
  try {
    return { ok: new RegExp(source).test(value) };
  } catch (error) {
    return { ok: false, error: `Invalid regex '${source}': ${errorMessage(error)}.` };
  }
}

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error?: string;
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        error: errorMessage(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        error: errorMessage(error),
      });
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, timedOut });
    });
  });
}

async function checkCommandSucceeds(
  task: EvalTask,
  runDirectory: string,
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<EvalResult> {
  const outcome = await runCommand(command, args, runDirectory, timeoutMs);
  const invocation = [command, ...args].join(" ");

  if (outcome.error) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Failed to run '${invocation}': ${outcome.error}.`,
      details: summariseCommand(invocation, outcome),
    };
  }
  if (outcome.timedOut) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Command '${invocation}' timed out after ${timeoutMs}ms.`,
      details: summariseCommand(invocation, outcome),
    };
  }
  if (outcome.exitCode !== 0) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Command '${invocation}' exited with code ${outcome.exitCode ?? "null"}.`,
      details: summariseCommand(invocation, outcome),
    };
  }

  return {
    taskId: task.id,
    passed: true,
    details: summariseCommand(invocation, outcome),
  };
}

function summariseCommand(invocation: string, outcome: CommandOutcome): Record<string, unknown> {
  return {
    command: invocation,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    stdoutTail: tailLines(outcome.stdout, 20),
    stderrTail: tailLines(outcome.stderr, 20),
  };
}

function tailLines(value: string, max: number): string {
  if (value.length === 0) return "";
  const lines = value.split(/\r?\n/g);
  return lines.slice(Math.max(0, lines.length - max)).join("\n");
}

async function checkPrCreated(
  task: EvalTask,
  runDirectory: string,
  baseBranch: string,
  branchPattern: string | undefined,
): Promise<EvalResult> {
  if (!(await pathExists(join(runDirectory, ".git")))) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Run directory '${runDirectory}' is not a git repository.`,
    };
  }

  const currentBranchOutcome = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    runDirectory,
    10_000,
  );
  if (currentBranchOutcome.exitCode !== 0) {
    return {
      taskId: task.id,
      passed: false,
      reason: "Failed to determine current git branch.",
      details: summariseCommand("git rev-parse --abbrev-ref HEAD", currentBranchOutcome),
    };
  }
  const currentBranch = currentBranchOutcome.stdout.trim();

  if (currentBranch === baseBranch || currentBranch === "HEAD") {
    return {
      taskId: task.id,
      passed: false,
      reason: `Current branch '${currentBranch}' is the base branch - agent did not branch.`,
      details: { currentBranch, baseBranch },
    };
  }

  if (branchPattern) {
    const match = safeRegexTest(branchPattern, currentBranch);
    if (!match.ok) {
      return {
        taskId: task.id,
        passed: false,
        reason:
          match.error ??
          `Branch '${currentBranch}' did not match required pattern '${branchPattern}'.`,
        details: { currentBranch, branchPattern },
      };
    }
  }

  const aheadOutcome = await runCommand(
    "git",
    ["rev-list", "--count", `${baseBranch}..HEAD`],
    runDirectory,
    10_000,
  );
  if (aheadOutcome.exitCode !== 0) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Failed to compare branch '${currentBranch}' against base '${baseBranch}'.`,
      details: summariseCommand(`git rev-list --count ${baseBranch}..HEAD`, aheadOutcome),
    };
  }
  const aheadCount = Number.parseInt(aheadOutcome.stdout.trim(), 10);
  if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
    return {
      taskId: task.id,
      passed: false,
      reason: `Branch '${currentBranch}' has no commits ahead of '${baseBranch}'.`,
      details: { currentBranch, baseBranch, aheadCount },
    };
  }

  // Best-effort: if the `gh` CLI is available, prefer confirming a PR exists.
  const ghOutcome = await runCommand(
    "gh",
    ["pr", "list", "--head", currentBranch, "--json", "number,state"],
    runDirectory,
    15_000,
  );
  if (ghOutcome.error === undefined && ghOutcome.exitCode === 0) {
    const prs = parseGhPrList(ghOutcome.stdout);
    if (prs !== null) {
      if (prs.length === 0) {
        return {
          taskId: task.id,
          passed: false,
          reason: `No GitHub PR found for branch '${currentBranch}' (branch has commits but no PR).`,
          details: { currentBranch, baseBranch, aheadCount },
        };
      }
      return {
        taskId: task.id,
        passed: true,
        details: { currentBranch, baseBranch, aheadCount, prs },
      };
    }
  }

  // `gh` not available or returned unparseable output - fall back to the
  // local branch-ahead signal, which is the best we can do offline.
  return {
    taskId: task.id,
    passed: true,
    details: { currentBranch, baseBranch, aheadCount, prConfirmedVia: "local-branch-only" },
  };
}

function parseGhPrList(stdout: string): ReadonlyArray<Record<string, unknown>> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is Record<string, unknown> => {
        return typeof entry === "object" && entry !== null;
      });
    }
    return null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
