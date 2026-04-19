# Task: Observability Hardening (Stream 1 — Backend)

## Context

Read `docs/OVERVIEW.md` for project context. This is **Stream 1 (Backend)** work. Crucible's observability is currently in-memory only — server restart loses all run history. This task hardens it to solid L3 and pushes to L4 on the MaaS observability parameter (7x weight, 14-28 pts).

**Current state:**

- Events stored in-memory per run (max 200, FIFO trimmed)
- UI renders events via CardDetailPanel → EventStreamView
- No disk persistence, no token/cost tracking, no run timing, no tracing

**L3:** "Can pull up a specific run and see what each agent did, step by step."
**L4:** "Trace tree across agents (who called whom), token and cost per step, filter by agent or task."
**L5:** "Production-grade: diff two runs, alerts on failure or cost spike, search across runs."

## The Big Win: Langfuse Integration

Langfuse is OSS (MIT), self-hostable, and has a cloud free tier at https://cloud.langfuse.com. It gives us a proper trace UI with spans, token tracking, cost, and latency — for free. The Langfuse dashboard IS our L4 observability surface. The rubric says "tool-agnostic" — Langfuse counts the same as a custom build.

**For the hackathon, use Langfuse Cloud** (free tier, no Docker setup). Sign up at https://cloud.langfuse.com, create a project, get the keys. Self-hosting via Docker is possible but adds complexity we don't need during a demo.

### How it maps to scoring

| Level | Langfuse gives us                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| L3    | Trace per issue → see every agent step. Already have this in our UI, Langfuse is backup/persistence.                       |
| L4    | Trace tree (manager → initializer/tasks), token + cost per generation, filter by agent/task. This is Langfuse's native UI. |
| L5    | Side-by-side run comparison, search across traces. Langfuse has this built in.                                             |

### Integration architecture

```
User clicks Start on Issue #3
  │
  Manager run created ──► Langfuse: trace.create({ name: "Issue #3", metadata: { repo, issueNumber } })
  │
  ├── Initializer spawned ──► Langfuse: trace.span({ name: "initializer" })
  │     └── Events ──► Langfuse: span.generation() for each tool call / LLM response
  │
  ├── Task 1 spawned ──► Langfuse: trace.span({ name: "task-1: Add footer" })
  │     ├── bash: npm install ──► span.event()
  │     ├── LLM response ──► span.generation({ usage: { input, output } })
  │     ├── agent-browser screenshot ──► span.event()
  │     └── gh pr create ──► span.event()
  │
  └── Task 2 spawned ──► Langfuse: trace.span({ name: "task-2: Fix nav" })
        └── ...
```

## Deliverables

### 1. Install Langfuse SDK

```bash
cd apps/server && bun add langfuse
```

### 2. Create `apps/server/src/crucible/tracing.ts`

A thin wrapper around the Langfuse SDK. Pure module, no Effect dependency.

```typescript
import { Langfuse } from "langfuse";

let langfuse: Langfuse | null = null;

export function initLangfuse(): void {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    console.warn(
      "[crucible/tracing] LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY not set. Tracing disabled.",
    );
    return;
  }

  langfuse = new Langfuse({ publicKey, secretKey, baseUrl });
}

export function getLangfuse(): Langfuse | null {
  return langfuse;
}

export function shutdownLangfuse(): Promise<void> {
  return langfuse?.shutdownAsync() ?? Promise.resolve();
}
```

Export types for trace/span handles that the run lifecycle uses:

```typescript
export interface CrucibleTrace {
  traceId: string;
  addSpan(name: string, metadata?: Record<string, unknown>): CrucibleSpan;
  end(): void;
}

export interface CrucibleSpan {
  spanId: string;
  addEvent(name: string, metadata?: Record<string, unknown>): void;
  addGeneration(params: {
    name: string;
    input?: string;
    output?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }): void;
  end(): void;
}
```

Implement these wrapping `langfuse.trace()` and `trace.span()`. When Langfuse is disabled (no keys), return no-op implementations that silently discard calls.

