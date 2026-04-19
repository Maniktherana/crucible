import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpenCodeSettings } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import {
  buildOpenCodePermissionRules,
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  type OpenCodeServerConnection,
} from "../provider/opencodeRuntime.ts";
import { buildManagerPrompt, buildTaskPrompt } from "./prompts.ts";
import { EVAL_TASKS, checkEvalOutcome } from "./eval.ts";
import {
  initLangfuse,
  isTracingEnabled,
  flushTracing,
  startObservation,
  type LangfuseSpan,
} from "./tracing.ts";
import {
  finalizeRunTrace,
  initRunTraceState,
  reduceToLangfuse,
  type RunTraceState,
} from "./langfuseReducer.ts";
import {
  initCrucibleDb,
  loadAllRuns,
  persistRun as dbPersistRun,
  updateRunStatus as dbUpdateRunStatus,
  addChildRunId as dbAddChildRunId,
  deleteRunsByRepo as dbDeleteRunsByRepo,
  persistAttachment,
  getAttachmentsForRun,
  type CrucibleAttachment,
  persistApproval,
  getApprovalById,
  getApprovalsForRun,
  resolveApproval,
  type CrucibleApproval,
} from "./persistence.ts";

// Module-scope init — async but fire-and-forget (tracing is best-effort).
void initLangfuse();

const MAX_STORED_EVENTS = 200;
const MAX_FILE_PREVIEW_CHARS = 2_000;
const REPO_ROOT = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SPAWN_SUBTASK_SCRIPT_PATH = Path.join(REPO_ROOT, "scripts", "spawn-subtask.ts");
const SUBTASK_STATUS_SCRIPT_PATH = Path.join(REPO_ROOT, "scripts", "subtask-status.ts");
const CRUCIBLE_LOG_DIR = Path.join(REPO_ROOT, "repos", ".crucible-logs");

type CrucibleRunType = "manager" | "task";
type CrucibleRunStatus = "starting" | "running" | "completed" | "error";

const CrucibleRunStartInput = Schema.Struct({
  directory: Schema.String,
  title: Schema.optionalKey(Schema.String),
  prompt: Schema.String,
  expectedFilePath: Schema.optionalKey(Schema.String),
  expectedText: Schema.optionalKey(Schema.String),
  plannerMode: Schema.optionalKey(Schema.Boolean),
  parentRunId: Schema.optionalKey(Schema.String),
  spawnCommand: Schema.optionalKey(Schema.String),
  spawnTool: Schema.optionalKey(Schema.String),
  spawnNote: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Literals(["manager", "task"])),
  repo: Schema.optionalKey(Schema.String),
  issueNumber: Schema.optionalKey(Schema.Number),
  issueTitle: Schema.optionalKey(Schema.String),
  issueBody: Schema.optionalKey(Schema.String),
  subtaskDescription: Schema.optionalKey(Schema.String),
  taskBranch: Schema.optionalKey(Schema.String),
  agentBrowserAvailable: Schema.optionalKey(Schema.Boolean),
});

type CrucibleRunStartInput = typeof CrucibleRunStartInput.Type;

interface CrucibleRunEvent {
  readonly id: string;
  readonly at: string;
  readonly type: string;
  readonly summary: string;
  readonly payload: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

interface CrucibleRunRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly directory: string;
  readonly title: string;
  readonly prompt: string;
  readonly type: CrucibleRunType;
  readonly repo: string;
  readonly expectedFilePath?: string;
  readonly expectedText?: string;
  readonly parentRunId?: string;
  readonly childRunIds: string[];
  readonly spawnCommand?: string;
  readonly spawnTool?: string;
  readonly spawnNote?: string;
  readonly issueNumber?: number;
  readonly abortController: AbortController;
  readonly events: CrucibleRunEvent[];
  status: CrucibleRunStatus;
  updatedAt: string;
  sessionId?: string;
  serverUrl?: string;
  error?: string;
  needsInput?: boolean;
  prUrl?: string;
  client?: OpencodeClient;
  server?: OpenCodeServerConnection;
  langfuseTraceId?: string;
  langfuseSpanId?: string;
  langfuseSpan?: LangfuseSpan;
  trace: RunTraceState;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

interface CrucibleStore {
  readonly runs: Map<string, CrucibleRunRecord>;
}

const globalCrucibleStore = globalThis as typeof globalThis & {
  __t3CrucibleStore?: CrucibleStore;
};

const crucibleStore: CrucibleStore = globalCrucibleStore.__t3CrucibleStore ?? {
  runs: new Map<string, CrucibleRunRecord>(),
};

if (!globalCrucibleStore.__t3CrucibleStore) {
  globalCrucibleStore.__t3CrucibleStore = crucibleStore;
}

// SQLite persistence — init DB and reload persisted runs into in-memory store.
const DB_PATH = Path.join(REPO_ROOT, ".crucible-data", "crucible.db");
initCrucibleDb(DB_PATH);

/**
 * Replay the per-run NDJSON event log back into an in-memory event array so
 * that runs which were live before a server restart still show their chat
 * history. Tolerant of missing files and malformed lines. Caps at
 * MAX_STORED_EVENTS (keeps the tail).
 */
function replayEventsFromLog(runId: string): CrucibleRunEvent[] {
  const logPath = Path.join(CRUCIBLE_LOG_DIR, `${runId}.ndjson`);
  if (!existsSync(logPath)) return [];
  try {
    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const events: CrucibleRunEvent[] = [];
    // Replay only the tail — older events are already dropped by the live
    // trimmer so reloading more than the cap wastes memory and scroll.
    const start = Math.max(0, lines.length - MAX_STORED_EVENTS);
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]!;
      try {
        const parsed = JSON.parse(line) as CrucibleRunEvent & { runId?: string };
        if (typeof parsed.id !== "string" || typeof parsed.type !== "string") continue;
        // Strip the runId field we added when writing; it's not part of the
        // event record.
        const { runId: _drop, ...event } = parsed;
        events.push(event as CrucibleRunEvent);
      } catch {
        // Skip malformed line; don't let one bad write poison the replay.
      }
    }
    return events;
  } catch {
    return [];
  }
}

if (crucibleStore.runs.size === 0) {
  const persistedRuns = loadAllRuns();
  let totalReplayed = 0;
  for (const run of persistedRuns) {
    const events = replayEventsFromLog(run.id);
    totalReplayed += events.length;
    crucibleStore.runs.set(run.id, {
      ...run,
      type: run.type as CrucibleRunType,
      status: run.status as CrucibleRunStatus,
      events,
      abortController: new AbortController(),
      childRunIds: [...run.childRunIds],
      // Re-created runs don't have live Langfuse spans; initialize an empty
      // trace state so the reducer can no-op safely.
      trace: initRunTraceState(),
    });
  }
  if (persistedRuns.length > 0) {
    console.info(
      `[crucible] Reloaded ${persistedRuns.length} run(s) from SQLite, ${totalReplayed} event(s) from NDJSON logs.`,
    );
  }
}

class CrucibleHttpError extends Data.TaggedError("CrucibleHttpError")<{
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

const requireCrucibleAccess = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverConfig = yield* ServerConfig;
  const serverAuth = yield* ServerAuth;
  const hasAuthCredential =
    typeof request.headers.authorization === "string" ||
    Object.keys(request.cookies ?? {}).length > 0;

