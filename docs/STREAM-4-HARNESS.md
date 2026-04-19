# Stream 4: Harness — Orchestration, Prompts & Eval

## Goal

Build the intelligence layer: manager and task agent prompt templates, the `.crucible` directory structure for target repos, the `crucible-init` bootstrap script, agent-browser integration instructions, and a named eval task set. This stream makes agents effective, not just functional.

Read `docs/OVERVIEW.md` first for full project context, shared data types, and the API contract.

## MaaS Parameters Owned

- **Agent org structure (5x):** L3 → L5. The prompt templates define the roles. L3 = "Clear roles (manager + specialists), static routing." L5 = "Emergent: manager spawns sub-specialists on the fly, agents escalate when stuck, roles self-adjust." Our architecture with `spawn-subtask` CLI IS the L5 pattern — but only if the prompts make it work.
- **Eval & iteration (5x):** L3 = "Named eval set exists, run manually to compare versions." We need 3-5 defined tasks with expected outcomes and a way to run them.
- **Handoffs & memory (2x):** L3 = "Short-term memory within a single task." Free (opencode sessions maintain context). Document it in submission.
- **Real output (20x):** The prompt quality determines whether agents ship or fumble. This stream is the highest-leverage work for the root parameter.

## File Ownership

### Files this stream CREATES

| File                                  | Action                                      |
| ------------------------------------- | ------------------------------------------- |
| `apps/server/src/crucible/prompts.ts` | NEW — prompt template functions             |
| `apps/server/src/crucible/eval.ts`    | NEW — eval task definitions + runner        |
| `scripts/crucible-init.ts`            | NEW — bootstrap .crucible/ in a target repo |
| `.crucible-template/config.json`      | NEW — template                              |
| `.crucible-template/init.sh`          | NEW — template                              |
| `.crucible-template/agents.md`        | NEW — template                              |
| `.crucible-template/eval/tasks.json`  | NEW — template                              |

### Files this stream DOES NOT TOUCH

- `apps/web/` — all UI is Streams 2+3
- `apps/server/src/crucible/http.ts` — Stream 1 owns; this stream provides modules that Stream 1 wires in
- Route files
- `scripts/spawn-subtask.ts` — Stream 1 owns updates
- `scripts/subtask-status.ts` — Stream 1 creates

## Integration with Stream 1

This stream exports modules. Stream 1 imports and wires them into HTTP routes.

**Contract:**

From `prompts.ts`:

```typescript
export function buildManagerPrompt(params: ManagerPromptParams): string;
export function buildTaskPrompt(params: TaskPromptParams): string;
```

From `eval.ts`:

```typescript
export const EVAL_TASKS: EvalTask[];
export function checkEvalOutcome(task: EvalTask, runDirectory: string): Promise<EvalResult>;
```

Stream 1 replaces the hardcoded planner prompt in `crucible/http.ts` with `buildManagerPrompt(...)`. Stream 1 adds a `POST /api/crucible/eval/run` endpoint that imports `EVAL_TASKS` and `checkEvalOutcome`.

## Detailed Requirements

### 1. `prompts.ts` — Manager Prompt Template

The manager agent receives an issue and decomposes it into subtasks. **It must NOT write code directly.** This is the load-bearing prompt — if the manager ignores the CLI tools and writes code itself (Failure Mode 1 from Stage 0b testing), the whole product fails.

```typescript
export interface ManagerPromptParams {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  repo: string; // "owner/name"
  repoPath: string; // absolute path on disk
  spawnCommand: string; // "bun /path/to/spawn-subtask.ts"
  statusCommand: string; // "bun /path/to/subtask-status.ts"
  runId: string; // this manager's run ID
  agentBrowserAvailable: boolean;
}

export function buildManagerPrompt(params: ManagerPromptParams): string {
  return `You are a senior engineering manager agent. Your job is to decompose a GitHub issue into subtasks and delegate each to a specialist agent.

## CRITICAL RULES — READ THESE FIRST

1. You must NOT use bash, write, edit, or any tool to modify files in this directory.
2. The ONLY way to produce work output is by calling \`spawn-subtask\`.
3. You MAY use bash for READ-ONLY commands to understand the codebase: ls, cat, find, grep, git log, git diff. But NEVER to modify files, create files, or run build/test commands.
4. Do not create any files in your own directory.
5. Do not attempt to do the coding work yourself.

## YOUR TOOLS

### spawn-subtask
Spawns a new specialist agent to work on a subtask.

\`\`\`bash
${params.spawnCommand} --parent-run-id ${params.runId} --repo ${params.repo} "<detailed prompt for the subtask>"
\`\`\`

The prompt you give to spawn-subtask should be detailed and self-contained. Include:
- What to implement
- Which files to modify
- Expected behavior
- How to test/verify the change
- The issue number for the PR body

### subtask-status
Polls the status of your spawned subtasks.

\`\`\`bash
${params.statusCommand} --run-id ${params.runId}
\`\`\`

Returns JSON with the status of all children. Exit code 0 = all done, 1 = error, 2 = still running.

${
  params.agentBrowserAvailable
    ? `### agent-browser (available to your subtask agents)