### 3. Wire tracing into `apps/server/src/crucible/http.ts`

**On run creation (`startRun`):**

```typescript
import { getLangfuse } from "./tracing.ts";

// After creating the run record:
if (run.type === "manager" && !run.parentRunId) {
  // Top-level manager = new Langfuse trace
  const lf = getLangfuse();
  if (lf) {
    const trace = lf.trace({
      name: `Issue #${run.issueNumber}: ${run.title}`,
      metadata: { repo: run.repo, issueNumber: run.issueNumber, runId: run.id },
    });
    run.langfuseTraceId = trace.id;
  }
} else if (run.parentRunId) {
  // Child run = span on parent's trace
  const parent = crucibleStore.runs.get(run.parentRunId);
  if (parent?.langfuseTraceId) {
    const lf = getLangfuse();
    if (lf) {
      const trace = lf.trace({ id: parent.langfuseTraceId });
      const span = trace.span({
        name: `${run.type}: ${run.title || run.prompt.slice(0, 80)}`,
        metadata: { runId: run.id, type: run.type },
      });
      run.langfuseSpanId = span.id;
      run.langfuseTraceId = parent.langfuseTraceId; // inherit trace ID
    }
  }
}
```

Add to `CrucibleRunRecord`:

```typescript
langfuseTraceId?: string;
langfuseSpanId?: string;
```

**On events (`addRunEvent`):**

```typescript
// After pushing to run.events and writing NDJSON:
if (run.langfuseTraceId) {
  const lf = getLangfuse();
  if (lf) {
    const trace = lf.trace({ id: run.langfuseTraceId });
    const spanOrTrace = run.langfuseSpanId ? trace.span({ id: run.langfuseSpanId }) : trace;

    if (summary.type === "message.part.updated") {
      // LLM generation events — log as generations with token usage
      const usage = extractUsage(event);
      spanOrTrace.generation({
        name: summary.summary.slice(0, 100),
        metadata: { eventId: id },
        ...(usage ? { usage: { input: usage.inputTokens, output: usage.outputTokens } } : {}),
      });
    } else {
      // Other events — log as span events
      spanOrTrace.event({
        name: summary.type,
        metadata: { summary: summary.summary },
      });
    }
  }
}
```

**On run completion (status → "completed" or "error"):**

```typescript
if (run.langfuseSpanId) {
  const lf = getLangfuse();
  if (lf) {
    lf.trace({ id: run.langfuseTraceId! }).span({ id: run.langfuseSpanId }).end();
  }
}
// If this is the top-level manager and all children are done:
if (run.type === "manager" && !run.parentRunId && run.langfuseTraceId) {
  const lf = getLangfuse();
  if (lf) {
    lf.trace({ id: run.langfuseTraceId }).update({ metadata: { status: run.status } });
    await lf.flushAsync();
  }
}
```

### 4. Initialize Langfuse on server startup

In `apps/server/src/crucible/http.ts`, at module scope (or in a top-level init block):

```typescript
import { initLangfuse } from "./tracing.ts";
initLangfuse();
```

This runs once when the module loads. If keys aren't set, tracing is silently disabled.

### 5. NDJSON event log per run (persistence backup)

Even with Langfuse, keep a local log for offline use / fast access.

In `addRunEvent` (around line 150 in `http.ts`), after pushing to `run.events`, also append to disk:

```typescript
const logDir = Path.join(REPO_ROOT, "repos", ".crucible-logs");
const logPath = Path.join(logDir, `${run.id}.ndjson`);
FS.mkdir(logDir, { recursive: true })
  .then(() =>
    FS.appendFile(
      logPath,
      JSON.stringify({
        id,
        at,
        runId: run.id,
        type: summary.type,
        summary: summary.summary,
        payload: event,
      }) + "\n",
    ),
  )
  .catch(() => {
    /* best effort */
  });