  if (!hasAuthCredential) {
    const loopbackHost = serverConfig.host;
    if (
      loopbackHost === undefined ||
      loopbackHost === "localhost" ||
      loopbackHost === "127.0.0.1" ||
      loopbackHost === "::1" ||
      loopbackHost === "[::1]" ||
      loopbackHost.startsWith("127.")
    ) {
      return;
    }
  }

  yield* serverAuth.authenticateHttpRequest(request);
});

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pushRunEvent(run: CrucibleRunRecord, event: Omit<CrucibleRunEvent, "id" | "at">): void {
  const id = randomUUID();
  const at = nowIso();

  // Extract token usage from the event payload (surfaced in the UI event row)
  const usage = extractUsage(event.payload);

  const eventObj: CrucibleRunEvent = {
    id,
    at,
    ...event,
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
  };

  run.events.push(eventObj);
  if (run.events.length > MAX_STORED_EVENTS) {
    run.events.splice(0, run.events.length - MAX_STORED_EVENTS);
  }
  run.updatedAt = nowIso();

  // Ingest any SCREENSHOT_SAVED markers from event payload + summary
  const markerText = `${eventObj.summary}\n${JSON.stringify(eventObj.payload ?? "")}`;
  ingestScreenshotMarkers({
    runId: run.id,
    runDirectory: run.directory,
    text: markerText,
  });
  // Ingest any REQUEST_APPROVAL markers and flip the run into needsInput.
  ingestApprovalRequests({
    run,
    text: markerText,
  });

  // Best-effort NDJSON log to disk
  void FS.mkdir(CRUCIBLE_LOG_DIR, { recursive: true })
    .then(() =>
      FS.appendFile(
        Path.join(CRUCIBLE_LOG_DIR, `${run.id}.ndjson`),
        JSON.stringify({ ...eventObj, runId: run.id }) + "\n",
      ),
    )
    .catch(() => {
      /* best-effort */
    });

  // Langfuse: route through the stateful reducer so we emit clean
  // generations/tool spans instead of one observation per raw event.
  reduceToLangfuse(run, {
    type: event.type,
    summary: event.summary,
    payload: event.payload,
  });
}

function setRunStatus(run: CrucibleRunRecord, status: CrucibleRunStatus, error?: string): void {
  run.status = status;
  run.updatedAt = nowIso();
  if (error !== undefined) {
    run.error = error;
  } else {
    delete run.error;
  }

  // Timing
  if (status === "running" && !run.startedAt) {
    run.startedAt = nowIso();
  }
  if (status === "completed" || status === "error") {
    run.completedAt = nowIso();
    if (run.startedAt) {
      run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    }

    // Close any dangling tool spans / generation, stamp final trace output.
    finalizeRunTrace(run, status, {
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      childRunIds: run.childRunIds,
    });

    // Flush if this is the top-level manager run completing
    if (run.type === "manager" && !run.parentRunId && run.langfuseTraceId) {
      void flushTracing();
    }
  }

  // Persist status change to SQLite
  dbUpdateRunStatus(run.id, run.status, {
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: run.durationMs,
    sessionId: run.sessionId,
    serverUrl: run.serverUrl,
  });

  // If a child run completed/errored, check if the parent manager is now done
  if ((status === "completed" || status === "error") && run.parentRunId) {
    const parentRun = crucibleStore.runs.get(run.parentRunId);
    if (parentRun) {
      checkManagerCompletion(parentRun);
    }
  }
}

function summarizeEvent(event: unknown): { readonly type: string; readonly summary: string } {
  if (!event || typeof event !== "object" || !("type" in event)) {
    return {
      type: "unknown",
      summary: "Unknown OpenCode event",
    };
  }

  const typedEvent = event as {
    readonly type: string;
    readonly properties?: Record<string, unknown>;
  };

  switch (typedEvent.type) {
    case "session.status": {
      const statusType =
        typeof typedEvent.properties?.status === "object" &&
        typedEvent.properties?.status &&
        "type" in typedEvent.properties.status
          ? String(typedEvent.properties.status.type)
          : "unknown";
      return {
        type: typedEvent.type,
        summary: `Session status changed to ${statusType}`,
      };
    }
    case "message.part.updated": {
      const part =
        typeof typedEvent.properties?.part === "object" && typedEvent.properties.part
          ? (typedEvent.properties.part as Record<string, unknown>)
          : null;
      if (!part) {
        return {
          type: typedEvent.type,
          summary: "Message part updated",
        };
      }

      if (part.type === "tool") {
        const toolName = typeof part.tool === "string" ? part.tool : "tool";
        const toolStatus =
          typeof part.state === "object" &&
          part.state &&
          "status" in part.state &&
          typeof part.state.status === "string"
            ? part.state.status
            : "updated";
        return {
          type: typedEvent.type,
          summary: `${toolName} ${toolStatus}`,
        };
      }

      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        const preview = part.text.replace(/\s+/g, " ").trim().slice(0, 120);
        return {
          type: typedEvent.type,
          summary: preview.length > 0 ? preview : `${String(part.type)} updated`,
        };
      }

      return {
        type: typedEvent.type,
        summary: `Message part ${String(part.type ?? "updated")}`,
      };
    }
    case "message.part.delta": {
      const delta =
        typeof typedEvent.properties?.delta === "string"
          ? typedEvent.properties.delta.replace(/\s+/g, " ").trim()
          : "";
      return {
        type: typedEvent.type,
        summary: delta.length > 0 ? delta.slice(0, 120) : "Message delta received",
      };
    }
    case "permission.asked":
      return {
        type: typedEvent.type,
        summary: `Permission requested: ${String(typedEvent.properties?.permission ?? "unknown")}`,
      };
    case "session.error":
      return {
        type: typedEvent.type,
        summary: "Session reported an error",
      };
    default:
      return {
        type: typedEvent.type,
        summary: typedEvent.type,
      };
  }
}

function extractUsage(event: unknown): { inputTokens?: number; outputTokens?: number } | null {
  if (!event || typeof event !== "object") return null;
  const obj = event as Record<string, unknown>;
  const usage =
    (typeof obj.usage === "object" && obj.usage) ||
    (typeof obj.properties === "object" && obj.properties
      ? (obj.properties as Record<string, unknown>).usage
      : null) ||
    (typeof obj.message === "object" && obj.message
      ? (obj.message as Record<string, unknown>).usage
      : null) ||
    null;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const inputTokens = (u.inputTokens ?? u.input_tokens ?? u.prompt_tokens) as number | undefined;
  const outputTokens = (u.outputTokens ?? u.output_tokens ?? u.completion_tokens) as
    | number
    | undefined;
  if (inputTokens === undefined && outputTokens === undefined) return null;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function addChildRun(parent: CrucibleRunRecord, child: CrucibleRunRecord): void {
  if (!parent.childRunIds.includes(child.id)) {
    parent.childRunIds.push(child.id);
  }
  parent.updatedAt = nowIso();
  pushRunEvent(parent, {
    type: "run.child.created",
    summary: `Spawned child run ${child.id}`,
    payload: {
      childRunId: child.id,
      childTitle: child.title,
      childSessionId: child.sessionId ?? null,
      parentRunId: parent.id,
      spawnCommand: child.spawnCommand ?? null,
      spawnTool: child.spawnTool ?? null,
      spawnNote: child.spawnNote ?? null,
    },
  });

  // Persist child link to SQLite
  dbAddChildRunId(parent.id, child.id);
}

async function readFileCheck(run: CrucibleRunRecord) {
  const expectedFilePath = normalizeOptionalString(run.expectedFilePath);
  if (!expectedFilePath) {
    return null;
  }

  const absolutePath = Path.isAbsolute(expectedFilePath)
    ? expectedFilePath
    : Path.resolve(run.directory, expectedFilePath);

  try {
    const content = await FS.readFile(absolutePath, "utf8");
    const expectedText = normalizeOptionalString(run.expectedText);
    return {
      path: expectedFilePath,
      absolutePath,
      exists: true,
      containsExpectedText: expectedText ? content.includes(expectedText) : null,
      preview: content.slice(0, MAX_FILE_PREVIEW_CHARS),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        path: expectedFilePath,
        absolutePath,
        exists: false,
        containsExpectedText: null,
        preview: "",
      };
    }
    throw error;
  }
}

