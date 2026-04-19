# Crucible — Project Overview

## What We're Building

Crucible is a kanban-based multi-agent SWE team. It pulls real GitHub issues from a target repository, lets a manager agent decompose each issue into subtasks, spawns specialist child agents (opencode sessions) to work on each subtask in isolated git worktrees, and ships real pull requests. The entire process is observable in a clean kanban UI.

**One sentence:** GitHub issues go in, real PRs come out, and you watch the whole thing happen on a kanban board.

## Origin

Crucible is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (OSS). T3 Code is a single-agent chat UI wrapping coding agents. We turned it into a self-organizing multi-agent team that ships real PRs.

Built for the **OpenCode Buildathon** (GrowthX, India) — **MaaS track** (Multi-Agent as a Service).

## Core Architecture

```
Browser (Kanban UI)
    │
    ├── GET /api/crucible/repos/:owner/:name/issues   ← GitHub issues → Todo column
    ├── POST /api/crucible/runs                        ← Start manager agent
    ├── GET /api/crucible/runs?repo=owner/name         ← Poll run status (2s)
    ├── GET /api/crucible/runs/:runId                  ← Run detail + events
    └── GET /api/crucible/files?path=...               ← Screenshots from agent-browser
         │
    Crucible Server (Effect HTTP, evolved from t3code)
         │
         ├── OpenCode Server (:4096) — one process, N sessions
         ├── Manager session (decomposes issue, spawns children via CLI)
         ├── Child sessions (one per subtask, own git worktree)
         ├── spawn-subtask CLI (scripts/spawn-subtask.ts)
         ├── subtask-status CLI (scripts/subtask-status.ts)
         ├── agent-browser CLI (children test UI changes)
         └── gh CLI (children create PRs)
```

## Key Concepts

### The Harness, Not the Model

The model is a commodity. The harness — the tools, context, feedback loops, and scaffolding — determines what the model can actually accomplish. This is the central lesson from the SWE-agent paper (64% performance lift from interface design alone), Anthropic's Claude Code harness engineering, and OpenAI's Codex internal tooling.

Crucible applies this by:

- **Purpose-built CLIs over raw shell.** `spawn-subtask` and `subtask-status` are the agent's tools for delegation. The manager doesn't use bash to organize work.
- **Progressive disclosure.** Agents get a short entry point (`.crucible/agents.md`) pointing to deeper context, not a monolithic dump.
- **Integrated feedback loops.** Children use `agent-browser` to visually verify UI changes. Linting on edit is built into opencode. `gh pr create` with CI checks closes the validation loop.
- **Repository as system of record.** The target repo's `.crucible/` directory is the map. Anything not in the repo doesn't exist to the agent.
- **Git worktree isolation.** One agent, one worktree. No stepping on each other's changes.
- **Emergent decomposition.** The manager reasons about how to decompose. We don't hardcode task structure.

### Agent Hierarchy

```
Manager Agent (per issue)
  ├── Reads issue, checks .crucible/ readiness
  ├── Decomposes into subtasks
  ├── Calls spawn-subtask for each
  ├── Polls subtask-status until all done
  └── Does NOT write code itself

Task Agent (per subtask)
  ├── Gets own git worktree
  ├── Runs .crucible/init.sh if present
  ├── Implements the subtask
  ├── Uses agent-browser for UI testing
  ├── Runs linters/tests
  └── Creates PR via gh pr create
```

### `.crucible/` Directory (per target repo)

```
.crucible/
  config.json         — repo metadata, init script path
  init.sh             — environment setup (install deps, start dev server)
  agents.md           — progressive disclosure entry point for agents
  eval/
    tasks.json        — named eval task set for iteration scoring
```

## MaaS Scoring — Minimum Working Requirements

We must hit **L3 on every parameter** before pushing anything to L4/L5. L3 across all = 82 base points.

