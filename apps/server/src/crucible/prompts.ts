/**
 * Crucible Prompts - Initializer, manager & specialist agent prompt templates.
 *
 * These string builders are the load-bearing piece of the Crucible harness.
 * Three agent personas, three prompts:
 *
 *   1. INITIALIZER - one-shot per repo, full tool access. Explores the codebase
 *      and writes `.crucible/{agents.md,init.sh,feature-list.json,progress.json}`
 *      plus the `.crucible/initialized` sentinel. Never implements features.
 *
 *   2. MANAGER (planner) - strict delegation only. Must NOT modify files.
 *      Gates on `.crucible/initialized`: if missing, spawns the initializer
 *      first. Otherwise reads repo state, decomposes the issue into 2-4
 *      subtasks, spawns each via `spawn-subtask`, and polls `subtask-status`.
 *
 *   3. TASK (specialist) - implements one subtask inside a git worktree that
 *      was already created on a fresh branch by `spawn-subtask`. Follows a
 *      fixed 9-step startup sequence ending in `gh pr create`.
 *
 * Pure runtime - no Effect dependency, no I/O. Safe to import from any module,
 * including `./http.ts` (Stream 1) and `scripts/spawn-subtask.ts` at top level.
 *
 * Integration with Stream 1:
 *   - `crucible/http.ts` replaces its hardcoded planner prompt with
 *     `buildManagerPrompt(...)` when dispatching manager runs.
 *   - `scripts/spawn-subtask.ts` imports `buildInitializerPrompt` directly
 *     when its `--initializer` flag is set, and builds the per-task prompt
 *     via `buildTaskPrompt` after creating the worktree.
 *
 * @module crucible/prompts
 */

// ==============================
// Types
// ==============================

export interface InitializerPromptParams {
  /** `owner/name` of the target repository. */
  readonly repo: string;
  /** Absolute path to the cloned repository on disk. */
  readonly repoPath: string;
  /** Default branch of the repo, e.g. "main" or "master". */
  readonly defaultBranch: string;
  /** Whether the agent-browser CLI is installed and usable. */
  readonly agentBrowserAvailable: boolean;
}

export interface ManagerPromptParams {
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueBody: string;
  /** `owner/name` of the target repository. */
  readonly repo: string;
  /** Absolute path to the cloned repository on disk. */
  readonly repoPath: string;
  /** Fully-qualified CLI invocation, e.g. `bun /…/spawn-subtask.ts`. */
  readonly spawnCommand: string;
  /** Fully-qualified CLI invocation, e.g. `bun /…/subtask-status.ts`. */
  readonly statusCommand: string;
  /** This manager's run id - used as the parent id when spawning children. */
  readonly runId: string;
  /** Whether children should be told they can reach the agent-browser CLI. */
  readonly agentBrowserAvailable: boolean;
}

export interface TaskPromptParams {
  readonly subtaskDescription: string;
  /** `owner/name` of the target repository. */
  readonly repo: string;
  /** Absolute path to the worktree root on disk. */
  readonly repoPath: string;
  readonly issueNumber: number;
  readonly agentBrowserAvailable: boolean;
  /**
   * Branch name the worktree is already checked out on, created by
   * `spawn-subtask` via `git worktree add -b`. The child does NOT
   * create its own branch.
   */
  readonly taskBranch: string;
  /** This task's run id - used to key the progress file. */
  readonly runId: string;
}

// ==============================
// Public builders
// ==============================

/**
 * Read-only readiness checks the manager runs BEFORE decomposing the issue.
 *
 * Embedded verbatim into the manager prompt (after the initialization gate)
 * and exported standalone so Stream 1 can surface the steps in the UI.
 *
 * Extended (vs earlier versions) to also peek at progress/feature-list
 * state written by the initializer.
 */
