# Crucible

GitHub issues go in, real PRs come out.

Crucible is a kanban-based multi-agent SWE team. It pulls real GitHub issues from a target repository, decomposes each issue with a manager agent, spawns specialist child agents in isolated git worktrees, and ships real pull requests. Watch the entire process in a chat-style detail view.

## Quick Start


```bash
git clone https://github.com/Maniktherana/crucible.git
bun install
bun dev
```


Opens in your browser. Clone a GitHub repo, and its open issues appear as kanban cards. Click **Start** on any issue and agents take over.

### Requirements

- Node.js 22+ or Bun
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- [OpenCode](https://opencode.ai/) (`opencode`) — installed
- Optional: [Langfuse](https://langfuse.com/) keys for tracing (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`)

## How It Works

```
1. Clone a repo         -->  Issues populate the kanban Todo column
2. Click Start          -->  Manager agent decomposes the issue
3. Manager delegates    -->  Specialist agents spawn (own git worktrees)
4. Agents implement     -->  Code changes, linting, testing
5. Agents open PRs      -->  Real PRs on GitHub with "Closes #N"
6. Watch it all happen  -->  Chat view shows every tool call, edit, command
```

### Agent Hierarchy

```
Manager Agent (per issue)
  |-- Checks if repo is initialized (runs initializer if not)
  |-- Reads .crucible/agents.md for codebase context
  |-- Decomposes issue into 2-4 subtasks
  |-- Spawns task agents via spawn-subtask CLI
  +-- Polls until all children complete

Initializer Agent (once per repo)
  |-- Explores repo structure, framework, deps
  |-- Writes .crucible/agents.md (real content, not boilerplate)
  |-- Creates .crucible/init.sh (setup script)
  +-- Creates .crucible/feature-list.json

Task Agent (per subtask, own git worktree)
  |-- Reads .crucible/agents.md
  |-- Runs .crucible/init.sh
  |-- Implements the subtask
  |-- Tests with agent-browser (screenshots for UI work)
  |-- Runs linters and tests
  |-- Commits and opens PR
  +-- Records progress
```

### Onboarding

When you first run `bun dev`, the UI shows an onboarding screen with a **Clone Repository** button. Paste any GitHub repo URL (e.g. `https://github.com/owner/repo`) and Crucible clones it, fetches open issues, and populates the kanban board. No configuration needed.

### Harness Engineering

The model is a commodity. The harness determines what the model can accomplish.

Crucible applies key patterns from the SWE-agent paper (ACI design), Anthropic's Claude Code harness (initializer + coding agent architecture), and OpenAI's Codex internal tooling (progressive disclosure, mechanical enforcement):

- **Purpose-built CLIs** over raw shell (`spawn-subtask`, `subtask-status`)
- **Progressive disclosure** via `.crucible/agents.md` (short map, not monolith)
- **Git worktree isolation** (one agent, one worktree, zero conflicts)
- **Integrated feedback loops** (agent-browser for UI testing, linters on edit)
- **Repository as system of record** (`.crucible/` directory is the harness)
- **Emergent decomposition** (manager reasons about task structure, not hardcoded)

## CLI Reference

## Observability

Crucible tracks every agent action:

- **Kanban UI** — cards show live agent activity, status, PR links
- **Chat view** — rendering of agent thoughts, tool calls, file edits
- **Agent tree** — trace of who spawned whom (manager -> tasks)
- **NDJSON logs** — persistent event logs per run at `repos/.crucible-logs/`
- **Langfuse integration** — full trace spans with token/cost tracking (set env vars to enable)
- **GitHub status** — CI check results and PR merge state

## Cleanup

Reset all agent work while keeping repos and issues:

```bash
bun scripts/crucible-cleanup.ts --repo owner/name --dry-run  # preview
bun scripts/crucible-cleanup.ts --repo owner/name             # execute
```

Closes PRs, deletes crucible branches/worktrees, clears progress files and server state.

## Development

```bash
git clone https://github.com/Maniktherana/crucible
cd crucible
bun install
bun run dev
```

```bash
bun fmt          # format
bun lint         # lint
bun typecheck    # type check
bun run test     # run tests (vitest) — never use `bun test`
```

## Architecture

```
apps/server      Node.js server CLI (crucible-swe on npm)
apps/web         React/Vite UI (bundled into server dist)
apps/desktop     Electron desktop app
packages/contracts  Shared Effect/Schema contracts (schema-only)
packages/shared     Shared runtime utilities
packages/effect-acp  ACP protocol implementation
packages/client-runtime  Client-side runtime layer
```

Data is stored at `~/.crucible/` by default (override with `CRUCIBLE_HOME` env var or `--base-dir` flag).

## Built For

OpenCode Buildathon (GrowthX, India) — MaaS track.

## License

MIT