```

### 6. Serve historical logs

Add `GET /api/crucible/runs/:runId/log`:

- Read `repos/.crucible-logs/<runId>.ndjson`
- Parse each line, return `{ events: [...] }`
- If file doesn't exist, return `{ events: [] }`
- Wire into `server.ts` `makeRoutesLayer`

### 7. Run timing

Add to `CrucibleRunRecord`:

```typescript
startedAt?: string;
completedAt?: string;
durationMs?: number;
```

Set `startedAt` when status → `"running"`. Set `completedAt` and compute `durationMs` when status → `"completed"` or `"error"`. Include in `serializeRun()`.

### 8. Token count extraction

In `summarizeEvent()` or `addRunEvent`, extract token usage from opencode event payloads:

```typescript
function extractUsage(event: unknown): { inputTokens?: number; outputTokens?: number } | null {
  const obj = event as any;
  const usage = obj?.usage ?? obj?.properties?.usage ?? obj?.message?.usage ?? null;
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens,
    outputTokens: usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens,
  };
}
```

Add `inputTokens?: number` and `outputTokens?: number` to the stored event objects.

### 9. UI: Show timing and token counts

In `apps/web/src/components/crucible/types.ts`, add:

```typescript
// On CrucibleRunEvent:
inputTokens?: number;
outputTokens?: number;

// On CrucibleRun:
startedAt?: string;
completedAt?: string;
durationMs?: number;
```

In `apps/web/src/components/crucible/EventStreamView.tsx`:

- Show run duration at the top: `Duration: Xs`
- Show token badge per event: `N→M tokens`

In `apps/web/src/components/crucible/RunTreeView.tsx`:

- Sum tokens per run, show next to each node: `1.2k tokens`

### 10. Add Langfuse dashboard link to the UI

In `apps/web/src/components/crucible/CardDetailPanel.tsx`, add a small link at the top of the run detail section:

```tsx
{
  run.langfuseTraceId && (
    <a
      href={`https://cloud.langfuse.com/trace/${run.langfuseTraceId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-blue-400 hover:underline"
    >
      View in Langfuse
    </a>
  );
}
```

This requires `langfuseTraceId` to be included in the serialized run response.

## Environment Variables

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com  # default, optional
```

If not set, tracing is silently disabled. Everything else (NDJSON logging, timing, token extraction) works without Langfuse.

## Files Modified

| File                                                   | Change                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `apps/server/src/crucible/tracing.ts`                  | NEW — Langfuse wrapper                                                                           |
| `apps/server/src/crucible/http.ts`                     | NDJSON logging, Langfuse trace/span lifecycle, timing fields, token extraction, new log endpoint |
| `apps/server/src/server.ts`                            | Wire log route layer                                                                             |
| `apps/web/src/components/crucible/types.ts`            | Add timing + token fields                                                                        |
| `apps/web/src/components/crucible/EventStreamView.tsx` | Duration display, token badges                                                                   |
| `apps/web/src/components/crucible/RunTreeView.tsx`     | Token totals per node                                                                            |
| `apps/web/src/components/crucible/CardDetailPanel.tsx` | Langfuse link                                                                                    |
| `apps/server/package.json`                             | Add `langfuse` dependency                                                                        |

## Files NOT Touched

- `prompts.ts`, `eval.ts` (Stream 4)
- `spawn-subtask.ts`, `subtask-status.ts`, `crucible-cleanup.ts` (scripts)
- Route files (`__root.tsx`, `_chat.index.tsx`)
- `KanbanBoard.tsx`, `TopBar.tsx`, `RepoSelector.tsx`

## Verification

```bash
bun fmt && bun lint && bun typecheck
```

Manual:

1. Without Langfuse keys: start server, create a run, verify NDJSON log appears at `repos/.crucible-logs/<runId>.ndjson`, verify timing shows in UI
2. With Langfuse keys: set env vars, create a run, open Langfuse dashboard, verify trace appears with spans per child agent and token counts
3. Restart server, hit `GET /api/crucible/runs/<runId>/log` — events should load from disk