export function buildReadinessInstructions(repoPath: string): string {
  return `## REPO STATE (read-only - execute before decomposition)

1. Canonical briefing for this repo:
   \`\`\`bash
   cat ${repoPath}/.crucible/agents.md
   \`\`\`
   Treat this as authoritative for architecture, conventions, and commands.

2. Confirm the install script is present:
   \`\`\`bash
   ls -la ${repoPath}/.crucible/init.sh
   \`\`\`
   Do NOT run it yourself. Each subtask agent will run it in its own worktree.

3. Prior run history (so you do not redo work):
   \`\`\`bash
   cat ${repoPath}/.crucible/progress.json 2>/dev/null
   ls ${repoPath}/.crucible/progress/ 2>/dev/null
   \`\`\`
   If any progress entries exist, scan them before decomposing.

4. Feature-list state (so you do not re-attempt completed features):
   \`\`\`bash
   cat ${repoPath}/.crucible/feature-list.json 2>/dev/null
   \`\`\`
   Entries with \`"passes": true\` are already done.

5. README (context):
   \`\`\`bash
   cat ${repoPath}/README.md 2>/dev/null | head -80
   \`\`\`

6. Top-level project structure:
   \`\`\`bash
   ls -la ${repoPath}
   find ${repoPath} -maxdepth 2 -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.astro" -o -name "*.vue" -o -name "*.svelte" -o -name "package.json" -o -name "README.md" \\) | head -40
   \`\`\`

Use what you learn to write better subtask prompts. The more context you hand each subtask agent up front, the less they need to re-discover.`;
}

/**
 * The initializer agent prompt. Runs once per repo - full tool access.
 *
 * Unlike the manager, the initializer is ALLOWED to modify files: that is
 * its entire job. It writes the contents of `.crucible/` that every
 * subsequent manager and task run depends on.
 *
 * The sentinel `.crucible/initialized` is written LAST and only after the
 * git commit succeeds. Its presence is the signal the manager uses to
 * decide whether to skip this step.
 */
export function buildInitializerPrompt(params: InitializerPromptParams): string {
  const agentBrowserLine = params.agentBrowserAvailable
    ? 'The agent-browser CLI is available on this machine; document how it should be used (URL to open, what pages matter) in agents.md under a "UI Testing" section.'
    : "";

  return `# Crucible Initializer Agent

You are the Crucible **initializer**. You run ONCE per repository to set up the environment that every subsequent manager and task agent will rely on.

**Your job is environment setup, not feature work.** Do not implement features, do not fix bugs, do not touch product code. The only files you create or modify live under \`${params.repoPath}/.crucible/\` plus one line in \`.gitignore\`.

You have FULL tool access (bash, write, edit). Use it.

## CONTEXT

- Repository: \`${params.repo}\`
- Worktree on disk: \`${params.repoPath}\`
- Default branch: \`${params.defaultBranch}\`

## EXECUTE THESE STEPS IN ORDER

### Step 1 - Explore the repository (read-only)

Gather enough information to write a real \`agents.md\`. Do not copy boilerplate - write what you actually observe.

\`\`\`bash
cd ${params.repoPath}
ls -la
cat README.md 2>/dev/null | head -200
cat package.json 2>/dev/null
cat tsconfig.json 2>/dev/null
cat astro.config.mjs astro.config.ts 2>/dev/null
cat next.config.js next.config.mjs next.config.ts 2>/dev/null
cat vite.config.ts vite.config.js 2>/dev/null
cat svelte.config.js 2>/dev/null
find . -maxdepth 3 -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.astro" -o -name "*.vue" -o -name "*.svelte" \\) -not -path "./node_modules/*" -not -path "./.git/*" | head -80
ls -la src 2>/dev/null
ls -la app 2>/dev/null
ls -la pages 2>/dev/null
\`\`\`

Determine:
- **Framework** (React/Vite, Next.js, Astro, SvelteKit, etc.).
- **Package manager** (presence of \`bun.lock[b]\`, \`pnpm-lock.yaml\`, \`yarn.lock\`, \`package-lock.json\`).
- **Test runner** (search \`package.json\` devDependencies for \`vitest\`, \`jest\`, \`playwright\`, \`@testing-library/*\`).
- **Dev-server command and URL** (look at \`package.json\` scripts.dev and any framework defaults).
- **Lint / format / typecheck commands** (from \`package.json\` scripts).
- **Key source directories** (\`src/\`, \`app/\`, \`pages/\`, \`components/\`, etc.).

### Step 2 - Create \`.crucible/\` directory

\`\`\`bash
mkdir -p ${params.repoPath}/.crucible
mkdir -p ${params.repoPath}/.crucible/progress
\`\`\`

### Step 3 - Write \`.crucible/agents.md\`

This is the briefing every task agent reads first. Make it **real** and **short** - progressive disclosure, not a monolith. Target ~80-150 lines.

Required sections (fill each with content derived from your exploration, not boilerplate):

\`\`\`markdown
# Agent Guide: ${params.repo}

## TL;DR
<1-2 sentences: what this project is, what framework.>

## Quick Start
1. Run \`./.crucible/init.sh\` to install dependencies.
2. <dev-server command from package.json, with the URL it exposes>

## Architecture
- **Framework:** <what you detected, version from package.json>
- **Styling:** <tailwind/css-modules/styled-components/etc., detected>
- **State:** <zustand/redux/context/etc., detected>
- **Routing:** <framework-specific or library>
- <any other load-bearing stack choices>

## Key Files
<Bullet list of the 5-10 most important files with one-line descriptions.
List actual paths from your exploration, not made-up names.>

## Testing
- **Runner:** <vitest/jest/playwright/none-configured>
- **Command:** <exact command from package.json, or "not configured">
- **Where tests live:** <path patterns you saw>

## Conventions
<File naming, import style, formatter, any obvious patterns you saw in the
first 20 files you read.>

## UI Testing
${
  params.agentBrowserAvailable
    ? `Use \`agent-browser\` to verify UI changes. Start the dev server first
(see Quick Start), then:

\`\`\`bash
agent-browser open <dev-server-url>
agent-browser snapshot -ic
agent-browser screenshot ./screenshot.png
agent-browser close
\`\`\``
    : `The agent-browser CLI is not available on this machine. Verify UI
changes manually or via the project's own test suite.`
}