async function serializeRun(run: CrucibleRunRecord) {
  return {
    id: run.id,
    type: run.type,
    repo: run.repo,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    directory: run.directory,
    title: run.title,
    prompt: run.prompt,
    sessionId: run.sessionId ?? null,
    serverUrl: run.serverUrl ?? null,
    error: run.error ?? null,
    expectedFilePath: run.expectedFilePath ?? null,
    expectedText: run.expectedText ?? null,
    parentRunId: run.parentRunId ?? null,
    childRunIds: [...run.childRunIds],
    issueNumber: run.issueNumber ?? null,
    spawnCommand: run.spawnCommand ?? null,
    spawnTool: run.spawnTool ?? null,
    spawnNote: run.spawnNote ?? null,
    prUrl: run.prUrl ?? null,
    needsInput: run.needsInput ?? false,
    events: run.events,
    fileCheck: await readFileCheck(run),
    langfuseTraceId: run.langfuseTraceId ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    durationMs: run.durationMs ?? null,
    attachments: getAttachmentsForRun(run.id),
    approvals: getApprovalsForRun(run.id),
  };
}

async function serializeRunList(repoFilter?: string) {
  let runs = [...crucibleStore.runs.values()].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  if (repoFilter) {
    runs = runs.filter((run) => run.repo === repoFilter);
  }
  return Promise.all(runs.map((run) => serializeRun(run)));
}

function checkManagerCompletion(run: CrucibleRunRecord): void {
  if (run.type !== "manager" || run.status !== "running") return;
  if (run.childRunIds.length === 0) return;

  const children = run.childRunIds.map((id) => crucibleStore.runs.get(id)).filter(Boolean);
  const allDone = children.every((c) => c!.status === "completed" || c!.status === "error");
  if (!allDone) return;

  const anyError = children.some((c) => c!.status === "error");
  const prUrls = children.map((c) => c!.prUrl).filter(Boolean);
  if (prUrls.length > 0 && !run.prUrl) {
    run.prUrl = prUrls.join(", ");
  }

  setRunStatus(run, anyError ? "error" : "completed");
  pushRunEvent(run, {
    type: "crucible.manager_completed",
    summary: `All ${children.length} subtasks finished (${prUrls.length} PRs created)`,
    payload: {
      childStatuses: children.map((c) => ({
        id: c!.id,
        status: c!.status,
        prUrl: c!.prUrl ?? null,
      })),
    },
  });
}

async function watchRunEventStream(
  run: CrucibleRunRecord,
  subscription: Awaited<ReturnType<NonNullable<CrucibleRunRecord["client"]>["event"]["subscribe"]>>,
) {
  try {
    for await (const event of subscription.stream) {
      const payloadSessionId =
        "properties" in event &&
        event.properties &&
        typeof event.properties === "object" &&
        "sessionID" in event.properties
          ? event.properties.sessionID
          : undefined;
      if (payloadSessionId !== run.sessionId) {
        continue;
      }

      const summary = summarizeEvent(event);
      pushRunEvent(run, {
        type: summary.type,
        summary: summary.summary,
        payload: event,
      });

      // --- BUG 1a: Detect PR creation from bash tool output ---
      const props = event.properties as Record<string, unknown> | undefined;
      const part = (props?.part ?? props?.status) as Record<string, unknown> | undefined;
      if (
        part?.type === "tool" &&
        part.tool === "bash" &&
        (part.state as Record<string, unknown> | undefined)?.status === "completed"
      ) {
        const state = part.state as Record<string, unknown>;
        const cmd = String((state.input as Record<string, unknown> | undefined)?.command ?? "");
        const output = String(
          state.output ?? (state.metadata as Record<string, unknown> | undefined)?.output ?? "",
        );
        if (cmd.includes("gh pr create") && output.includes("github.com")) {
          const prMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
          if (prMatch) {
            run.prUrl = prMatch[0];
            pushRunEvent(run, {
              type: "crucible.pr.detected",
              summary: `PR created: ${run.prUrl}`,
              payload: { prUrl: run.prUrl },
            });
          }
        }
      }

      // --- BUG 1b: Detect "question" events (agent waiting for input) ---
      if (part?.type === "question" || summary.summary.includes("question pending")) {
        run.needsInput = true;
        pushRunEvent(run, {
          type: "crucible.needs_input",
          summary: "Agent is waiting for user input — this will block until answered",
          payload: {
            question: (part?.state as Record<string, unknown> | undefined)?.input ?? part,
          },
        });
      }

      if (event.type === "session.status") {
        const statusType =
          typeof event.properties.status === "object" &&
          event.properties.status &&
          "type" in event.properties.status
            ? String(event.properties.status.type)
            : "unknown";
        if (statusType === "busy") {
          setRunStatus(run, "running");
        } else if (statusType === "idle" && run.status !== "error") {
          setRunStatus(run, "completed");
        }
      }

      if (event.type === "session.error") {
        setRunStatus(run, "error", "OpenCode reported a session error.");
      }
    }
  } catch (error) {
    if (run.abortController.signal.aborted) {
      return;
    }

    pushRunEvent(run, {
      type: "watch.error",
      summary: error instanceof Error ? error.message : "Event subscription failed.",
      payload: error,
    });
    setRunStatus(
      run,
      "error",
      error instanceof Error ? error.message : "Event subscription failed.",
    );
  }

  // --- BUG 1c: Stale run timeout — stream ended but run still "running" ---
  if (run.status === "running") {
    if (run.prUrl) {
      setRunStatus(run, "completed");
      pushRunEvent(run, {
        type: "crucible.auto_completed",
        summary: "Run completed (PR detected, event stream ended)",
        payload: {},
      });
    } else {
      // Give it 30s then check if session is still alive
      setTimeout(async () => {
        if (run.status !== "running") return;
        try {
          const session = await run.client?.session.get({
            sessionID: run.sessionId!,
          });
          const info = session?.data;
          if (!info || (info as Record<string, unknown>).status === undefined) {
            setRunStatus(run, "completed");
          } else {
            const statusObj = (info as Record<string, unknown>).status as
              | Record<string, unknown>
              | undefined;
            if (statusObj?.type === "idle") {
              setRunStatus(run, "completed");
            }
          }
        } catch {
          setRunStatus(run, "error", "Event stream disconnected and session is unreachable");
        }
      }, 30_000);
    }
  }
}