Your subtask agents have access to \`agent-browser\` for testing UI changes. You don't need to use it yourself — mention it in your subtask prompts when the task involves UI work. Tell agents to use:
- \`agent-browser open <url>\` — open a page
- \`agent-browser snapshot -ic\` — get interactive elements
- \`agent-browser screenshot <path>\` — capture screenshot
- \`agent-browser close\` — close browser
`
    : ""
}

## THE ISSUE

**Issue #${params.issueNumber}: ${params.issueTitle}**

${params.issueBody}

## YOUR TASK

1. First, explore the repository to understand its structure. Use read-only bash commands:
   - \`ls -la\` to see the project root
   - \`cat README.md\` if it exists
   - \`cat .crucible/agents.md\` if it exists (this is a guide for agents)
   - \`find . -name "*.ts" -o -name "*.tsx" | head -30\` to see file structure

2. Based on your understanding, decompose the issue into 2-4 subtasks. Each subtask should be:
   - Small enough for one agent to complete in 5-10 minutes
   - Self-contained (agent can work without knowing about other subtasks)
   - Concrete (specific files to modify, specific behavior to implement)

3. For each subtask, call spawn-subtask with a detailed prompt.

4. After spawning all subtasks, poll subtask-status every 30 seconds until all children report "completed" or "error".

5. When all children are done, summarize what was accomplished and report any errors.

## IMPORTANT: PR CREATION

Each subtask agent will create its own PR with \`gh pr create --repo ${params.repo}\`. You do not need to create PRs yourself. Each PR body should include "Closes #${params.issueNumber}" so the issue gets closed when merged.

## OUTPUT FORMAT

Start by stating your decomposition plan, then execute it. Example:

"I'll decompose this into 3 subtasks:
1. [subtask description]
2. [subtask description]
3. [subtask description]

Spawning subtask 1..."`;
}
```

### 2. `prompts.ts` — Task Agent Prompt Template

The task agent is a specialist that implements one subtask.

```typescript
export interface TaskPromptParams {
  subtaskDescription: string;
  repo: string; // "owner/name"
  repoPath: string; // absolute path on disk
  issueNumber: number;
  agentBrowserAvailable: boolean;
  initScript?: string; // path to .crucible/init.sh if it exists
}

export function buildTaskPrompt(params: TaskPromptParams): string {
  return `You are a specialist software engineer. You have one focused task to complete.

## YOUR TASK

${params.subtaskDescription}

## CONTEXT

This is a subtask for Issue #${params.issueNumber} in the ${params.repo} repository.

## SETUP

${
  params.initScript
    ? `A setup script exists at \`${params.initScript}\`. Run it first:
\`\`\`bash
bash ${params.initScript}
\`\`\`
This will install dependencies and may start a dev server.`
    : `No setup script found. Check for package.json and install dependencies if needed:
\`\`\`bash
if [ -f package.json ]; then npm install; fi
\`\`\``
}

## WORKING IN YOUR WORKTREE

You are working in an isolated git worktree. Your changes won't affect other agents.

1. Create a new branch for your work:
   \`\`\`bash
   git checkout -b crucible/task-$(date +%s)
   \`\`\`

2. Implement the changes described above.

3. Run any existing linters or test suites:
   \`\`\`bash
   if [ -f package.json ]; then
     npm run lint 2>/dev/null || true
     npm run test 2>/dev/null || true
   fi
   \`\`\`

${
  params.agentBrowserAvailable
    ? `## TESTING WITH AGENT-BROWSER

You have access to \`agent-browser\` for testing UI changes. Use it to verify your work:

\`\`\`bash
# Open the dev server (adjust URL based on what init.sh starts)
agent-browser open http://localhost:3000

# See what's on the page
agent-browser snapshot -ic

# Take a screenshot to verify visual changes
agent-browser screenshot ./screenshot.png

# Interact with elements using refs from snapshot
agent-browser click @e1
agent-browser fill @e2 "test input"

# Close when done
agent-browser close
\`\`\`

Always take at least one screenshot after making UI changes so your work can be verified.
`
    : ""
}