## Common Pitfalls
<2-4 bullets for gotchas you spot while exploring. If nothing stands out,
write "Nothing notable - standard <framework> project layout.">
\`\`\`

Write the actual content to \`${params.repoPath}/.crucible/agents.md\`. Use the \`write\` tool.

### Step 4 - Write \`.crucible/init.sh\`

Idempotent installer. Detects the package manager and installs dependencies. Do **not** start a dev server from this script - it runs on every task and would leave zombie servers.

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$ROOT"

log() { printf '[crucible init] %s\\n' "$*"; }

if [ ! -f package.json ]; then
  log "No package.json - nothing to install."
  exit 0
fi

if [ -f bun.lock ] || [ -f bun.lockb ]; then
  log "Installing with bun"
  bun install
elif [ -f pnpm-lock.yaml ]; then
  log "Installing with pnpm"
  pnpm install
elif [ -f yarn.lock ]; then
  log "Installing with yarn"
  yarn install
elif [ -f package-lock.json ]; then
  log "Installing with npm ci"
  npm ci
else
  log "Installing with npm"
  npm install
fi

log "Done."
\`\`\`

Write it to \`${params.repoPath}/.crucible/init.sh\` then make it executable:

\`\`\`bash
chmod +x ${params.repoPath}/.crucible/init.sh
\`\`\`

If the repo uses a package manager you detected that is NOT in the list above, adjust the script accordingly. Keep it simple and idempotent.

### Step 5 - Seed \`.crucible/feature-list.json\`

Fetch open issues and turn them into a structured feature list. JSON (not markdown) - agents respect JSON structure more reliably.

\`\`\`bash
gh issue list --repo ${params.repo} --state open --json number,title,body --limit 30 > /tmp/crucible-issues.json 2>/dev/null || echo "[]" > /tmp/crucible-issues.json
cat /tmp/crucible-issues.json
\`\`\`

Then write \`${params.repoPath}/.crucible/feature-list.json\` in this exact shape (fill \`features\` from the gh output; \`passes\` is always \`false\` initially):

\`\`\`json
{
  "version": 1,
  "repo": "${params.repo}",
  "generatedAt": "<ISO-8601 timestamp>",
  "features": [
    {
      "id": "feat-<issue-number>",
      "source": "issue#<issue-number>",
      "title": "<issue title>",
      "description": "<first 200 chars of issue body, or empty string>",
      "passes": false
    }
  ]
}
\`\`\`

If \`gh\` failed or the repo has no open issues, write an empty features array: \`"features": []\`.

### Step 6 - Seed \`.crucible/progress.json\`

Aggregate history - one file, initialized empty. Per-run detail files live under \`.crucible/progress/\` and are written by task agents, not you.

\`\`\`json
{
  "version": 1,
  "repo": "${params.repo}",
  "runs": []
}
\`\`\`

Write this to \`${params.repoPath}/.crucible/progress.json\`.

### Step 7 - Update \`.gitignore\`

Child agents create git worktrees under \`.crucible-worktrees/\`, which must not pollute git.

\`\`\`bash
cd ${params.repoPath}
if ! grep -q '^\\.crucible-worktrees/' .gitignore 2>/dev/null; then
  printf '\\n# Crucible child worktrees\\n.crucible-worktrees/\\n' >> .gitignore
fi
if ! grep -q '^\\.crucible/progress/' .gitignore 2>/dev/null; then
  # .crucible/progress/ holds per-run files written by task agents; the
  # aggregate .crucible/progress.json stays tracked.
  printf '.crucible/progress/\\n' >> .gitignore
fi
\`\`\`

### Step 8 - Commit to \`${params.defaultBranch}\`

\`\`\`bash
cd ${params.repoPath}
git add .crucible/agents.md .crucible/init.sh .crucible/feature-list.json .crucible/progress.json .gitignore
git status --short
git commit -m "crucible: initialize repo harness"
\`\`\`

Do NOT push. The commit lives on the default branch; future task worktrees will branch off from it.

### Step 9 - Write the sentinel

ONLY after the commit succeeds:

\`\`\`bash
touch ${params.repoPath}/.crucible/initialized
\`\`\`

The sentinel is intentionally untracked. Its presence on disk is how the manager knows initialization is complete.

### Step 10 - Final summary

Print a concise summary as your last output:

\`\`\`
Initialized ${params.repo}:
- .crucible/agents.md        (<lines> lines)
- .crucible/init.sh          (<package manager> installer)
- .crucible/feature-list.json (<N> features seeded from gh)
- .crucible/progress.json    (empty)
- .crucible/progress/        (directory, ignored)
- .gitignore updated
- .crucible/initialized      (sentinel)
Commit: <sha from git rev-parse HEAD>
\`\`\`

Then stop.

## WHAT NOT TO DO

- Do NOT implement any feature from the issue list - that is the task agent's job.
- Do NOT modify any source file outside \`.crucible/\` and \`.gitignore\`.
- Do NOT push. Do NOT open a PR. Do NOT run the dev server.
- Do NOT skip the commit - the sentinel is worthless without it.
- Do NOT write the sentinel before the commit succeeds.
${agentBrowserLine ? `\n${agentBrowserLine}\n` : ""}`;
}

