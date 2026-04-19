/**
 * Crucible → Langfuse event reducer.
 *
 * The raw OpenCode event stream is extremely noisy: every token streaming
 * delta, every `session.status` flip, every intermediate `message.updated`
 * fires as its own SSE payload. Emitting one Langfuse observation per event
 * (the previous behaviour) turns the trace view into an unusable wall.
 *
 * This module replaces that with a stateful reducer that aggregates the raw
 * stream into clean, debug-friendly observations:
 *
 *   - One **generation** per assistant message (model name, full text,
 *     usage, reasoning as metadata).
 *   - One **span** per tool invocation, keyed by `part.id`, with full
 *     `input` / `output` (no truncation).
 *   - A short list of explicit **events** for things operators need to see
 *     at a glance — `permission.asked`, `session.error`, `watch.error`,
 *     `crucible.needs_input`, `crucible.pr.detected`.
 *   - Everything else (deltas, session.status flips, diffs, session.updated,
 *     watch.ready, run.created, prompt.sent) is dropped at the Langfuse
 *     layer but still lives in the NDJSON event log + UI event stream.
 *
 * Tracing errors must never surface to the run — every entry point is
 * guarded by try/catch in the caller and by defensive reads inside.
 *
 * @module crucible/langfuseReducer
 */

import type { LangfuseGeneration, LangfuseSpan } from "./tracing.ts";

// ---------------------------------------------------------------------------
// Public state + API
// ---------------------------------------------------------------------------

/**
 * Per-run trace aggregation state. One instance lives on each
 * `CrucibleRunRecord` for the lifetime of the run.
 */
export interface RunTraceState {
  /** Currently open assistant generation, if any. */
  messageGen?: LangfuseGeneration;
  /** The OpenCode message id currently being aggregated. */
  messageId?: string;
  /** Accumulated text parts for the active message (in arrival order). */
  messageTextBuffer: string[];
  /** Accumulated reasoning parts for the active message. */
  messageReasoningBuffer: string[];
  /** Model identifier reported for the active message. */
  messageModel?: string;
  /** Provider identifier reported for the active message. */
  messageProvider?: string;
  /**
   * Currently open tool spans, keyed by OpenCode `part.id` so we can match
   * `running` → `completed` updates to the same observation.
   */
  toolSpans: Map<string, OpenToolSpan>;
}

interface OpenToolSpan {
  readonly span: LangfuseSpan;
  readonly tool: string;
}

/**
 * Minimal subset of `CrucibleRunRecord` the reducer needs. Kept local so
 * the reducer does not have a circular dependency on `http.ts`.
 */
export interface RunTraceContext {
  readonly id: string;
  readonly type: "manager" | "task";
  readonly sessionId?: string;
  readonly langfuseSpan?: LangfuseSpan;
  readonly trace: RunTraceState;
  prUrl?: string;
}

export interface ReducerEvent {
  readonly type: string;
  readonly summary: string;
  readonly payload: unknown;
}