async function startRun(
  input: CrucibleRunStartInput,
  opencodeSettings: OpenCodeSettings,
): Promise<CrucibleRunRecord> {
  if (!opencodeSettings.enabled) {
    throw new CrucibleHttpError({
      message: "OpenCode is disabled in server settings.",
      status: 400,
    });
  }

  const directory = input.directory.trim();
  if (directory.length === 0) {
    throw new CrucibleHttpError({
      message: "Directory is required.",
      status: 400,
    });
  }

  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new CrucibleHttpError({
      message: "Prompt is required.",
      status: 400,
    });
  }

  await FS.mkdir(directory, { recursive: true });
  const expectedFilePath = normalizeOptionalString(input.expectedFilePath);
  const expectedText = normalizeOptionalString(input.expectedText);
  const plannerMode = input.plannerMode === true;
  const parentRunId = normalizeOptionalString(input.parentRunId);
  const spawnCommand = normalizeOptionalString(input.spawnCommand);
  const spawnTool = normalizeOptionalString(input.spawnTool);
  const spawnNote = normalizeOptionalString(input.spawnNote);
  const repo = normalizeOptionalString(input.repo) ?? "";
  const issueNumber = input.issueNumber;
  const runType: CrucibleRunType = input.type ?? (plannerMode ? "manager" : "task");

  const run: CrucibleRunRecord = {
    id: randomUUID(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    title: normalizeOptionalString(input.title) ?? "Crucible Run",
    directory,
    prompt,
    status: "starting",
    type: runType,
    repo,
    abortController: new AbortController(),
    events: [],
    childRunIds: [],
    trace: initRunTraceState(),
    ...(parentRunId !== undefined ? { parentRunId } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(expectedFilePath !== undefined ? { expectedFilePath } : {}),
    ...(expectedText !== undefined ? { expectedText } : {}),
    ...(spawnCommand !== undefined ? { spawnCommand } : {}),
    ...(spawnTool !== undefined ? { spawnTool } : {}),
    ...(spawnNote !== undefined ? { spawnNote } : {}),
  };

  const agentBrowserAvailable = input.agentBrowserAvailable === true;
  const spawnCmd = `bun ${SPAWN_SUBTASK_SCRIPT_PATH}`;
  const statusCmd = `bun ${SUBTASK_STATUS_SCRIPT_PATH}`;

  // Build the dispatch prompt using the real prompt templates when we have
  // enough context; fall back to the raw prompt for backward compatibility.
  let dispatchPrompt: string;

  if (
    runType === "manager" &&
    plannerMode &&
    issueNumber !== undefined &&
    input.issueTitle &&
    input.issueBody
  ) {
    // Fold in previously operator-approved commands for this repo so the
    // manager doesn't re-request them. Best-effort; file absence is fine.
    const additionalAllowedCommands = await readRepoAllowlist(directory);
    dispatchPrompt = buildManagerPrompt({
      issueNumber,
      issueTitle: input.issueTitle.trim(),
      issueBody: input.issueBody.trim(),
      repo,
      repoPath: directory,
      spawnCommand: spawnCmd,
      statusCommand: statusCmd,
      runId: run.id,
      agentBrowserAvailable,
      ...(additionalAllowedCommands.length > 0 ? { additionalAllowedCommands } : {}),
    });
  } else if (
    runType === "task" &&
    input.subtaskDescription &&
    input.taskBranch &&
    issueNumber !== undefined
  ) {
    dispatchPrompt = buildTaskPrompt({
      subtaskDescription: input.subtaskDescription.trim(),
      repo,
      repoPath: directory,
      issueNumber,
      agentBrowserAvailable,
      taskBranch: input.taskBranch.trim(),
      runId: run.id,
    });
  } else {
    dispatchPrompt = prompt;
  }

  if (parentRunId) {
    const parentRun = crucibleStore.runs.get(parentRunId);
    if (!parentRun) {
      throw new CrucibleHttpError({
        message: `Parent run '${parentRunId}' was not found.`,
        status: 404,
      });
    }
    if (parentRun.id === run.id) {
      throw new CrucibleHttpError({
        message: "A run cannot be its own parent.",
        status: 400,
      });
    }
  }

  crucibleStore.runs.set(run.id, run);

  // Langfuse tracing — create trace (top-level) or span (child)
  if (isTracingEnabled()) {
    try {
      if (run.type === "manager" && !run.parentRunId) {
        const span = startObservation(`Issue #${run.issueNumber ?? 0}: ${run.title}`, {
          input: { repo: run.repo, issueNumber: run.issueNumber, prompt: run.prompt },
          metadata: { runId: run.id, type: run.type },
        });
        run.langfuseTraceId = span.traceId;
        run.langfuseSpanId = span.id;
        run.langfuseSpan = span;
      } else if (run.parentRunId) {
        const parent = crucibleStore.runs.get(run.parentRunId);
        if (parent?.langfuseTraceId && parent.langfuseSpanId) {
          const span = startObservation(
            `${run.type}: ${run.title || run.prompt.slice(0, 80)}`,
            {
              input: { prompt: run.prompt },
              metadata: { runId: run.id, type: run.type, parentRunId: run.parentRunId },
            },
            {
              parentSpanContext: {
                traceId: parent.langfuseTraceId,
                spanId: parent.langfuseSpanId,
                traceFlags: 1,
              },
            },
          );
          run.langfuseTraceId = span.traceId;
          run.langfuseSpanId = span.id;
          run.langfuseSpan = span;
        }
      }
    } catch {
      /* tracing should never break the run */
    }
  }

  // Persist to SQLite
  dbPersistRun(run);

  await FS.writeFile(Path.join(directory, ".crucible-run-id"), `${run.id}\n`, "utf8");
  pushRunEvent(run, {
    type: "run.created",
    summary: `Preparing run in ${directory}`,
    payload: {
      directory,
      title: run.title,
      type: run.type,
      repo: run.repo,
      issueNumber: run.issueNumber ?? null,
      plannerMode,
      parentRunId: run.parentRunId ?? null,
      spawnCommand: run.spawnCommand ?? null,
      spawnTool: run.spawnTool ?? null,
      spawnNote: run.spawnNote ?? null,
    },
  });

  if (parentRunId) {
    const parentRun = crucibleStore.runs.get(parentRunId);
    if (parentRun) {
      addChildRun(parentRun, run);
    }
  }

  try {
    const server = await connectToOpenCodeServer({
      binaryPath: opencodeSettings.binaryPath,
      serverUrl: opencodeSettings.serverUrl,
    });
    const client = createOpenCodeSdkClient({
      baseUrl: server.url,
      directory,
      ...(server.external && opencodeSettings.serverPassword
        ? { serverPassword: opencodeSettings.serverPassword }
        : {}),
    });

    run.client = client;
    run.server = server;
    run.serverUrl = server.url;

    const session = await client.session.create({
      title: run.title,
      permission: buildOpenCodePermissionRules("full-access"),
    });

    if (!session.data) {
      throw new Error("OpenCode session.create returned no session payload.");
    }

    run.sessionId = session.data.id;
    setRunStatus(run, "running");
    pushRunEvent(run, {
      type: "session.created",
      summary: `Created OpenCode session ${session.data.id}`,
      payload: session.data,
    });

    const subscription = await client.event.subscribe(undefined, {
      signal: run.abortController.signal,
    });
    pushRunEvent(run, {
      type: "watch.ready",
      summary: "Attached event stream before prompt dispatch",
      payload: {
        sessionId: session.data.id,
      },
    });
    void watchRunEventStream(run, subscription);

    await client.session.promptAsync({
      sessionID: session.data.id,
      parts: [{ type: "text", text: dispatchPrompt }],
    });

    pushRunEvent(run, {
      type: "prompt.sent",
      summary: "Prompt sent to OpenCode",
      payload: {
        prompt: dispatchPrompt,
      },
    });

    return run;
  } catch (error) {
    run.abortController.abort();
    run.server?.close();
    setRunStatus(run, "error", error instanceof Error ? error.message : "Failed to start run.");
    pushRunEvent(run, {
      type: "run.error",
      summary: run.error ?? "Failed to start run.",
      payload: error,
    });
    throw error;
  }
}

async function getRunOrThrow(runId: string): Promise<CrucibleRunRecord> {
  const run = crucibleStore.runs.get(runId);
  if (!run) {
    throw new CrucibleHttpError({
      message: "Run not found.",
      status: 404,
    });
  }
  return run;
}

const handleCrucibleHttpError = (error: CrucibleHttpError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("crucible route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      { status: error.status },
    );
  });

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