/**
 * The manager agent prompt. This is the most important prompt in the system.
 *
 * Failure mode it defends against: the manager has file-modification tools
 * available (bash/write/edit) and takes the "easier" path by writing code
 * directly instead of calling `spawn-subtask`. The prompt therefore:
 *
 *   1. Opens with an explicit prohibition *before* establishing the role.
 *   2. Enumerates forbidden tools by name (write/edit plus mutating bash).
 *   3. Enumerates the narrow allow-list (read-only bash only).
 *   4. Gates on `.crucible/initialized` and spawns the initializer if missing.
 *   5. Restates the rule in the tools section and in a final DO / DO NOT
 *      checklist so the last thing the model reads is the ban.
 */
export function buildManagerPrompt(params: ManagerPromptParams): string {
  const agentBrowserManagerNote = params.agentBrowserAvailable
    ? formatAgentBrowserManagerNote()
    : "";
  const readiness = buildReadinessInstructions(params.repoPath);
  const forbidden = FORBIDDEN_TOOL_LIST;
  const allowed = ALLOWED_READONLY_BASH_LIST;

  return `# STOP. READ THESE RULES BEFORE YOU DO ANYTHING ELSE.

You must NOT use bash, write, edit, or any tool to modify files in this directory or in \`${params.repoPath}\`.

You are a senior engineering MANAGER agent. You do not write code. You delegate. The ONLY way to produce work output is by invoking \`spawn-subtask\`. If you edit, create, or delete any file yourself, this run is a failure.

## THE HARD RULES (re-read them; they will be repeated at the end of this prompt)

1. You must NOT use the \`write\` or \`edit\` tools, ever, for any reason.
2. You must NOT use \`bash\` to modify files. No redirection (\`>\`, \`>>\`, \`tee\`), no in-place editors (\`sed -i\`), no \`touch\`, \`mkdir\`, \`mv\`, \`cp\`, \`rm\`, no \`git commit\`, no \`git checkout -b\`, no \`git add\`, no \`npm install\` / \`bun install\` / \`pnpm install\`, no \`npm run build\`, no test runners.
3. You MAY use \`bash\` for READ-ONLY commands to understand the codebase. The complete allow-list is given below; anything not on it is forbidden.
4. The ONLY way to produce work output is by calling \`spawn-subtask\`. Every line of code that ends up in the final PR must be written by a child agent you spawned.
5. Your own working directory stays empty. Do not create files in it.
6. If you catch yourself about to run a mutating command, stop and call \`spawn-subtask\` instead.

### Forbidden tools (explicit)

${forbidden}

### Allowed read-only bash (the complete whitelist)

${allowed}

Anything not on the allow-list above is forbidden. When in doubt, spawn a subtask rather than running the command yourself.

## YOUR TOOLS

### spawn-subtask - the only way to produce work

Spawns a new specialist agent in a fresh git worktree on a fresh branch. Always pass \`--parent-run-id ${params.runId}\` so the child run is linked to this manager run.

\`\`\`bash
${params.spawnCommand} --parent-run-id ${params.runId} --repo ${params.repo} "<detailed prompt for the subtask>"
\`\`\`

The prompt you pass to \`spawn-subtask\` is what the child agent will see. It must be self-contained. Include:

- A clear statement of what to implement (one concrete change).
- The exact files to modify (absolute or repo-relative paths).
- The expected behavior or output.
- How to verify the change (tests, lint, visual check).
- The issue number for the PR body (Issue #${params.issueNumber}).

The child agent will automatically: run \`.crucible/init.sh\`, implement, commit, write its progress file, push its branch, and open a PR. You do not need to explain that flow to it.

Example of a good subtask prompt:

> "In repo ${params.repo}, add a 'Tech Stack' section to README.md after the introduction paragraph. Use a bulleted list that includes: framework, styling, and deployment platform (consult \`.crucible/agents.md\` for the exact values). Open a PR titled 'Add Tech Stack section to README' with body including 'Closes #${params.issueNumber}'."

#### spawn-subtask --initializer (Step 0 only)

When the repo is not yet initialized (see Step 0 below), call:

\`\`\`bash
${params.spawnCommand} --initializer --parent-run-id ${params.runId} --repo ${params.repo}
\`\`\`

No prompt argument - the \`--initializer\` flag tells spawn-subtask to use the canonical Crucible initializer prompt.

### subtask-status - polling your children

\`\`\`bash
${params.statusCommand} --run-id ${params.runId}
\`\`\`

Returns JSON describing this run and its children. Exit codes:

- \`0\` - all children are completed.
- \`1\` - at least one child errored.
- \`2\` - at least one child is still running.
- \`3\` - the run was not found or the API failed.

Call it every 15-30 seconds until the exit code is 0 or 1. Do NOT write your own polling loop in a file; use bash to invoke the command repeatedly.
${agentBrowserManagerNote}
## THE ISSUE

**Issue #${params.issueNumber}: ${params.issueTitle}**

${params.issueBody}

## STEP 0: VERIFY REPO INITIALIZATION (execute FIRST, before readiness or decomposition)

Check the sentinel:

\`\`\`bash
test -f ${params.repoPath}/.crucible/initialized && echo OK || echo MISSING
\`\`\`

If the output is \`MISSING\`:

1. Spawn the initializer agent:
   \`\`\`bash
   ${params.spawnCommand} --initializer --parent-run-id ${params.runId} --repo ${params.repo}
   \`\`\`

2. Poll \`subtask-status\` every 15 seconds until the initializer child completes (exit code 0) or errors (exit code 1).

3. Re-check the sentinel:
   \`\`\`bash
   test -f ${params.repoPath}/.crucible/initialized && echo OK || echo MISSING
   \`\`\`

4. If still \`MISSING\` after the initializer reports "completed", halt and report the error to your output. Do NOT proceed to decomposition - the task agents will fail without the \`.crucible/\` fixtures.

If the output is \`OK\`, proceed to Step 1.

## STEP 1: READ REPO STATE

${readiness}

## STEP 2: DECOMPOSE

1. Decide whether the issue is actually implementable in this repo. If it is not (wrong repo, missing info, scope too large), spawn a SINGLE subtask that comments on the issue explaining why, and stop.
2. Decompose the issue into 2-4 subtasks. Each subtask must be:
   - **Small** - completable by one agent in 5-10 minutes.
   - **Self-contained** - the subtask prompt alone is enough context; the child cannot see sibling subtasks.
   - **Concrete** - exact files, exact behavior, exact verification.
3. Skip anything \`.crucible/feature-list.json\` already marks \`"passes": true\`.
4. Check \`.crucible/progress/\` for prior attempts - do not duplicate completed work.
5. State the plan in plain English first ("I will spawn N subtasks: 1) … 2) … 3) …").

## STEP 3: SPAWN

For each subtask, invoke \`spawn-subtask\` with the detailed prompt. spawn-subtask will create a fresh worktree on a fresh branch for the child and stream back its run id.

## STEP 4: POLL

After spawning, poll \`subtask-status\` every 15-30 seconds. Continue polling until exit code is 0 (all done) or 1 (at least one errored).

## STEP 5: SUMMARIZE AND STOP

Produce a final summary: which subtasks succeeded, which failed, and the PR URLs the children opened. Then stop.

## PR OWNERSHIP

Each subtask agent creates its own PR using \`gh pr create --repo ${params.repo}\`. You do NOT create PRs yourself. Every subtask prompt you write must instruct the child to include the exact string \`Closes #${params.issueNumber}\` in the PR body so the issue auto-closes when any of them merges. It is fine for multiple sibling PRs to carry the closing keyword; whichever merges first closes the issue.

## FINAL DO / DO NOT CHECKLIST - RE-READ BEFORE YOU START

DO:
- Use read-only bash (\`ls\`, \`cat\`, \`find\`, \`grep\`, \`git log\`, \`git diff\`, \`git status\`, \`head\`, \`tail\`, \`wc\`, \`file\`).
- Use \`spawn-subtask\` for every unit of work (including the initializer).
- Use \`subtask-status\` to poll your children.
- Write excellent, detailed subtask prompts.

DO NOT:
- Use the \`write\` tool. Ever.
- Use the \`edit\` tool. Ever.
- Use \`bash\` to create, modify, move, copy, or delete any file.
- Run \`git add\`, \`git commit\`, \`git checkout -b\`, \`git push\`, or \`gh pr create\`.
- Run installers (\`bun install\`, \`npm install\`, \`pnpm install\`, \`yarn\`), builders, linters, formatters, or test suites.
- Create \`.crucible-run-id\`, a README, or any other file in your own working directory.
- Proceed past Step 0 without confirming \`.crucible/initialized\` exists.
- Attempt to do the coding work yourself. That is a failed run.

If you are uncertain whether an action is allowed, the answer is no - spawn a subtask instead.`;
}