## CREATING THE PR

When your work is complete and passing linters/tests:

\`\`\`bash
git add -A
git commit -m "<concise description of what you did>"
gh pr create \\
  --repo ${params.repo} \\
  --title "<short title>" \\
  --body "Closes #${params.issueNumber}

## Changes
<bullet points describing what changed>

## Testing
<how you verified the changes>"
\`\`\`

## QUALITY CHECKLIST

Before creating the PR:
- [ ] Code compiles without errors
- [ ] Linter passes (or no linter configured)
- [ ] Changes are minimal and focused on the subtask
- [ ] No unrelated files modified
- [ ] Commit message is descriptive
- [ ] PR body includes "Closes #${params.issueNumber}"`;
}
```

### 3. `.crucible-template/` — Template Directory

Create this at the crucible repo root. The `crucible-init` script copies it into target repos.

**`.crucible-template/config.json`:**

```json
{
  "name": "",
  "initScript": ".crucible/init.sh",
  "agentBrowserAvailable": true,
  "maxConcurrentAgents": 8,
  "maxDepth": 3,
  "timeoutMinutes": 10
}
```

**`.crucible-template/init.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Crucible environment setup script
# This runs at the start of every agent session in this repo.
# Customize for your project.

echo "Setting up development environment..."

# Detect package manager and install dependencies
if [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
  echo "Installing dependencies with bun..."
  bun install
elif [ -f "pnpm-lock.yaml" ]; then
  echo "Installing dependencies with pnpm..."
  pnpm install
elif [ -f "yarn.lock" ]; then
  echo "Installing dependencies with yarn..."
  yarn install
elif [ -f "package-lock.json" ] || [ -f "package.json" ]; then
  echo "Installing dependencies with npm..."
  npm install
fi

echo "Setup complete."
```

**`.crucible-template/agents.md`:**

```markdown
# Agent Guide for this Repository

> This file is the entry point for AI agents working on this codebase.
> Keep it short — point to deeper docs, don't replicate them.

## Quick Start

1. Run `.crucible/init.sh` to set up the development environment.
2. Check this repo's README.md for project overview.

## Architecture

<!-- Fill in: what framework, key directories, how the app is structured -->

## Key Files

<!-- Fill in: the most important files an agent should know about -->

## Testing

<!-- Fill in: how to run tests, what test framework -->

## Conventions

<!-- Fill in: code style, naming, patterns to follow -->

## Common Pitfalls

<!-- Fill in: things agents tend to get wrong in this repo -->
```

**`.crucible-template/eval/tasks.json`:**

```json
{
  "version": 1,
  "description": "Eval tasks for this repository. Run manually to compare agent versions.",
  "tasks": []
}
```

### 4. `scripts/crucible-init.ts` — Bootstrap Script

Initializes `.crucible/` in a target repo.

```typescript
#!/usr/bin/env bun

/**
 * crucible-init — Initialize a .crucible/ directory in a target repository.
 *
 * Usage:
 *   bun scripts/crucible-init.ts [--repo-path /path/to/repo]
 *
 * If --repo-path is not provided, uses the current working directory.
 *
 * What it does:
 * 1. Copies .crucible-template/ into <repo>/.crucible/
 * 2. Auto-fills config.json with repo name from git remote
 * 3. Makes init.sh executable
 * 4. Detects package manager and updates init.sh accordingly
 */

import { parseArgs } from "node:util";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";

const { values } = parseArgs({
  options: {
    "repo-path": { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(`crucible-init — Initialize .crucible/ in a target repository.

Usage:
  bun scripts/crucible-init.ts [--repo-path /path/to/repo]

Options:
  --repo-path   Path to the target repo (default: cwd)
  --help        Show this help`);
  process.exit(0);
}

const repoPath = resolve(values["repo-path"] ?? process.cwd());
const templateDir = join(dirname(import.meta.dir), ".crucible-template");
const targetDir = join(repoPath, ".crucible");

// Implementation:
// 1. Check if .crucible/ already exists
// 2. Copy template files
// 3. Run `git remote get-url origin` to get repo name
// 4. Parse owner/name from remote URL
// 5. Update config.json with repo name
// 6. chmod +x init.sh
// 7. Print summary
```

The implementation should:

- Be idempotent (safe to run multiple times)
- Not overwrite existing `agents.md` if already customized (check if it differs from template)
- Always overwrite `config.json` with fresh repo metadata
- Print clear output about what was created/updated

### 5. `eval.ts` — Eval Task Definitions & Runner

This module defines the eval tasks and provides functions to check outcomes. It does NOT define HTTP routes — Stream 1 wires it into the API.

```typescript
export interface EvalTask {
  id: string;
  description: string;
  repo: string; // "owner/name"
  issueTitle: string;
  issueBody: string;
  expectedOutcome: EvalOutcome;
}

export type EvalOutcome =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; content: string }
  | { type: "pr_created"; titleContains?: string }
  | { type: "command_succeeds"; command: string };

export interface EvalResult {
  taskId: string;
  passed: boolean;
  duration: number; // milliseconds
  details: string; // human-readable explanation
}

/**
 * Default eval tasks for manikrana.dev (the seed repo).
 * These are synthetic issues designed to test the agent pipeline.
 */
export const EVAL_TASKS: EvalTask[] = [
  {
    id: "eval-01-readme-section",
    description: "Agent adds a new section to README",
    repo: "Maniktherana/manikrana.dev",
    issueTitle: "Add a 'Tech Stack' section to README",
    issueBody: `Add a "Tech Stack" section to README.md that lists the main technologies used in this project.

Requirements:
- Add the section after the existing introduction
- Include at least the framework, styling, and deployment platform
- Use a markdown list format`,
    expectedOutcome: {
      type: "file_contains",
      path: "README.md",
      content: "Tech Stack",
    },
  },
  {
    id: "eval-02-new-component",
    description: "Agent creates a new UI component",
    repo: "Maniktherana/manikrana.dev",
    issueTitle: "Create a Footer component",
    issueBody: `Create a Footer component for the website.

Requirements:
- Create a new component file (Footer.tsx or Footer.jsx or Footer.astro depending on the framework)
- Include copyright text with the current year
- Include a link to the GitHub repo
- Style it to match the existing site design`,
    expectedOutcome: {
      type: "file_exists",
      path: "src/components/Footer", // partial match
    },
  },
  {
    id: "eval-03-config-change",
    description: "Agent modifies a configuration file",
    repo: "Maniktherana/manikrana.dev",
    issueTitle: "Add meta description to site config",
    issueBody: `Update the site configuration to include a meta description.

Requirements:
- Find the site config/metadata file
- Add or update the description field to: "Manik Rana's personal website and portfolio"
- Ensure it shows up in the HTML <meta> tag`,
    expectedOutcome: {
      type: "file_contains",
      path: "", // will search common config files
      content: "personal website",
    },
  },
];

/**
 * Check if an eval task's expected outcome was achieved.
 * Called after a run completes against the run's working directory.
 */
export async function checkEvalOutcome(task: EvalTask, runDirectory: string): Promise<EvalResult> {
  const start = Date.now();

  // Implementation:
  // For "file_exists": check if the file exists (glob match if partial path)
  // For "file_contains": read the file, check if content string is present
  // For "pr_created": run `gh pr list --repo <repo> --json title` and check
  // For "command_succeeds": run the command in the directory, check exit code

  // Return { taskId: task.id, passed, duration: Date.now() - start, details }
}
```

### 6. Readiness Check Logic

The manager agent's first step is checking if the target repo is "ready." Define what this means:

Add to `prompts.ts`:

```typescript
/**
 * Instructions for the manager to check repo readiness.
 * Included in the manager prompt.
 */
export function buildReadinessInstructions(repoPath: string): string {
  return `## READINESS CHECK

Before spawning subtasks, verify the repository is ready:

1. Check if \`.crucible/agents.md\` exists:
   \`\`\`bash
   cat ${repoPath}/.crucible/agents.md 2>/dev/null
   \`\`\`
   If it exists, read it for context about the codebase.

2. Check if \`.crucible/init.sh\` exists:
   \`\`\`bash
   ls -la ${repoPath}/.crucible/init.sh 2>/dev/null
   \`\`\`
   If it exists, note this in your subtask prompts so agents run it on startup.

3. Check for a README:
   \`\`\`bash
   cat ${repoPath}/README.md 2>/dev/null | head -50
   \`\`\`

4. Check the project structure:
   \`\`\`bash
   find ${repoPath} -maxdepth 2 -type f -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.astro" -o -name "*.vue" -o -name "*.svelte" | head -30
   \`\`\`

Use what you learn to write better subtask prompts. The more context you give each subtask agent, the better their output will be.`;
}
```

## Agent-Browser Integration Notes

`agent-browser` (v latest, installed at `/opt/homebrew/bin/agent-browser`) is a Rust CLI for browser automation. Key commands for agents:

| Command                           | What it does                              | Tokens used               |
| --------------------------------- | ----------------------------------------- | ------------------------- |
| `agent-browser open <url>`        | Navigate to URL                           | ~50                       |
| `agent-browser snapshot -ic`      | Accessibility tree, interactive + compact | ~200-400                  |
| `agent-browser screenshot <path>` | Save screenshot                           | ~50 (output is file path) |
| `agent-browser click @e1`         | Click element by ref                      | ~50                       |
| `agent-browser fill @e1 "text"`   | Fill input field                          | ~50                       |
| `agent-browser close`             | Close browser                             | ~20                       |

**Context efficiency:** Snapshots use ~200-400 tokens vs ~3000-5000 for full DOM. This is why agent-browser is preferred over raw Puppeteer/Playwright in agent contexts.

**Sessions:** Each `agent-browser` invocation within a process shares a browser daemon. Multiple agents can use separate sessions with `--session <name>`.

**Integration:** agents call it via bash. No MCP server needed. OpenCode sessions have bash by default.

In task agent prompts, include the agent-browser usage guide (see `buildTaskPrompt` above). The key instruction: "Always take at least one screenshot after making UI changes so your work can be verified."

Screenshots saved by agents will be visible in the detail panel via `GET /api/crucible/files?path=<path>` (Stream 1 serves them, Stream 3 renders them).

## Scoring Breakdown

### Agent Org Structure (5x)

| Level       | Requirement                                                            | Our Status                                                           |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| L3 (10 pts) | Clear roles (manager + specialists), static routing                    | Manager prompt strictly delegates; task agents implement             |
| L4 (15 pts) | Dynamic: manager plans subtasks based on specific request              | Manager reads issue + repo structure, decides decomposition          |
| L5 (20 pts) | Emergent: manager spawns sub-specialists on the fly, roles self-adjust | Manager uses spawn-subtask CLI — spawning is emergent, not hardcoded |

**Our target: L5.** The architecture supports it. The prompt must make it real.

### Eval & Iteration (5x)

| Level       | Requirement                                             | Our Status                                            |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------- |
| L3 (10 pts) | Named eval set exists, run manually to compare versions | `EVAL_TASKS` array + `POST /api/crucible/eval/run`    |
| L4 (15 pts) | Automated eval pipeline, CI-style                       | Stretch: add a script that runs all evals and reports |
| L5 (20 pts) | Closed-loop: failed runs feed growing eval set          | Stretch: auto-generate new eval tasks from failures   |

**Our target: L3 (solid).** L4 if time permits.

### Handoffs & Memory (2x)

| Level      | Requirement                            | Our Status                                                 |
| ---------- | -------------------------------------- | ---------------------------------------------------------- |
| L3 (4 pts) | Short-term memory within a single task | Free — opencode sessions maintain full context             |
| L4 (6 pts) | Persistent memory across tasks         | Stretch: .crucible/memory.json persisting learned patterns |

**Our target: L3.** Document it in submission.

## Verification

```bash
# Type check the new modules
bun typecheck

# Verify prompt templates produce valid strings
bun -e "import { buildManagerPrompt } from './apps/server/src/crucible/prompts.ts'; console.log(buildManagerPrompt({ issueNumber: 1, issueTitle: 'Test', issueBody: 'body', repo: 'owner/repo', repoPath: '/tmp/test', spawnCommand: 'bun spawn-subtask.ts', statusCommand: 'bun subtask-status.ts', runId: 'run-123', agentBrowserAvailable: true }).length, 'chars')"

# Verify eval tasks are well-formed
bun -e "import { EVAL_TASKS } from './apps/server/src/crucible/eval.ts'; console.log(EVAL_TASKS.length, 'tasks defined')"

# Test crucible-init (on a temp repo)
mkdir -p /tmp/test-repo && cd /tmp/test-repo && git init
bun scripts/crucible-init.ts --repo-path /tmp/test-repo
ls -la /tmp/test-repo/.crucible/
```

## The Prompt Engineering Problem (Why This Stream Matters Most)

From the Stage 0b diagnostic: children spawned correctly, but the manager ALSO wrote files directly. Root cause: prompt engineering, not infrastructure. The manager had bash/write/edit tools available and took the easier path (write directly) alongside the delegation path.

The fix is in the prompt:

1. **Explicit prohibition:** "You must NOT use bash, write, or edit tools to modify files."
2. **Tool documentation:** Clear syntax for spawn-subtask with examples.
3. **Completion criteria:** "Poll subtask-status until all children done. Then reply with summary."
4. **Behavioral forcing function:** The manager's working directory should ideally be empty or read-only so direct writes would fail even if attempted.

This prompt must be tested end-to-end before the demo. A clean pass = parent directory empty after run, children created expected output, parent event stream shows only spawn-subtask + subtask-status tool calls.