function parseOwnerNameFromRemote(remoteUrl: string): string | null {
  // https://github.com/owner/name.git  or  https://github.com/owner/name
  // name can contain dots (e.g. manikrana.dev)
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  // git@github.com:owner/name.git
  const sshMatch = remoteUrl.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  return null;
}

function gitRemoteOrigin(dir: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

function contentTypeForPath(filePath: string): string {
  const ext = Path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".json":
      return "application/json";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "application/javascript";
    default:
      return "text/plain";
  }
}

// ---------------------------------------------------------------------------
// Screenshot attachment ingestion
// ---------------------------------------------------------------------------

const SCREENSHOT_MARKER_RE = /^SCREENSHOT_SAVED:\s+(\S+)$/gm;

function inferScreenshotLabel(filePath: string): string {
  if (/-before\.(png|jpe?g|webp)$/i.test(filePath)) return "before";
  if (/-after\.(png|jpe?g|webp)$/i.test(filePath)) return "after";
  return "";
}

function attachmentIdFor(runId: string, path: string): string {
  return createHash("sha1").update(`${runId}:${path}`).digest("hex").slice(0, 16);
}

/**
 * Scan an arbitrary text blob for SCREENSHOT_SAVED marker lines and persist
 * one attachment row per unique (runId, path). Idempotent — duplicates are
 * ignored at the SQL level via INSERT OR IGNORE + UNIQUE(run_id, path).
 *
 * Security: only paths under `runDirectory` are persisted. Traversal or
 * absolute paths pointing outside the worktree are silently dropped.
 */
function ingestScreenshotMarkers(params: {
  runId: string;
  runDirectory: string;
  text: string;
}): void {
  if (!params.text || params.text.indexOf("SCREENSHOT_SAVED:") === -1) return;
  const now = new Date().toISOString();
  // Reset regex lastIndex for each call (it's a /g regex)
  const re = new RegExp(SCREENSHOT_MARKER_RE.source, "gm");
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(params.text)) !== null) {
    const rawPath = match[1];
    if (!rawPath) continue;
    // Only accept absolute paths inside the run's worktree.
    const absolute = Path.resolve(rawPath);
    const dirPrefix = Path.resolve(params.runDirectory);
    if (!absolute.startsWith(dirPrefix + Path.sep) && absolute !== dirPrefix) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    persistAttachment({
      id: attachmentIdFor(params.runId, absolute),
      runId: params.runId,
      path: absolute,
      label: inferScreenshotLabel(absolute),
      createdAt: now,
    } satisfies CrucibleAttachment);
  }
}

// ---------------------------------------------------------------------------
// Approval marker ingestion + allowlist file helpers
// ---------------------------------------------------------------------------

const APPROVAL_MARKER_RE = /^REQUEST_APPROVAL:\s+([^|\n]+?)(?:\s*\|\s*(.*))?$/gm;

function approvalIdFor(runId: string, command: string): string {
  return createHash("sha1").update(`${runId}:${command}`).digest("hex").slice(0, 16);
}

/**
 * Scan an event text blob for REQUEST_APPROVAL marker lines and persist a
 * pending approval row per unique (runId, command). Also flips the run into
 * `needsInput: true` so the chat UI surfaces the request. Idempotent.
 *
 * Marker shape: `REQUEST_APPROVAL: <command> | <reason>` (reason optional).
 */
function ingestApprovalRequests(params: { run: CrucibleRunRecord; text: string }): void {
  if (!params.text || params.text.indexOf("REQUEST_APPROVAL:") === -1) return;
  const now = new Date().toISOString();
  const re = new RegExp(APPROVAL_MARKER_RE.source, "gm");
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  let any = false;
  while ((match = re.exec(params.text)) !== null) {
    const command = (match[1] ?? "").trim();
    const reason = (match[2] ?? "").trim();
    if (!command) continue;
    if (seen.has(command)) continue;
    seen.add(command);
    persistApproval({
      id: approvalIdFor(params.run.id, command),
      runId: params.run.id,
      repo: params.run.repo,
      command,
      reason,
      status: "pending",
      createdAt: now,
      addedToAllowlist: false,
    });
    any = true;
  }
  if (any) {
    params.run.needsInput = true;
  }
}

async function readRepoAllowlist(repoPath: string): Promise<string[]> {
  const p = Path.join(repoPath, ".crucible", "allowlist.json");
  try {
    const raw = await FS.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
    // { commands: [...] } fallback
    if (parsed && typeof parsed === "object") {
      const cmds = (parsed as { commands?: unknown }).commands;
      if (Array.isArray(cmds)) {
        return cmds.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      }
    }
    return [];
  } catch {
    return [];
  }
}

