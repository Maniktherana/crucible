# Task: Run Persistence to SQLite (Stream 1 — Backend)

## Context

Read `docs/OVERVIEW.md` for project context. This is **Stream 1 (Backend)** work.

Currently all Crucible run state lives in an in-memory `Map` on `globalThis`. This means:

- Server HMR: store survives, but event subscriptions break (runs go zombie)
- Server restart: everything is lost — runs, events, parent/child links, all gone
- The NDJSON event logging (if implemented) persists events to disk but NOT the run records themselves

The codebase already has SQLite persistence infrastructure at `apps/server/src/persistence/Layers/Sqlite.ts` used by t3code for threads and sessions. We add a `crucible_runs` table alongside the existing tables.

## What Survives What (After This Task)

| Scenario       | Before                              | After                                                                                                                          |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Browser reload | OK (polling refetches)              | Same                                                                                                                           |
| Server HMR     | Store survives, subscriptions break | Store survives, subscriptions break (same — HMR is fine)                                                                       |
| Server restart | Everything lost                     | Run records reload from SQLite. Active runs attempt reconnect to opencode sessions. Failed reconnects marked as "interrupted". |

## Deliverables

### 1. Create `crucible_runs` SQLite table

In the existing SQLite persistence layer, add a migration (or create the table on first access):

```sql
CREATE TABLE IF NOT EXISTS crucible_runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'manager',        -- 'manager' | 'task'
  status TEXT NOT NULL DEFAULT 'starting',      -- 'starting' | 'running' | 'completed' | 'error'
  repo TEXT NOT NULL DEFAULT '',
  issue_number INTEGER,
  issue_title TEXT,
  issue_body TEXT,
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL DEFAULT '',
  parent_run_id TEXT,
  child_run_ids TEXT NOT NULL DEFAULT '[]',     -- JSON array of strings
  session_id TEXT,
  server_url TEXT,
  error TEXT,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  langfuse_trace_id TEXT,
  langfuse_span_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_crucible_runs_repo ON crucible_runs(repo);
CREATE INDEX IF NOT EXISTS idx_crucible_runs_parent ON crucible_runs(parent_run_id);
```

Events are NOT stored in SQLite (too high volume, use NDJSON files for that). Only the run record metadata.

### 2. Create `apps/server/src/crucible/persistence.ts`

A thin persistence layer. No Effect dependency — plain async functions using `better-sqlite3` (already a dependency of the project).

```typescript
import Database from "better-sqlite3";
import type { CrucibleRunRecord } from "./http.ts";

let db: Database.Database | null = null;

export function initCrucibleDb(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(/* CREATE TABLE IF NOT EXISTS crucible_runs ... */);
}

export function persistRun(run: CrucibleRunRecord): void {
  // INSERT OR REPLACE into crucible_runs
  // Serialize childRunIds as JSON
}

export function updateRunStatus(
  runId: string,
  status: string,
  extra?: {
    error?: string;
    completedAt?: string;
    durationMs?: number;
    prUrl?: string;
    sessionId?: string;
    serverUrl?: string;
  },
): void {
  // UPDATE crucible_runs SET status=?, updated_at=?, ... WHERE id=?
}

export function addChildRunId(parentId: string, childId: string): void {
  // Read current child_run_ids JSON, append, write back
}

export function loadAllRuns(): CrucibleRunRecord[] {
  // SELECT * FROM crucible_runs
  // Deserialize childRunIds from JSON
  // Return as CrucibleRunRecord[] (without client/server/abortController — those are runtime-only)
}

export function deleteRunsByRepo(repo: string): number {
  // DELETE FROM crucible_runs WHERE repo=? OR id IN (transitive children)
  // Return count deleted
}
```

### 3. Wire persistence into `apps/server/src/crucible/http.ts`

**On module load:**

```typescript
import { initCrucibleDb, loadAllRuns } from "./persistence.ts";

// Initialize DB (path alongside existing t3code SQLite DB)
const dbPath = Path.join(REPO_ROOT, ".crucible-data", "crucible.db");
initCrucibleDb(dbPath);

// Reload runs from SQLite into in-memory store on startup
const persistedRuns = loadAllRuns();
for (const run of persistedRuns) {
  crucibleStore.runs.set(run.id, {
    ...run,
    events: [], // Events come from NDJSON files, not SQLite
    abortController: new AbortController(),
    client: undefined,
    server: undefined,
  });
}
```