| Parameter               | Weight       | L3 Requirement                                               | How Crucible Hits It                                                      |
| ----------------------- | ------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **Real output**         | 20x (40 pts) | Working output on staged/test surface                        | Agents write code, create PRs on `manikrana.dev` repo                     |
| **Agent org structure** | 5x (10 pts)  | Clear roles (manager + specialists), static routing          | Manager prompt strictly delegates via CLI; children execute               |
| **Observability**       | 7x (14 pts)  | Pull up a specific run, see what each agent did step by step | Card detail panel: run tree + per-run event stream                        |
| **Eval & iteration**    | 5x (10 pts)  | Named eval set exists, run manually                          | `eval/tasks.json` with 3-5 synthetic tasks, `POST /api/crucible/eval/run` |
| **Handoffs & memory**   | 2x (4 pts)   | Short-term memory within a single task                       | Each opencode session maintains context within its run                    |
| **Cost & latency**      | 1x (2 pts)   | 5-10 min OR $0.50-$2 per task                                | Scoped subtasks naturally complete in this range                          |
| **Management UI**       | 1x (2 pts)   | Functional UI, a PM could operate with docs                  | Kanban board with repo selector, start button, status indicators          |

**L4+ Targets (after L3 locked):**

| Parameter          | L4/L5 Target                                                    | Points    |
| ------------------ | --------------------------------------------------------------- | --------- |
| Real output (20x)  | L4: PRs on real repo, team babysits → L5: autonomous end-to-end | 60-80 pts |
| Agent org (5x)     | L5: Emergent spawning (our CLI architecture IS L5)              | 20 pts    |
| Observability (7x) | L4: Trace tree across agents, per-step token/cost               | 21 pts    |

**Realistic target: 95-120 points.**

## Tech Stack

| Layer           | Tech                                                     |
| --------------- | -------------------------------------------------------- |
| Monorepo        | Bun + Turbo                                              |
| Server          | Effect 4, Bun HTTP server                                |
| Web             | React 19, Vite 8, TanStack Router + Query, Tailwind 4    |
| UI Primitives   | shadcn-style components in `apps/web/src/components/ui/` |
| Agent Runtime   | OpenCode (`opencode serve` → HTTP API + SSE)             |
| Browser Testing | `agent-browser` (Vercel, Rust CLI)                       |
| GitHub          | `gh` CLI (issues + PRs)                                  |
| State           | Zustand (client), in-memory Map (server, survives HMR)   |

## Repo Structure (what matters)

```
crucible/
├── docs/                           ← you are here
│   ├── OVERVIEW.md
│   ├── STREAM-1-BACKEND.md
│   ├── STREAM-2-KANBAN.md
│   ├── STREAM-3-DETAIL-PANEL.md
│   └── STREAM-4-HARNESS.md
├── apps/
│   ├── server/src/
│   │   ├── crucible/http.ts        ← all crucible API endpoints (renamed from orwell/)
│   │   ├── crucible/prompts.ts     ← prompt templates
│   │   ├── crucible/eval.ts        ← eval task definitions
│   │   ├── server.ts               ← mounts routes into Effect HTTP server
│   │   └── provider/Layers/OpenCodeAdapter.ts  ← opencode session management
│   └── web/src/
│       ├── routes/
│       │   ├── __root.tsx          ← root layout (modify: CrucibleLayout)
│       │   ├── _chat.index.tsx     ← "/" route (modify: render kanban)
│       │   └── _chat.$environmentId.$threadId.tsx  ← existing chat (keep)
│       └── components/crucible/
│           ├── types.ts            ← shared data model
│           ├── useCrucibleStore.ts ← zustand state
│           ├── CrucibleLayout.tsx  ← top bar + content area
│           ├── TopBar.tsx          ← branding + repo selector
│           ├── KanbanBoard.tsx     ← 3-column board
│           ├── KanbanColumn.tsx    ← single column
│           ├── IssueCard.tsx       ← card component
│           ├── RepoSelector.tsx    ← repo dropdown + clone
│           ├── CardDetailPanel.tsx ← right panel (observability surface)
│           ├── RunTreeView.tsx     ← parent/child run tree
│           ├── EventStreamView.tsx ← per-run event timeline
│           ├── SessionChatView.tsx ← chat-style message rendering
│           ├── AgentBrowserPreview.tsx ← inline screenshots
│           └── RunStatusBadge.tsx  ← status indicators
├── scripts/
│   ├── spawn-subtask.ts            ← CLI for manager to spawn children
│   ├── subtask-status.ts           ← CLI for manager to poll children
│   └── crucible-init.ts            ← initialize .crucible/ in a target repo
└── .crucible-template/             ← template for target repos
    ├── config.json
    ├── init.sh
    ├── agents.md
    └── eval/tasks.json
```