async function appendRepoAllowlist(repoPath: string, command: string): Promise<void> {
  const dir = Path.join(repoPath, ".crucible");
  const file = Path.join(dir, "allowlist.json");
  await FS.mkdir(dir, { recursive: true });
  const existing = await readRepoAllowlist(repoPath);
  if (existing.includes(command)) return;
  existing.push(command);
  await FS.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Route layers
// ---------------------------------------------------------------------------

export const crucibleConfigRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/config",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    return HttpServerResponse.jsonUnsafe(
      {
        suggestedDirectory: Path.join(OS.tmpdir(), "t3code-crucible-smoke"),
        workspaceDirectory: REPO_ROOT,
        spawnSubtaskCommand: `bun ${SPAWN_SUBTASK_SCRIPT_PATH}`,
        opencode: {
          enabled: settings.providers.opencode.enabled,
          binaryPath: settings.providers.opencode.binaryPath,
          hasExternalServer: settings.providers.opencode.serverUrl.trim().length > 0,
        },
      },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const crucibleRunCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/crucible/runs",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const payload = yield* HttpServerRequest.schemaBodyJson(CrucibleRunStartInput).pipe(
      Effect.mapError(
        (cause) =>
          new CrucibleHttpError({
            message: "Invalid Crucible run payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    const run = yield* Effect.tryPromise({
      try: () => startRun(payload, settings.providers.opencode),
      catch: (cause) =>
        cause instanceof CrucibleHttpError
          ? cause
          : new CrucibleHttpError({
              message: cause instanceof Error ? cause.message : "Failed to start Crucible run.",
              status: 500,
              cause,
            }),
    });
    const response = yield* Effect.tryPromise({
      try: () => serializeRun(run),
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to serialize Crucible run.",
          status: 500,
          cause,
        }),
    });
    return HttpServerResponse.jsonUnsafe(response, { status: 202 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

export const crucibleRunListRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/runs",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const repoFilter = Option.isSome(url)
      ? (url.value.searchParams.get("repo") ?? undefined)
      : undefined;
    const response = yield* Effect.tryPromise({
      try: () => serializeRunList(repoFilter),
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to serialize Crucible runs.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe(response, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// DELETE /api/crucible/runs — purge runs for a repo (and orphan children)
// ---------------------------------------------------------------------------

function collectRepoRunIds(repo: string): Set<string> {
  const directMatches = new Set<string>();
  for (const run of crucibleStore.runs.values()) {
    if (run.repo && run.repo === repo) {
      directMatches.add(run.id);
    }
  }

  // Walk parent -> child transitively so orphan children (spawned without --repo)
  // get swept along with their matched ancestor.
  const toVisit = [...directMatches];
  while (toVisit.length > 0) {
    const parentId = toVisit.pop()!;
    const parent = crucibleStore.runs.get(parentId);
    if (!parent) continue;
    for (const childId of parent.childRunIds) {
      if (directMatches.has(childId)) continue;
      directMatches.add(childId);
      toVisit.push(childId);
    }
  }

  return directMatches;
}

function teardownRun(run: CrucibleRunRecord): void {
  try {
    run.abortController.abort();
  } catch {
    // Abort can throw if already aborted; ignore.
  }
  try {
    run.server?.close();
  } catch {
    // Server close is best-effort during teardown.
  }
}

export const crucibleRunDeleteRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/crucible/runs",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    const repo = (url.value.searchParams.get("repo") ?? "").trim();
    if (repo.length === 0) {
      return yield* new CrucibleHttpError({
        message: "repo query parameter is required.",
        status: 400,
      });
    }

    const ids = collectRepoRunIds(repo);
    for (const id of ids) {
      const run = crucibleStore.runs.get(id);
      if (!run) continue;
      teardownRun(run);
      crucibleStore.runs.delete(id);
    }

    // Delete from SQLite
    dbDeleteRunsByRepo(repo);

    return HttpServerResponse.jsonUnsafe({ deleted: ids.size }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/runs/:runId/log — serve historical NDJSON event log
// ---------------------------------------------------------------------------

export const crucibleRunLogRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/runs/:runId/log",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({ message: "Invalid request URL.", status: 400 });
    }

    // Path: /api/crucible/runs/:runId/log → segments[3] = runId
    const segments = url.value.pathname.split("/").filter(Boolean);
    const runId = segments[3];
    if (!runId) {
      return yield* new CrucibleHttpError({ message: "Run id is required.", status: 400 });
    }

    const events = yield* Effect.tryPromise({
      try: async () => {
        const logPath = Path.join(CRUCIBLE_LOG_DIR, `${decodeURIComponent(runId)}.ndjson`);
        let raw: string;
        try {
          raw = await FS.readFile(logPath, "utf8");
        } catch {
          return [];
        }
        return raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      },
      catch: (cause) =>
        new CrucibleHttpError({ message: "Failed to read log.", status: 500, cause }),
    });

    return HttpServerResponse.jsonUnsafe({ events }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/runs/:runId/gh-status — poll GitHub PR status
// ---------------------------------------------------------------------------

const ghStatusCache = new Map<string, { at: number; data: unknown }>();
const GH_STATUS_CACHE_TTL_MS = 10_000;

export const crucibleRunGhStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/runs/:runId/gh-status",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({ message: "Invalid request URL.", status: 400 });
    }

    // Path: /api/crucible/runs/:runId/gh-status → segments[3] = runId
    const segments = url.value.pathname.split("/").filter(Boolean);
    const runId = segments[3];
    if (!runId) {
      return yield* new CrucibleHttpError({ message: "Run id is required.", status: 400 });
    }

    const run = crucibleStore.runs.get(decodeURIComponent(runId));
    if (!run) {
      return yield* new CrucibleHttpError({ message: "Run not found.", status: 404 });
    }

    if (!run.prUrl) {
      return HttpServerResponse.jsonUnsafe({ status: "no_pr" }, { status: 200 });
    }

    // Parse PR number + repo from the URL
    const prMatch = run.prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!prMatch) {
      return HttpServerResponse.jsonUnsafe({ status: "no_pr", raw: run.prUrl }, { status: 200 });
    }

    const repoSlug = prMatch[1]!;
    const prNumber = prMatch[2]!;
    const cacheKey = `${repoSlug}#${prNumber}`;

    // Check cache
    const cached = ghStatusCache.get(cacheKey);
    if (cached && Date.now() - cached.at < GH_STATUS_CACHE_TTL_MS) {
      return HttpServerResponse.jsonUnsafe(cached.data, { status: 200 });
    }

    const ghData = yield* Effect.tryPromise({
      try: async () => {
        const output = execSync(
          `gh pr view ${shellQuote(prNumber)} --repo ${shellQuote(repoSlug)} --json state,statusCheckRollup,mergeable,mergedAt`,
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 15_000,
          },
        );
        return JSON.parse(output) as unknown;
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message:
            cause instanceof Error
              ? `Failed to fetch PR status: ${cause.message}`
              : "Failed to fetch PR status.",
          status: 500,
          cause,
        }),
    });

    ghStatusCache.set(cacheKey, { at: Date.now(), data: ghData });
    return HttpServerResponse.jsonUnsafe(ghData, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

export const crucibleRunGetRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/runs/:runId",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    const runId = decodeURIComponent(url.value.pathname.split("/").at(-1) ?? "");
    if (!runId) {
      return yield* new CrucibleHttpError({
        message: "Run id is required.",
        status: 400,
      });
    }

    const run = yield* Effect.tryPromise({
      try: () => getRunOrThrow(runId),
      catch: (cause) =>
        cause instanceof CrucibleHttpError
          ? cause
          : new CrucibleHttpError({
              message: "Failed to load Crucible run.",
              status: 500,
              cause,
            }),
    });

    const response = yield* Effect.tryPromise({
      try: () => serializeRun(run),
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to serialize Crucible run.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe(response, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// POST /api/crucible/runs/:runId/approvals/:approvalId — approve/deny
// ---------------------------------------------------------------------------
//
// Body: { "approved": boolean, "addToAllowlist"?: boolean }
//
// On approve:
//   - approval row status -> "approved"
//   - if addToAllowlist (default true), command appended to
//     <repoPath>/.crucible/allowlist.json
//   - synthetic event pushed to the run so the manager agent sees
//     `APPROVED: <command>` in its next poll
// On deny:
//   - approval row status -> "denied"
//   - synthetic `DENIED: <command>` event pushed
// Run.needsInput flips back to false once no pending approvals remain.

export const crucibleRunApprovalResolveRouteLayer = HttpRouter.add(
  "POST",
  "/api/crucible/runs/:runId/approvals/:approvalId",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({ message: "Invalid request URL.", status: 400 });
    }

    // Path: /api/crucible/runs/:runId/approvals/:approvalId
    const segments = url.value.pathname.split("/").filter(Boolean);
    const runId = decodeURIComponent(segments.at(-3) ?? "");
    const approvalId = decodeURIComponent(segments.at(-1) ?? "");
    if (!runId || !approvalId) {
      return yield* new CrucibleHttpError({
        message: "Run id and approval id are required.",
        status: 400,
      });
    }

    const body = yield* Effect.mapError(request.json, () => new CrucibleHttpError({ message: "Invalid JSON body.", status: 400 }));
    const bodyRec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const approved = bodyRec.approved === true;
    const addToAllowlistRaw = bodyRec.addToAllowlist;
    const addToAllowlist = approved && addToAllowlistRaw !== false; // default true on approve

    const approval = getApprovalById(approvalId);
    if (!approval) {
      return yield* new CrucibleHttpError({ message: "Approval not found.", status: 404 });
    }
    if (approval.runId !== runId) {
      return yield* new CrucibleHttpError({
        message: "Approval does not belong to this run.",
        status: 400,
      });
    }
    if (approval.status !== "pending") {
      return HttpServerResponse.jsonUnsafe(
        { ok: true, approval, alreadyResolved: true },
        { status: 200 },
      );
    }

    const run = crucibleStore.runs.get(runId);
    if (!run) {
      return yield* new CrucibleHttpError({ message: "Run not found.", status: 404 });
    }

    const resolvedAt = new Date().toISOString();
    resolveApproval({
      id: approval.id,
      status: approved ? "approved" : "denied",
      addedToAllowlist: addToAllowlist,
      resolvedAt,
    });

    if (approved && addToAllowlist) {
      yield* Effect.tryPromise({
        try: () => appendRepoAllowlist(run.directory, approval.command),
        catch: (cause) =>
          new CrucibleHttpError({
            message: "Failed to update allowlist file.",
            status: 500,
            cause,
          }),
      });
    }

    // Push a synthetic event so the manager's next poll cycle sees the answer.
    const markerLine = approved ? `APPROVED: ${approval.command}` : `DENIED: ${approval.command}`;
    pushRunEvent(run, {
      type: "crucible.approval.resolved",
      summary: markerLine,
      payload: {
        approvalId: approval.id,
        command: approval.command,
        status: approved ? "approved" : "denied",
        addedToAllowlist: addToAllowlist,
      },
    });

    // Flip needsInput back to false if no other pending approvals remain.
    const stillPending = getApprovalsForRun(runId).some((a) => a.status === "pending");
    if (!stillPending) {
      run.needsInput = false;
    }

    const updatedApproval: CrucibleApproval = {
      ...approval,
      status: approved ? "approved" : "denied",
      addedToAllowlist: addToAllowlist,
      resolvedAt,
    };
    return HttpServerResponse.jsonUnsafe({ ok: true, approval: updatedApproval }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// POST /api/crucible/runs/:runId/message — append a user message to a run
// ---------------------------------------------------------------------------

const CrucibleRunMessageInput = Schema.Struct({
  text: Schema.String,
});

export const crucibleRunMessageRouteLayer = HttpRouter.add(
  "POST",
  "/api/crucible/runs/:runId/message",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    // Path: /api/crucible/runs/:runId/message → segments[3] = runId
    const runId = decodeURIComponent(url.value.pathname.split("/").at(-2) ?? "");
    if (!runId) {
      return yield* new CrucibleHttpError({
        message: "Run id is required.",
        status: 400,
      });
    }

    const payload = yield* HttpServerRequest.schemaBodyJson(CrucibleRunMessageInput).pipe(
      Effect.mapError(
        (cause) =>
          new CrucibleHttpError({
            message: "Invalid message payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const text = payload.text.trim();
    if (!text) {
      return yield* new CrucibleHttpError({
        message: "Message text is required.",
        status: 400,
      });
    }

    const run = yield* Effect.tryPromise({
      try: () => getRunOrThrow(runId),
      catch: (cause) =>
        cause instanceof CrucibleHttpError
          ? cause
          : new CrucibleHttpError({
              message: "Failed to load Crucible run.",
              status: 500,
              cause,
            }),
    });

    if (!run.client || !run.sessionId) {
      return yield* new CrucibleHttpError({
        message: "Run has no active OpenCode session to deliver the message to.",
        status: 409,
      });
    }

    if (run.status === "completed" || run.status === "error") {
      return yield* new CrucibleHttpError({
        message: `Run is ${run.status}; cannot queue new messages.`,
        status: 409,
      });
    }

    yield* Effect.tryPromise({
      try: () =>
        run.client!.session.promptAsync({
          sessionID: run.sessionId!,
          parts: [{ type: "text", text }],
        }),
      catch: (cause) =>
        new CrucibleHttpError({
          message: cause instanceof Error ? cause.message : "Failed to send message to session.",
          status: 500,
          cause,
        }),
    });

    // Synthesize a local event so the UI sees the user message immediately,
    // before opencode echoes it back through the stream.
    pushRunEvent(run, {
      type: "user.message.sent",
      summary: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      payload: {
        properties: {
          part: {
            type: "user-message",
            text,
            id: `user-${Date.now()}`,
          },
        },
      },
    });

    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 202 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/repos — list git repos in workspace dir
// ---------------------------------------------------------------------------

export const crucibleReposListRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/repos",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const serverConfig = yield* ServerConfig;
    const reposDir = Path.join(serverConfig.cwd, "repos");

    const repos = yield* Effect.tryPromise({
      try: async () => {
        let entries;
        try {
          entries = await FS.readdir(reposDir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
            return [];
          }
          throw error;
        }

        const results: { name: string; path: string; hasGit: boolean }[] = [];

        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const dirPath = Path.join(reposDir, entry.name);

          let hasGit = false;
          try {
            const stat = await FS.stat(Path.join(dirPath, ".git"));
            hasGit = stat.isDirectory();
          } catch {
            // not a git repo
          }

          if (!hasGit) continue;

          const remoteUrl = gitRemoteOrigin(dirPath);
          const ownerName = remoteUrl ? parseOwnerNameFromRemote(remoteUrl) : null;

          results.push({
            name: ownerName ?? entry.name,
            path: dirPath,
            hasGit,
          });
        }

        return results;
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to list repos.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe({ repos }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// POST /api/crucible/repos/clone — clone a repo by URL
// ---------------------------------------------------------------------------

const CrucibleCloneInput = Schema.Struct({
  url: Schema.String,
});

export const crucibleReposCloneRouteLayer = HttpRouter.add(
  "POST",
  "/api/crucible/repos/clone",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const payload = yield* HttpServerRequest.schemaBodyJson(CrucibleCloneInput).pipe(
      Effect.mapError(
        (cause) =>
          new CrucibleHttpError({
            message: "Invalid clone payload. Provide { url: string }.",
            status: 400,
            cause,
          }),
      ),
    );

    const serverConfig = yield* ServerConfig;
    const reposDir = Path.join(serverConfig.cwd, "repos");
    const repoUrl = payload.url.trim();

    if (repoUrl.length === 0) {
      return yield* new CrucibleHttpError({
        message: "url is required.",
        status: 400,
      });
    }

    const ownerName = parseOwnerNameFromRemote(repoUrl);
    const repoBaseName = ownerName?.split("/")[1] ?? Path.basename(repoUrl, ".git");
    const targetPath = Path.join(reposDir, repoBaseName);

    const repo = yield* Effect.tryPromise({
      try: async () => {
        // Check if already exists and is a git repo
        try {
          const stat = await FS.stat(Path.join(targetPath, ".git"));
          if (stat.isDirectory()) {
            return {
              name: ownerName ?? repoBaseName,
              path: targetPath,
              hasGit: true,
            };
          }
        } catch {
          // does not exist yet, proceed to clone
        }

        await FS.mkdir(reposDir, { recursive: true });
        execSync(`git clone ${shellQuote(repoUrl)} ${shellQuote(targetPath)}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });

        return {
          name: ownerName ?? repoBaseName,
          path: targetPath,
          hasGit: true,
        };
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message: cause instanceof Error ? `Clone failed: ${cause.message}` : "Clone failed.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe(repo, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/repos/:owner/:name/issues — fetch GitHub issues via gh CLI
// ---------------------------------------------------------------------------

export const crucibleRepoIssuesRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/repos/:owner/:name/issues",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    // Extract owner/name from the path: /api/crucible/repos/:owner/:name/issues
    const segments = url.value.pathname.split("/").filter(Boolean);
    // segments: ["api", "crucible", "repos", owner, name, "issues"]
    const owner = segments[3];
    const name = segments[4];
    if (!owner || !name) {
      return yield* new CrucibleHttpError({
        message: "owner and name are required path parameters.",
        status: 400,
      });
    }

    const repoSlug = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;

    const issues = yield* Effect.tryPromise({
      try: async () => {
        const output = execSync(
          `gh issue list --repo ${shellQuote(repoSlug)} --json number,title,body,labels,assignees,state,url --limit 50`,
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          },
        );
        return JSON.parse(output) as unknown[];
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message:
            cause instanceof Error
              ? `Failed to list issues: ${cause.message}`
              : "Failed to list issues.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe({ issues }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/files?path=<absolute> — serve files within workspace
// ---------------------------------------------------------------------------

export const crucibleFilesRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/files",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverConfig = yield* ServerConfig;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    const filePath = url.value.searchParams.get("path");
    if (!filePath || filePath.trim().length === 0) {
      return yield* new CrucibleHttpError({
        message: "path query parameter is required.",
        status: 400,
      });
    }

    // Security: resolve both and check prefix
    const workspaceDir = Path.resolve(serverConfig.cwd);
    const resolvedPath = Path.resolve(filePath);
    if (!resolvedPath.startsWith(workspaceDir + Path.sep) && resolvedPath !== workspaceDir) {
      return yield* new CrucibleHttpError({
        message: "Path is outside the workspace directory.",
        status: 403,
      });
    }

    const fileContent = yield* Effect.tryPromise({
      try: () => FS.readFile(resolvedPath),
      catch: (cause) =>
        new CrucibleHttpError({
          message:
            (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
              ? "File not found."
              : "Failed to read file.",
          status: (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? 404 : 500,
          cause,
        }),
    });

    const ct = contentTypeForPath(resolvedPath);

    return HttpServerResponse.raw(fileContent, {
      status: 200,
      headers: {
        "content-type": ct,
        "cache-control": "no-store",
      },
    });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// POST /api/crucible/eval/run — run eval tasks and verify outcomes
// ---------------------------------------------------------------------------

const EVAL_POLL_INTERVAL_MS = 5_000;
const EVAL_RUN_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes per task

const CrucibleEvalRunInput = Schema.Struct({
  taskIds: Schema.optionalKey(Schema.Array(Schema.String)),
});

function waitForRunCompletion(runId: string, timeoutMs: number): Promise<CrucibleRunRecord> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const poll = () => {
      const run = crucibleStore.runs.get(runId);
      if (!run) {
        reject(
          new CrucibleHttpError({
            message: `Run '${runId}' disappeared from store.`,
            status: 500,
          }),
        );
        return;
      }
      if (run.status === "completed" || run.status === "error") {
        resolve(run);
        return;
      }
      if (Date.now() >= deadline) {
        reject(
          new CrucibleHttpError({
            message: `Run '${runId}' did not complete within ${timeoutMs}ms.`,
            status: 504,
          }),
        );
        return;
      }
      setTimeout(poll, EVAL_POLL_INTERVAL_MS);
    };

    poll();
  });
}

export const crucibleEvalRunRouteLayer = HttpRouter.add(
  "POST",
  "/api/crucible/eval/run",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const payload = yield* HttpServerRequest.schemaBodyJson(CrucibleEvalRunInput).pipe(
      Effect.mapError(
        (cause) =>
          new CrucibleHttpError({
            message: "Invalid eval run payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;

    const requestedIds = payload.taskIds;
    const tasks =
      requestedIds && requestedIds.length > 0
        ? EVAL_TASKS.filter((t) => requestedIds.includes(t.id))
        : [...EVAL_TASKS];

    if (tasks.length === 0) {
      return yield* new CrucibleHttpError({
        message: "No matching eval tasks found.",
        status: 400,
      });
    }

    interface EvalRunResult {
      taskId: string;
      passed: boolean;
      duration: number;
      details?: Readonly<Record<string, unknown>>;
    }

    const opencodeSettings = settings.providers.opencode;
    const results = yield* Effect.tryPromise({
      try: async () => {
        const out: EvalRunResult[] = [];

        for (const task of tasks) {
          const startTime = Date.now();
          const taskDir = Path.join(
            OS.tmpdir(),
            `crucible-eval-${task.id}-${randomUUID().slice(0, 8)}`,
          );

          let result: EvalRunResult;
          try {
            const run = await startRun(
              {
                directory: taskDir,
                prompt: task.issueBody,
                title: `Eval: ${task.issueTitle}`,
                repo: task.repo,
                issueNumber: 0,
                type: "task",
                plannerMode: false,
              },
              opencodeSettings,
            );

            const completedRun = await waitForRunCompletion(run.id, EVAL_RUN_TIMEOUT_MS);
            const outcome = await checkEvalOutcome(task, completedRun.directory);
            const duration = Date.now() - startTime;

            result = {
              taskId: task.id,
              passed: outcome.passed,
              duration,
              details: {
                ...outcome.details,
                runId: completedRun.id,
                runStatus: completedRun.status,
                ...(outcome.reason ? { reason: outcome.reason } : {}),
              },
            };
          } catch (error) {
            const duration = Date.now() - startTime;
            result = {
              taskId: task.id,
              passed: false,
              duration,
              details: {
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }

          out.push(result);
        }

        return out;
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Eval run failed unexpectedly.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe({ results }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);
