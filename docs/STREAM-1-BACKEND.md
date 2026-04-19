# Stream 1: Backend API

## Goal

Rename the existing `/orwell` API to `/crucible`, then extend it with repo management, GitHub issue fetching, file serving, and eval endpoints. This stream provides the foundation all other streams consume.

Read `docs/OVERVIEW.md` first for full project context, shared data types, and the API contract.

## MaaS Parameters Owned

- **Cost & latency (1x):** L3 — scoped subtasks complete in 5-10 min range naturally
- **Real output (20x):** L3 infra — the run creation and event pipeline enables agents to ship

## File Ownership

### Files this stream CREATES or MODIFIES

| File                               | Action                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| `apps/server/src/crucible/http.ts` | Rename from `orwell/http.ts` + extend with new endpoints  |
| `apps/server/src/orwell/http.ts`   | DELETE after moving to `crucible/`                        |
| `apps/server/src/server.ts`        | Update imports: `orwell/*` → `crucible/*`                 |
| `scripts/spawn-subtask.ts`         | Update: rename orwell refs → crucible, fix absolute paths |
| `scripts/subtask-status.ts`        | NEW                                                       |

### Files this stream DOES NOT TOUCH

- Anything in `apps/web/`
- Anything in `packages/`
- Route files
- `apps/server/src/crucible/prompts.ts` (Stream 4 owns)
- `apps/server/src/crucible/eval.ts` (Stream 4 owns)

## Detailed Requirements

### 1. Rename orwell → crucible

Create `apps/server/src/crucible/` directory. Copy `orwell/http.ts` to `crucible/http.ts`. Perform a full rename of all identifiers:

| Old                             | New                            |
| ------------------------------- | ------------------------------ |
| `orwellStore`                   | `crucibleStore`                |
| `OrwellRunRecord`               | `CrucibleRunRecord`            |
| `OrwellRunStartInput`           | `CrucibleRunStartInput`        |
| `OrwellRunEvent`                | `CrucibleRunEvent`             |
| `OrwellEvent`                   | `CrucibleEvent`                |
| `orwellConfigRouteLayer`        | `crucibleConfigRouteLayer`     |
| `orwellRunCreateRouteLayer`     | `crucibleRunCreateRouteLayer`  |
| `orwellRunGetRouteLayer`        | `crucibleRunGetRouteLayer`     |
| `orwellRunListRouteLayer`       | `crucibleRunListRouteLayer`    |
| `requireOrwellAccess`           | `requireCrucibleAccess`        |
| `globalThis.__t3OrwellStore`    | `globalThis.__t3CrucibleStore` |
| All route paths `/api/orwell/*` | `/api/crucible/*`              |
| File `.orwell-run-id`           | `.crucible-run-id`             |
| Directory `.orwell-subtasks/`   | `.crucible-subtasks/`          |

Delete `apps/server/src/orwell/` directory after the move.

Update `apps/server/src/server.ts`:

- Change all imports from `"./orwell/http.ts"` → `"./crucible/http.ts"`
- Change all layer names in `makeRoutesLayer` to the new crucible names

### 2. Add `type` field to run records

Add `type: "manager" | "task"` to `CrucibleRunRecord` and `CrucibleRunStartInput` (Effect Schema).

- Accept in `POST /api/crucible/runs` body
- Default: `"manager"` when `plannerMode` is true, `"task"` otherwise
- Include in serialized output

### 3. Add `repo` and `issueNumber` fields

Add to `CrucibleRunRecord` and `CrucibleRunStartInput`:

- `repo: string` — format `"owner/name"`
- `issueNumber?: number`

Accept in POST body, include in serialized output.

### 4. New endpoint: `GET /api/crucible/repos`

List repos in the workspace directory.

```typescript
// Implementation approach:
// 1. Read workspace directory from ServerConfig.cwd
// 2. List subdirectories
// 3. For each, check if .git/ exists
// 4. If git repo, derive owner/name from: git remote get-url origin
// 5. Return { repos: CrucibleRepo[] }
```

Use `child_process` or Effect's `Command` to run `git remote get-url origin` in each directory. Parse the remote URL to extract `owner/name`:

- `https://github.com/owner/name.git` → `owner/name`
- `git@github.com:owner/name.git` → `owner/name`

### 5. New endpoint: `POST /api/crucible/repos/clone`

```typescript
// Body: { url: string }
// e.g. { url: "https://github.com/Maniktherana/manikrana.dev" }
//
// 1. Extract owner/name from URL
// 2. Target path = ${workspaceDir}/${name}
// 3. If already exists and is a git repo, return existing record (don't fail)
// 4. Run: git clone <url> <targetPath>
// 5. Return CrucibleRepo
```

### 6. New endpoint: `GET /api/crucible/repos/:owner/:name/issues`