## Parallel Build Streams

| Stream              | Scope                                                          | Key Files                                                                                    |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **1. Backend API**  | Rename orwell→crucible, add repo/issue/file endpoints, CLIs    | `apps/server/src/crucible/`, `scripts/`                                                      |
| **2. Kanban Board** | Layout, top bar, repo selector, kanban columns, cards          | `apps/web/src/routes/`, `components/crucible/{Layout,Board,Card,Repo}*`                      |
| **3. Detail Panel** | Right panel, run tree, event stream, agent-browser preview     | `components/crucible/{CardDetail,RunTree,EventStream,AgentBrowser,Session}*`                 |
| **4. Harness**      | Prompt templates, .crucible structure, eval set, crucible-init | `crucible/prompts.ts`, `crucible/eval.ts`, `.crucible-template/`, `scripts/crucible-init.ts` |

See individual stream docs for full specifications.

## Shared API Contract

All streams build against this contract. Backend (Stream 1) implements it. Frontend (Streams 2+3) consumes it. Harness (Stream 4) provides prompt/eval modules that Stream 1 wires in.

```
GET  /api/crucible/config
  → { workspaceDir, repos: CrucibleRepo[], opencode: { enabled, binaryPath, hasExternalServer } }

GET  /api/crucible/repos
  → { repos: CrucibleRepo[] }

POST /api/crucible/repos/clone
  body: { url: string }
  → CrucibleRepo

GET  /api/crucible/repos/:owner/:name/issues
  → { issues: CrucibleIssue[] }

POST /api/crucible/runs
  body: { repo, issueNumber?, prompt, directory?, type?, plannerMode?, parentRunId?,
          spawnCommand?, spawnTool?, spawnNote? }
  → CrucibleRun  (202)

GET  /api/crucible/runs?repo=owner/name
  → { runs: CrucibleRun[] }

GET  /api/crucible/runs/:runId
  → CrucibleRun

GET  /api/crucible/files?path=<absolute-path>
  → file contents (appropriate content-type)

POST /api/crucible/eval/run
  body: { taskIds?: string[] }
  → { results: [{ taskId, passed, duration, cost? }] }
```

## Shared Data Types

```typescript
interface CrucibleIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  state: "open" | "closed";
  url: string;
  html_url: string;
}

type CrucibleRunStatus = "starting" | "running" | "completed" | "error";
type CrucibleRunType = "manager" | "task";

interface CrucibleRunEvent {
  id: string;
  at: string;
  type: string;
  summary: string;
  payload: unknown;
}

interface CrucibleRun {
  id: string;
  type: CrucibleRunType;
  issueNumber?: number;
  repo: string;
  status: CrucibleRunStatus;
  parentRunId?: string;
  childRunIds: string[];
  sessionId?: string;
  directory: string;
  prompt: string;
  events: CrucibleRunEvent[];
  createdAt: string;
  updatedAt: string;
  prUrl?: string;
  error?: string;
}

type KanbanColumnId = "todo" | "in_progress" | "done";

interface KanbanCard {
  issue: CrucibleIssue;
  column: KanbanColumnId;
  managerRun?: CrucibleRun;
  taskRuns: CrucibleRun[];
}

interface CrucibleRepo {
  name: string; // "owner/repo"
  path: string; // absolute path on disk
  hasGit: boolean;
}
```

## Dev Commands

```bash
bun install          # install deps
bun run dev          # start dev server (web + server)
bun fmt              # format (oxfmt)
bun lint             # lint (oxlint)
bun typecheck        # type check
bun run test         # run tests (vitest) — NEVER use `bun test`
```

## Rules of Engagement (for agents working on this)

1. `bun fmt`, `bun lint`, and `bun typecheck` must all pass before work is considered done.
2. Never run `bun test`. Always use `bun run test`.
3. Don't touch files owned by other streams (see stream docs for file ownership).
4. Use existing `apps/web/src/components/ui/` primitives — don't install new UI libraries.
5. Server follows Effect `HttpRouter.add(...)` patterns. Look at existing routes for reference.
6. Keep `packages/contracts` schema-only (no runtime logic).
7. Shared runtime utilities go in `packages/shared` with explicit subpath exports.