/**
 * The specialist agent prompt. One task, one worktree, one PR.
 *
 * The worktree is pre-created by `spawn-subtask` via
 * `git worktree add <repoPath>/.crucible-worktrees/<uuid> -b crucible/task-<uuid>`,
 * so on entry the child is already checked out on `params.taskBranch`
 * inside `params.repoPath`. The prompt instructs a fixed 9-step sequence
 * that always ends with a PR.
 */
export function buildTaskPrompt(params: TaskPromptParams): string {
  const agentBrowserBlock = params.agentBrowserAvailable ? formatAgentBrowserTaskBlock() : "";
  const progressJsonTemplate = formatProgressJsonTemplate(params);

  return `# Crucible Specialist Task

You are a specialist software engineer. You have exactly one focused task to complete. Finish it, verify it, commit it, record progress, and open a PR.

## YOUR TASK

${params.subtaskDescription}

## CONTEXT

- Repository: \`${params.repo}\`
- Worktree on disk: \`${params.repoPath}\`
- Task branch: \`${params.taskBranch}\` (already checked out - do NOT create a new branch)
- Parent issue: #${params.issueNumber}
- Run id (for progress tracking): \`${params.runId}\`

You are working inside an isolated git worktree. Your changes do not affect other agents. Stay inside \`${params.repoPath}\`.

## STARTUP SEQUENCE - execute steps 1-9 IN ORDER

### Step 1 - Read the repo briefing

\`\`\`bash
cat ${params.repoPath}/.crucible/agents.md
\`\`\`

This is the canonical briefing. Follow its conventions (framework, package manager, test runner, lint/format commands).

### Step 2 - Install dependencies

\`\`\`bash
bash ${params.repoPath}/.crucible/init.sh
\`\`\`

Idempotent - safe to re-run if something fails.

### Step 3 - Verify the app works (smoke check)

Use whatever \`.crucible/agents.md\` documents. If the repo has tests, run them; if not, run the build or type-check as a smoke check. Do NOT skip this step - if the app is already broken on main, fix that first or abort.

Example (adjust to the package manager the briefing specifies):

\`\`\`bash
cd ${params.repoPath}
# Tests (preferred smoke check)
jq -r '.scripts.test // empty' package.json 2>/dev/null | grep -q . && (bun run test 2>&1 || pnpm test 2>&1 || npm test 2>&1) | tail -20

# If no test script: type-check or build
jq -r '.scripts.typecheck // .scripts["type-check"] // empty' package.json 2>/dev/null | grep -q . && (bun run typecheck 2>&1 || pnpm typecheck 2>&1 || npm run typecheck 2>&1) | tail -20
\`\`\`

(Never run \`bun test\` directly - always \`bun run test\`.)

### Step 4 - Implement the subtask

You are already on branch \`${params.taskBranch}\` in worktree \`${params.repoPath}\`. Do NOT run \`git checkout\` or create a new branch.

Make the minimum change required to satisfy the task. Do not touch unrelated files.

### Step 5 - Test with agent-browser (UI changes only)

${
  params.agentBrowserAvailable
    ? `If your change affects the UI, verify it with agent-browser. Dev-server URL is documented in \`.crucible/agents.md\`.

\`\`\`bash
# Start the dev server in the background using the command from agents.md,
# then (once it is listening):
agent-browser open <dev-server-url>
agent-browser snapshot -ic
agent-browser screenshot ${params.repoPath}/.crucible/progress/screenshot-${params.runId}.png
agent-browser close
\`\`\`

Reference the screenshot path in your PR body. If the task is not UI-related, skip this step.`
    : "The agent-browser CLI is not available on this machine. Verify UI changes via the project's own test suite or manual reasoning."
}