**On run creation (startRun):**

```typescript
// After creating the run record and adding to crucibleStore:
persistRun(run);
```

**On status changes (setRunStatus):**

```typescript
// After updating in-memory status:
updateRunStatus(run.id, run.status, { error: run.error, ... });
```

**On child link (addChildRun):**

```typescript
// After updating in-memory childRunIds:
addChildRunId(parentRun.id, childRun.id);
```

**On DELETE /api/crucible/runs:**

```typescript
// After clearing from in-memory store:
deleteRunsByRepo(repo);
```

### 4. Reconnect to active opencode sessions on startup

After loading runs from SQLite, attempt to reconnect to any that were "running" when the server died:

```typescript
for (const run of persistedRuns) {
  if (run.status === "running" && run.serverUrl && run.sessionId) {
    // Try to reconnect
    try {
      const client = createOpenCodeSdkClient({
        baseUrl: run.serverUrl,
        directory: run.directory,
      });
      // Verify session still exists
      const session = await client.session.get({ sessionID: run.sessionId });
      if (session.data) {
        run.client = client;
        // Re-subscribe to events
        const subscription = await client.event.subscribe(undefined, {
          signal: run.abortController.signal,
        });
        void watchRunEventStream(run, subscription);
        pushRunEvent(run, {
          type: "session.reconnected",
          summary: `Reconnected to OpenCode session ${run.sessionId} after server restart`,
          payload: {},
        });
      } else {
        setRunStatus(run, "error");
        run.error = "OpenCode session no longer exists after server restart.";
        updateRunStatus(run.id, "error", { error: run.error });
      }
    } catch {
      // Opencode server is gone — mark as interrupted
      setRunStatus(run, "error");
      run.error = "Lost connection to OpenCode session during server restart.";
      updateRunStatus(run.id, "error", { error: run.error });
    }
  }
}
```

This is best-effort. If the opencode process is still alive (it runs independently), we reconnect. If it's dead, we mark the run as errored cleanly instead of leaving it as a zombie "running" forever.

### 5. Load events from NDJSON on demand

When the UI requests a run's events (via `GET /api/crucible/runs/:runId`), and the in-memory events array is empty (e.g., after restart), backfill from the NDJSON log:

```typescript
// In serializeRun or the GET handler:
if (run.events.length === 0) {
  const logPath = Path.join(REPO_ROOT, "repos", ".crucible-logs", `${run.id}.ndjson`);
  try {
    const content = await FS.readFile(logPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    run.events = lines.map((line) => JSON.parse(line));
  } catch {
    // No log file — events are lost
  }
}
```

This means: after restart, run records come from SQLite, events come from NDJSON files. Together they reconstruct the full picture.

## Files Modified

| File                                      | Change                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/server/src/crucible/persistence.ts` | NEW — SQLite CRUD for runs                                                    |
| `apps/server/src/crucible/http.ts`        | Wire persistence calls into run lifecycle, reload on startup, reconnect logic |

## Files NOT Touched

- `apps/web/` (frontend doesn't need to change — it already polls the API)
- `apps/server/src/persistence/` (existing t3code persistence — we don't touch their tables)
- `prompts.ts`, `eval.ts`, `tracing.ts`
- Scripts

## Verification

```bash
bun fmt && bun lint && bun typecheck
```

Manual:

1. Start server, create a run, verify it appears in SQLite: `sqlite3 .crucible-data/crucible.db "SELECT id, status, repo FROM crucible_runs"`
2. Restart server, open browser — runs should still appear in kanban (In Progress or completed)
3. If the opencode session is still alive, events should resume streaming
4. If the opencode session died, run should show as "error" with clear message

## Priority

This is important for demo reliability but NOT a blocker for L3. The NDJSON logging + Langfuse integration (separate task) provides the observability persistence. This task adds operational robustness — runs surviving restart means you don't lose your demo if something crashes.

Do this AFTER the o11y hardening task and the chat UI rewrite are done. It's a nice-to-have for the hackathon, not a must-have.