export function initRunTraceState(): RunTraceState {
  return {
    messageTextBuffer: [],
    messageReasoningBuffer: [],
    toolSpans: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Project a single Crucible run event onto the Langfuse trace. Never throws.
 */
export function reduceToLangfuse(run: RunTraceContext, event: ReducerEvent): void {
  if (!run.langfuseSpan) return;
  try {
    dispatch(run, event);
  } catch {
    /* tracing must never break the run */
  }
}

/**
 * Close any still-open generations/tool spans and stamp the final trace
 * output. Called from `setRunStatus` when a run transitions to a terminal
 * status.
 */
export function finalizeRunTrace(
  run: RunTraceContext,
  terminalStatus: "completed" | "error",
  extra: {
    readonly error?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly durationMs?: number;
    readonly childRunIds?: ReadonlyArray<string>;
  },
): void {
  if (!run.langfuseSpan) return;
  try {
    // Close any dangling tool spans — agent aborted mid-tool or similar.
    for (const { span, tool } of run.trace.toolSpans.values()) {
      try {
        span.update({
          level: terminalStatus === "error" ? "ERROR" : "WARNING",
          statusMessage:
            terminalStatus === "error"
              ? `Run ended with error while '${tool}' was still open`
              : `Run completed while '${tool}' was still open`,
        });
        span.end();
      } catch {
        /* noop */
      }
    }
    run.trace.toolSpans.clear();

    // Close any open generation without a corresponding `message.updated`.
    const openGen = run.trace.messageGen;
    if (openGen) {
      try {
        openGen.update({
          output: run.trace.messageTextBuffer.join("").slice() || undefined,
          ...(run.trace.messageReasoningBuffer.length > 0
            ? { metadata: { reasoning: run.trace.messageReasoningBuffer.join("") } }
            : {}),
          level: terminalStatus === "error" ? "ERROR" : "WARNING",
          statusMessage: "Generation was not closed by an explicit message.updated.",
        });
        openGen.end();
      } catch {
        /* noop */
      }
      resetActiveMessage(run.trace);
    }

    // Stamp the final trace output.
    try {
      run.langfuseSpan.update({
        output: {
          status: terminalStatus,
          ...(extra.error ? { error: extra.error } : {}),
          ...(run.prUrl ? { prUrl: run.prUrl } : {}),
          ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
          ...(extra.startedAt ? { startedAt: extra.startedAt } : {}),
          ...(extra.completedAt ? { completedAt: extra.completedAt } : {}),
          ...(extra.childRunIds && extra.childRunIds.length > 0
            ? { childRunIds: [...extra.childRunIds] }
            : {}),
        },
        ...(terminalStatus === "error"
          ? { level: "ERROR", statusMessage: extra.error ?? "Run ended with error." }
          : {}),
      });
      run.langfuseSpan.end();
    } catch {
      /* noop */
    }
  } catch {
    /* tracing must never break the run */
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resetActiveMessage(trace: RunTraceState): void {
  delete trace.messageGen;
  delete trace.messageId;
  trace.messageTextBuffer = [];
  trace.messageReasoningBuffer = [];
  delete trace.messageModel;
  delete trace.messageProvider;
}

function baseMetadata(run: RunTraceContext): Record<string, unknown> {
  return {
    runId: run.id,
    runType: run.type,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  };
}

/** Narrow a value to a plain object. */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface UsageTotals {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

function extractUsage(source: Record<string, unknown> | null): UsageTotals | null {
  if (!source) return null;
  const usage =
    asObject(source.usage) ??
    asObject(asObject(source.properties)?.usage) ??
    asObject(asObject(source.message)?.usage) ??
    asObject(asObject(asObject(source.properties)?.message)?.usage);
  if (!usage) return null;
  const promptTokens =
    asNumber(usage.promptTokens) ?? asNumber(usage.inputTokens) ?? asNumber(usage.prompt_tokens);
  const completionTokens =
    asNumber(usage.completionTokens) ??
    asNumber(usage.outputTokens) ??
    asNumber(usage.completion_tokens);
  const totalTokens = asNumber(usage.totalTokens) ?? asNumber(usage.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return null;
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Dispatcher — the real work
// ---------------------------------------------------------------------------

function dispatch(run: RunTraceContext, event: ReducerEvent): void {
  switch (event.type) {
    // ---------------- OpenCode stream events ----------------
    case "message.updated":
      handleMessageUpdated(run, event);
      return;
    case "message.part.updated":
      handleMessagePartUpdated(run, event);
      return;
    case "session.error":
      handleSessionError(run, event);
      return;
    case "permission.asked":
      handlePermissionAsked(run, event);
      return;

    // Noise — drop at the Langfuse layer but keep in NDJSON + in-memory ring.
    case "message.part.delta":
    case "session.status":
    case "session.updated":
    case "session.diff":
    case "watch.ready":
    case "run.created":
    case "run.child.created":
    case "prompt.sent":
      return;

    // ---------------- Custom Crucible events ----------------
    case "crucible.pr.detected":
      handlePrDetected(run, event);
      return;
    case "crucible.needs_input":
      emitEvent(run, event, "WARNING");
      return;
    case "watch.error":
      emitEvent(run, event, "ERROR");
      return;
    case "run.error":
      emitEvent(run, event, "ERROR");
      return;

    // ---------------- Fallback ----------------
    default:
      // Unknown types get a single DEFAULT event so nothing is silently dropped
      // if a new OpenCode event type appears. Cheap because these should be rare.
      emitEvent(run, event, "DEFAULT");
      return;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleMessageUpdated(run: RunTraceContext, event: ReducerEvent): void {
  const payload = asObject(event.payload);
  const properties = asObject(payload?.properties) ?? payload;
  const info = asObject(properties?.info) ?? asObject(properties?.message);
  if (!info) return;

  const messageId = asString(info.id);
  const role = asString(info.role);
  if (!messageId || role !== "assistant") return;

  const status = deriveMessageStatus(info);
  const model = asString(info.modelID) ?? asString(info.model);
  const provider = asString(info.providerID) ?? asString(info.provider);

  // Opening: the first time we see this assistant message, start a generation.
  if (!run.trace.messageGen || run.trace.messageId !== messageId) {
    // If a different message was open, close it gracefully first.
    if (run.trace.messageGen && run.trace.messageId && run.trace.messageId !== messageId) {
      try {
        run.trace.messageGen.update({
          output: run.trace.messageTextBuffer.join("") || undefined,
          level: "WARNING",
          statusMessage: "Replaced before message.updated status=completed.",
        });
        run.trace.messageGen.end();
      } catch {
        /* noop */
      }
      resetActiveMessage(run.trace);
    }

    if (!run.langfuseSpan) return;
    const name = model ? `assistant (${model})` : "assistant";
    const gen = run.langfuseSpan.startObservation(
      name,
      {
        ...(model ? { model } : {}),
        metadata: {
          ...baseMetadata(run),
          messageId,
          ...(provider ? { provider } : {}),
        },
      },
      { asType: "generation" },
    );
    run.trace.messageGen = gen;
    run.trace.messageId = messageId;
    if (model) run.trace.messageModel = model;
    if (provider) run.trace.messageProvider = provider;
  }

  // Merge any text accumulated on the message itself (OpenCode sometimes
  // delivers `message.updated` with the parts array already populated).
  const partsArray = Array.isArray(info.parts) ? info.parts : undefined;
  if (partsArray) {
    const text = joinTextParts(partsArray);
    if (text && run.trace.messageTextBuffer.length === 0) {
      run.trace.messageTextBuffer.push(text);
    }
    const reasoning = joinReasoningParts(partsArray);
    if (reasoning && run.trace.messageReasoningBuffer.length === 0) {
      run.trace.messageReasoningBuffer.push(reasoning);
    }
  }

  // Closing: once the message is completed/errored, flush the generation.
  if (status === "completed" || status === "error") {
    const gen = run.trace.messageGen;
    if (!gen) return;
    const usage = extractUsage(info) ?? extractUsage(properties) ?? extractUsage(payload);
    const text = run.trace.messageTextBuffer.join("");
    const reasoning = run.trace.messageReasoningBuffer.join("");
    try {
      gen.update({
        ...(text.length > 0 ? { output: text } : {}),
        ...(usage ? { usageDetails: usage } : {}),
        ...(run.trace.messageModel ? { model: run.trace.messageModel } : {}),
        metadata: {
          ...baseMetadata(run),
          messageId,
          ...(run.trace.messageProvider ? { provider: run.trace.messageProvider } : {}),
          ...(reasoning.length > 0 ? { reasoning } : {}),
        },
        ...(status === "error"
          ? { level: "ERROR", statusMessage: "Assistant message ended with error." }
          : {}),
      });
      gen.end();
    } catch {
      /* noop */
    }
    resetActiveMessage(run.trace);
  }
}

function deriveMessageStatus(info: Record<string, unknown>): string | undefined {
  const status = asObject(info.status);
  if (status) {
    const inner = asString(status.type);
    if (inner) return inner;
  }
  if (asObject(info.time)?.completed !== undefined) return "completed";
  const tsError = asObject(info.time)?.error;
  if (tsError !== undefined && tsError !== null) return "error";
  return asString(info.status);
}

function joinTextParts(parts: ReadonlyArray<unknown>): string {
  const out: string[] = [];
  for (const part of parts) {
    const p = asObject(part);
    if (!p) continue;
    if (p.type === "text") {
      const text = asString(p.text);
      if (text) out.push(text);
    }
  }
  return out.join("");
}

function joinReasoningParts(parts: ReadonlyArray<unknown>): string {
  const out: string[] = [];
  for (const part of parts) {
    const p = asObject(part);
    if (!p) continue;
    if (p.type === "reasoning") {
      const text = asString(p.text);
      if (text) out.push(text);
    }
  }
  return out.join("");
}

function handleMessagePartUpdated(run: RunTraceContext, event: ReducerEvent): void {
  const payload = asObject(event.payload);
  const properties = asObject(payload?.properties) ?? payload;
  const part = asObject(properties?.part);
  if (!part) return;

  const partType = asString(part.type);
  const partId = asString(part.id);

  // Tool calls: keyed by part.id so we can close on completion.
  if (partType === "tool" && partId) {
    handleToolPart(run, part, partId);
    return;
  }

  // Question part: treated as a WARNING event.
  if (partType === "question") {
    emitEvent(run, event, "WARNING");
    return;
  }

  // Text part streaming updates — buffer into the active generation and skip
  // creating observations. The full text flushes when message.updated fires.
  if (partType === "text") {
    const text = asString(part.text);
    if (text && run.trace.messageId) {
      // Replace the buffer with the latest full text — OpenCode sends the
      // full accumulated text on each update, not just the delta.
      run.trace.messageTextBuffer = [text];
    }
    return;
  }

  if (partType === "reasoning") {
    const text = asString(part.text);
    if (text && run.trace.messageId) {
      run.trace.messageReasoningBuffer = [text];
    }
    return;
  }

  // Other part types (step-start, step-end, etc.) are internal bookkeeping.
}

function handleToolPart(run: RunTraceContext, part: Record<string, unknown>, partId: string): void {
  const toolName = asString(part.tool) ?? "tool";
  const state = asObject(part.state);
  const statusType = state ? asString(state.status) : undefined;

  const existing = run.trace.toolSpans.get(partId);

  // Open the span on first sighting (any non-terminal status).
  if (!existing) {
    if (!run.langfuseSpan) return;
    const input = state ? (state.input as unknown) : undefined;
    const span = run.langfuseSpan.startObservation(
      `tool: ${toolName}`,
      {
        ...(input !== undefined ? { input } : {}),
        metadata: {
          ...baseMetadata(run),
          partId,
          tool: toolName,
        },
      },
      { asType: "span" },
    );
    run.trace.toolSpans.set(partId, { span, tool: toolName });
  }

  // Close the span if the state is terminal.
  if (statusType === "completed" || statusType === "error") {
    const entry = run.trace.toolSpans.get(partId);
    if (!entry) return;
    const stateObj = state ?? {};
    const output =
      (stateObj.output as unknown) ??
      (asObject(stateObj.metadata) as Record<string, unknown> | null)?.output;
    const error = asString(stateObj.error);
    try {
      entry.span.update({
        ...(output !== undefined ? { output } : {}),
        ...(statusType === "error"
          ? { level: "ERROR", statusMessage: error ?? `tool '${entry.tool}' failed` }
          : {}),
      });
      entry.span.end();
    } catch {
      /* noop */
    }
    run.trace.toolSpans.delete(partId);
  }
}

function handleSessionError(run: RunTraceContext, event: ReducerEvent): void {
  // Close dangling gen/tool spans with ERROR so the trace reflects reality.
  for (const { span } of run.trace.toolSpans.values()) {
    try {
      span.update({ level: "ERROR", statusMessage: "Session errored before tool completed." });
      span.end();
    } catch {
      /* noop */
    }
  }
  run.trace.toolSpans.clear();
  if (run.trace.messageGen) {
    try {
      run.trace.messageGen.update({
        level: "ERROR",
        statusMessage: "Session errored before assistant message completed.",
        output: run.trace.messageTextBuffer.join("") || undefined,
      });
      run.trace.messageGen.end();
    } catch {
      /* noop */
    }
    resetActiveMessage(run.trace);
  }
  emitEvent(run, event, "ERROR");
}

function handlePermissionAsked(run: RunTraceContext, event: ReducerEvent): void {
  emitEvent(run, event, "WARNING");
}

function handlePrDetected(run: RunTraceContext, event: ReducerEvent): void {
  if (!run.langfuseSpan) return;
  const payload = asObject(event.payload);
  const prUrl = asString(payload?.prUrl);
  try {
    run.langfuseSpan.update({
      output: {
        ...(prUrl ? { prUrl } : {}),
        prDetectedAt: new Date().toISOString(),
      },
    });
  } catch {
    /* noop */
  }
  // Also emit a short event so the timeline shows it clearly.
  emitEvent(run, event, "DEFAULT");
}

function emitEvent(
  run: RunTraceContext,
  event: ReducerEvent,
  level: "DEFAULT" | "WARNING" | "ERROR" | "DEBUG",
): void {
  if (!run.langfuseSpan) return;
  try {
    run.langfuseSpan.startObservation(
      event.type,
      {
        input: asSafe(event.payload),
        metadata: {
          ...baseMetadata(run),
          summary: event.summary,
        },
        ...(level !== "DEFAULT" ? { level } : {}),
      },
      { asType: "event" },
    );
  } catch {
    /* noop */
  }
}

/** Return payload as-is when it is a plain object, otherwise wrap it. */
function asSafe(payload: unknown): unknown {
  if (payload === undefined || payload === null) return undefined;
  if (typeof payload === "object") return payload;
  return { value: payload };
}