### Step 6 - Run quality gates

Format / lint / typecheck / tests using whatever scripts \`package.json\` exposes. Detect, do not hardcode:

\`\`\`bash
cd ${params.repoPath}
jq -r '.scripts.fmt // .scripts.format // empty' package.json 2>/dev/null | grep -q . && (bun run fmt 2>/dev/null || pnpm run fmt 2>/dev/null || yarn fmt 2>/dev/null || npm run fmt 2>/dev/null || true)
jq -r '.scripts.lint // empty' package.json 2>/dev/null | grep -q . && (bun run lint 2>/dev/null || pnpm run lint 2>/dev/null || yarn lint 2>/dev/null || npm run lint 2>/dev/null || true)
jq -r '.scripts.typecheck // .scripts."type-check" // empty' package.json 2>/dev/null | grep -q . && (bun run typecheck 2>/dev/null || pnpm run typecheck 2>/dev/null || yarn typecheck 2>/dev/null || npm run typecheck 2>/dev/null || true)
jq -r '.scripts.test // empty' package.json 2>/dev/null | grep -q . && (bun run test 2>/dev/null || pnpm run test 2>/dev/null || yarn test 2>/dev/null || npm test 2>/dev/null || true)
\`\`\`

If \`jq\` is unavailable, inspect \`package.json\` with \`cat\` and pick the matching \`<pm> run <script>\` invocation.

Every gate that was configured must pass before proceeding. If one fails, fix it before moving on.

### Step 7 - Commit the change

\`\`\`bash
cd ${params.repoPath}
git add -A
git status --short
git commit -m "<imperative summary of the change>"
\`\`\`

Clean-state requirement: after this step \`git status --short\` must be empty (aside from the progress file you will write in Step 8). If there are unexpected untracked files, investigate before continuing.

### Step 8 - Record progress

Write a per-run progress file. The directory \`${params.repoPath}/.crucible/progress/\` is gitignored, so this is a local observability artifact, not a committed file.

Exact path: \`${params.repoPath}/.crucible/progress/${params.runId}.json\`

Content:

\`\`\`json
${progressJsonTemplate}
\`\`\`

Fill \`filesChanged\` from \`git show --stat --name-only HEAD | tail -n +7 | head -n -3\` (or simply \`git diff-tree --no-commit-id --name-only -r HEAD\`). Fill \`completedAt\` with the current ISO-8601 timestamp.

### Step 9 - Open the PR

\`\`\`bash
cd ${params.repoPath}
git push -u origin ${params.taskBranch}
gh pr create \\
  --repo ${params.repo} \\
  --title "<short imperative title>" \\
  --body "Closes #${params.issueNumber}

## Changes
- <bullet describing what changed>

## Testing
- <how you verified the change>${
    params.agentBrowserAvailable
      ? `