```typescript
// 1. Resolve repo path from workspace dir by matching owner/name
// 2. Run: gh issue list --repo owner/name --json number,title,body,labels,assignees,state,url --limit 50
// 3. Parse JSON output
// 4. Return { issues: CrucibleIssue[] }
```

Note: `gh issue list` works without being in the repo directory — it just needs `--repo owner/name`. So no directory resolution is strictly needed, but validate the repo exists in our workspace.

### 7. New endpoint: `GET /api/crucible/files`

Serve files from worktree directories (primarily for agent-browser screenshots).

```typescript
// Query: ?path=/absolute/path/to/file
//
// Security: path MUST be within the workspace directory
//   - Resolve both paths, check startsWith
//   - Reject directory traversal attempts
//
// Content-type detection:
//   - .png → image/png
//   - .jpg/.jpeg → image/jpeg
//   - .json → application/json
//   - everything else → text/plain
//
// Read file, return with appropriate headers
```

### 8. Extend `GET /api/crucible/runs` with repo filter

The existing runs list endpoint returns all runs. Add optional filtering:

```typescript
// Query: ?repo=owner/name (optional)
// If present, filter runs where run.repo === query.repo
// Return { runs: CrucibleRun[] } sorted by createdAt desc
```

### 9. New: `scripts/subtask-status.ts`

A CLI that agents call to poll child run status.

```typescript
#!/usr/bin/env bun

// Flags (using node:util parseArgs):
//   --run-id <id>     Run ID to check (required unless discoverable)
//   --origin <url>    Crucible server origin
//   --token <token>   Auth token
//   --help
//
// Run ID resolution (priority order):
//   1. --run-id flag
//   2. CRUCIBLE_RUN_ID env var
//   3. Read .crucible-run-id file in cwd
//
// Origin resolution: same as spawn-subtask.ts
//   1. --origin flag
//   2. T3CODE_SERVER_ORIGIN env var
//   3. server-runtime.json files
//
// Request: GET {origin}/api/crucible/runs/{runId}
//
// Output (JSON to stdout):
// {
//   "id": "...",
//   "status": "running",
//   "childRunIds": ["abc", "def"],
//   "children": [
//     { "id": "abc", "status": "completed", "prUrl": "..." },
//     { "id": "def", "status": "running" }
//   ]
// }
//
// Exit codes:
//   0 — all children completed
//   1 — any child errored
//   2 — still running (some children not done)
//   3 — run not found or API error
```

### 10. Update `scripts/spawn-subtask.ts`

Rename all orwell references:

- `.orwell-run-id` → `.crucible-run-id`
- `.orwell-subtasks/` → `.crucible-subtasks/`
- `/api/orwell/runs` → `/api/crucible/runs`
- `ORWELL_PARENT_RUN_ID` → `CRUCIBLE_PARENT_RUN_ID`

Add `--repo <owner/name>` flag, pass through to API as `repo` field.

Fix absolute path issue: the script currently references `/Users/manik/code/t3code/scripts/spawn-subtask.ts`. Replace with `import.meta.dir` resolution so it works from any install location.

## Integration with Stream 4

Stream 4 creates two files that this stream consumes:

- `apps/server/src/crucible/prompts.ts` — exports `buildManagerPrompt()` and `buildTaskPrompt()`
- `apps/server/src/crucible/eval.ts` — exports `EVAL_TASKS` and `runEvalTask()`

**For now:** the planner-mode prompt injection in `crucible/http.ts` can keep its existing hardcoded prompt. When Stream 4 delivers `prompts.ts`, replace the hardcoded string with `buildManagerPrompt(...)`. This avoids blocking.

**Eval wiring:** When Stream 4 delivers `eval.ts`, add a new route layer:

```typescript
// crucibleEvalRouteLayer — POST /api/crucible/eval/run
// Import EVAL_TASKS and runEvalTask from ./eval.ts
// Accept { taskIds?: string[] }, default to all tasks
// Run each task, return results
```

## Reference: Existing orwell/http.ts Structure

The current file is ~743 lines and exports 4 route layers. Key patterns to preserve:

- Module-scoped store on `globalThis` for HMR survival
- `requireOrwellAccess` auth middleware (rename to `requireCrucibleAccess`)
- `startRun` function that creates session → subscribes events → sends prompt
- `watchRunEventStream` async iterator over SDK event stream
- `serializeRun` with computed `fileCheck` on each request
- Effect Schema validation for input
- Consistent error handling via `Effect.catchTag("AuthError", respondToAuthError)`

New endpoints should follow the same patterns. Use `HttpRouter.add(...)` + `Effect.gen`.

## Verification

```bash
bun fmt && bun lint && bun typecheck
```

Manual API tests:

```bash
# After starting dev server:
curl http://localhost:3001/api/crucible/config
curl http://localhost:3001/api/crucible/repos
curl -X POST http://localhost:3001/api/crucible/repos/clone \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/Maniktherana/manikrana.dev"}'
curl http://localhost:3001/api/crucible/repos/Maniktherana/manikrana.dev/issues
```