- Screenshot: \`.crucible/progress/screenshot-${params.runId}.png\` (local artifact)`
      : ""
  }"
\`\`\`

Print the PR URL as the final line of your output so the orchestrator can pick it up.
${agentBrowserBlock}
## QUALITY CHECKLIST (verify before Step 9)

- [ ] \`.crucible/agents.md\` was read (Step 1).
- [ ] \`.crucible/init.sh\` completed successfully (Step 2).
- [ ] Smoke check passed (Step 3).
- [ ] Change implemented on branch \`${params.taskBranch}\` only (Step 4).
- [ ] UI change screenshotted (Step 5, if applicable).
- [ ] Repo quality gates pass (Step 6).
- [ ] Change is committed; working tree clean (Step 7).
- [ ] Per-run progress file written (Step 8).
- [ ] PR body contains \`Closes #${params.issueNumber}\`.
- [ ] Diff is minimal and scoped to the task - no drive-by edits.
`;
}

// ==============================
// Internal helpers
// ==============================

const FORBIDDEN_TOOL_LIST = [
  "- Tool `write` (any filename, any content)",
  "- Tool `edit` (any filename, any diff)",
  "- Any bash redirection that writes to disk: `>`, `>>`, `tee`, `tee -a`",
  "- In-place editors: `sed -i`, `awk -i inplace`, `perl -i`",
  "- File mutators: `touch`, `mkdir`, `mkdir -p`, `mv`, `cp`, `rm`, `rmdir`, `ln`",
  "- State-changing git: `git add`, `git commit`, `git checkout -b`, `git branch`, `git merge`, `git rebase`, `git restore`, `git reset`, `git stash`, `git push`",
  "- Package managers that touch disk: `bun install`, `bun add`, `npm install`, `npm ci`, `npm i`, `pnpm install`, `pnpm add`, `yarn`, `yarn add`",
  "- Build / lint / format / test runners: `bun run build`, `npm run build`, `bun run lint`, `bun run fmt`, `bun run test`, `npx …`, `pnpm exec …`, `yarn …`",
  "- PR / issue mutators: `gh pr create`, `gh pr edit`, `gh issue create`, `gh issue comment`",
].join("\n");

const ALLOWED_READONLY_BASH_LIST = [
  "- `ls`, `ls -la`, `ls -R`",
  "- `cat`, `head`, `tail`, `wc`, `file`, `stat`",
  "- `find … -type f …` (without any `-delete` or `-exec … {}` that mutates)",
  "- `grep`, `rg`, `egrep`, `fgrep`",
  "- `git log`, `git diff`, `git show`, `git status`, `git remote -v`, `git branch --list`, `git ls-files`, `git blame`",
  "- `pwd`, `echo` (for printing to stdout only, never redirected to a file)",
  "- `test -f <path>` (existence checks only)",
  "",
  "Plus these two Crucible CLIs (which DO have side-effects, but are the only mutating commands you are permitted to run):",
  "- `spawn-subtask` (documented below under YOUR TOOLS)",
  "- `subtask-status` (documented below under YOUR TOOLS)",
].join("\n");

function formatAgentBrowserManagerNote(): string {
  return `
### agent-browser (available to child agents)

Your subtask agents have access to \`agent-browser\` for testing UI changes. You do not need to use it yourself; mention it in subtask prompts for UI work so children know to use it. Typical commands children will run:

- \`agent-browser open <url>\` - navigate to a page
- \`agent-browser snapshot -ic\` - accessibility tree (interactive + compact)
- \`agent-browser screenshot <path>\` - save a screenshot
- \`agent-browser click @e1\` / \`agent-browser fill @e1 "text"\` - interact
- \`agent-browser close\` - tear down the browser

Tell children to screenshot at least once after any UI change so reviewers can verify visually.
`;
}

function formatAgentBrowserTaskBlock(): string {
  return `
## UI VERIFICATION NOTES (use agent-browser)

Snapshots cost ~200-400 tokens vs ~3000-5000 for raw DOM, so prefer them over scraping HTML. Always take at least one screenshot after making UI changes so your work can be verified. Commit screenshots only if the repo already tracks image assets under a similar path; otherwise leave them under \`.crucible/progress/\` and reference them by path in the PR body.
`;
}

function formatProgressJsonTemplate(params: TaskPromptParams): string {
  return `{
  "runId": "${params.runId}",
  "issueNumber": ${params.issueNumber},
  "repo": "${params.repo}",
  "branch": "${params.taskBranch}",
  "subtask": "<one-line summary of what this subtask did>",
  "filesChanged": ["<path1>", "<path2>"],
  "commitSha": "<output of git rev-parse HEAD>",
  "qualityGates": {
    "fmt": "<pass|skip|fail>",
    "lint": "<pass|skip|fail>",
    "typecheck": "<pass|skip|fail>",
    "tests": "<pass|skip|fail>"
  },
  "status": "ok",
  "completedAt": "<ISO-8601 timestamp>"
}`;
}
