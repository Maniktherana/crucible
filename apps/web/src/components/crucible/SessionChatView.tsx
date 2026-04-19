import {
  ArrowDownIcon,
  ChevronRightIcon,
  GitBranchIcon,
  ImageIcon,
  TerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { RunStatusBadge } from "./RunStatusBadge";
import type { CrucibleRun, CrucibleRunEvent } from "./types";

// Number of lines shown before the "Show more" truncation kicks in.
const TRUNCATE_LINES = 20;

interface SessionChatViewProps {
  run: CrucibleRun;
  /** All task runs known for the parent manager run, used to resolve spawn child status. */
  taskRuns: CrucibleRun[];
  /** Invoked when the user clicks into a spawned child run. */
  onSelectRun?: (runId: string) => void;
}

// --- Message model ------------------------------------------------------------

interface BaseMsg {
  id: string;
  timestamp: string;
}

type ChatMessage =
  | (BaseMsg & { kind: "text"; content: string })
  | (BaseMsg & { kind: "reasoning"; content: string })
  | (BaseMsg & {
      kind: "tool-call";
      toolName: string;
      commandText: string;
      rawInput: unknown;
    })
  | (BaseMsg & { kind: "tool-result"; output: string })
  | (BaseMsg & {
      kind: "spawn";
      prompt: string;
      childRunId?: string;
      rawInput: unknown;
    })
  | (BaseMsg & { kind: "step-start" })
  | (BaseMsg & { kind: "system"; content: string });

// --- Payload helpers ----------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringifySafe(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Drill into the nested opencode event shape:
 *   event.payload = { type: "message.part.updated", properties: { part: {...} } }
 *
 * Returns the inner `part` record or `null` when this event does not carry one.
 */
function partOf(event: CrucibleRunEvent): Record<string, unknown> | null {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const props = asRecord(payload.properties);
  if (!props) return null;
  return asRecord(props.part);
}

/**
 * Tool results can arrive as a string, a wrapper like `{ type, value }` (AI SDK
 * shape), or an array of content blocks. Collapse to a human-readable string.
 */
function extractToolResult(output: unknown): string {
  if (typeof output === "string") return output;
  const rec = asRecord(output);
  if (rec) {
    if (typeof rec.value === "string") return rec.value;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.stdout === "string") return rec.stdout;
    if (Array.isArray(rec.content)) {
      return rec.content
        .map((c) => {
          const cr = asRecord(c);
          if (cr && typeof cr.text === "string") return cr.text;
          return stringifySafe(c);
        })
        .join("\n");
    }
  }
  if (Array.isArray(output)) {
    return output
      .map((c) => {
        const cr = asRecord(c);
        if (cr && typeof cr.text === "string") return cr.text;
        return stringifySafe(c);
      })
      .join("\n");
  }
  return stringifySafe(output);
}

function extractCommandText(input: unknown): string {
  if (typeof input === "string") return input;
  const rec = asRecord(input);
  if (!rec) return "";
  if (typeof rec.command === "string") return rec.command;
  if (typeof rec.cmd === "string") return rec.cmd;
  if (typeof rec.script === "string") return rec.script;
  return stringifySafe(input);
}

function isSpawnSubtask(toolName: string, commandText: string, input: unknown): boolean {
  const name = toolName.toLowerCase();
  if (name.includes("spawn-subtask") || name.includes("spawn_subtask")) return true;
  if (commandText.includes("spawn-subtask")) return true;
  const rec = asRecord(input);
  if (rec && typeof rec.tool === "string" && rec.tool.includes("spawn-subtask")) return true;
  return false;
}

function extractSpawnPrompt(input: unknown, commandText: string): string {
  const rec = asRecord(input);
  if (rec) {
    if (typeof rec.prompt === "string" && rec.prompt.trim()) return rec.prompt;
    if (typeof rec.task === "string" && rec.task.trim()) return rec.task;
    if (typeof rec.description === "string" && rec.description.trim()) return rec.description;
  }
  // Try the first quoted argument in the bash command.
  const quoted = commandText.match(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/);
  if (quoted) return quoted[1] ?? quoted[2] ?? commandText;
  const idx = commandText.indexOf("spawn-subtask");
  if (idx >= 0) {
    return commandText.slice(idx + "spawn-subtask".length).trim();
  }
  return commandText;
}

function stableKey(event: CrucibleRunEvent, part: Record<string, unknown> | null): string {
  if (part) {
    const candidate =
      (part.id as string | undefined) ??
      (part.partId as string | undefined) ??
      (part.part_id as string | undefined) ??
      (part.partID as string | undefined);
    if (candidate) return candidate;
  }
  return event.id;
}

/**
 * Parse raw run events into an ordered, deduplicated list of chat messages.
 *
 * opencode's server emits `message.part.updated` events whose payload has a
 * nested shape:
 *
 *   event.payload = {
 *     type: "message.part.updated",
 *     properties: {
 *       sessionID, messageID,
 *       part: { type: "text" | "tool-invocation" | "tool-result" | "reasoning" | "step-start",
 *               id: "prt_...", text?, toolName?, input?, output? }
 *     }
 *   }
 *
 * Each update carries the *full* part-so-far for a stable `part.id`, so we
 * upsert by that id — the latest update replaces earlier ones while keeping
 * the original position in the conversation.
 */
function parseMessages(events: CrucibleRunEvent[], childRunIds: string[]): ChatMessage[] {
  const entries: { key: string; msg: ChatMessage }[] = [];
  const keyToIndex = new Map<string, number>();
  const spawnKeyToChildId = new Map<string, string>();
  let spawnCursor = 0;

  const upsert = (key: string, msg: ChatMessage) => {
    const existing = keyToIndex.get(key);
    if (existing !== undefined) {
      entries[existing] = { key, msg };
    } else {
      keyToIndex.set(key, entries.length);
      entries.push({ key, msg });
    }
  };

  // Prefix-extend fallback for text/reasoning parts that happen to lack a
  // stable `part.id` (defensive — opencode usually provides one).
  const tryPrefixExtend = (text: string, at: string, kind: "text" | "reasoning"): boolean => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const prev = entries[i]!.msg;
      if (prev.kind === "text" || prev.kind === "reasoning") {
        if (prev.kind === kind && text.startsWith(prev.content) && text !== prev.content) {
          entries[i]!.msg = { ...prev, content: text, timestamp: at };
          return true;
        }
        break; // only check the immediate prior message-ish entry
      }
    }
    return false;
  };

  for (const event of events) {
    if (event.type !== "message.part.updated") continue;
    const part = partOf(event);
    if (!part) continue;
    const partType = part.type;
    const key = stableKey(event, part);

    if (partType === "text" || partType === "reasoning") {
      const content = typeof part.text === "string" ? part.text : "";
      if (!content.trim()) continue;

      const hasStableKey = key !== event.id;
      if (!hasStableKey && tryPrefixExtend(content, event.at, partType)) continue;

      upsert(key, {
        id: key,
        kind: partType,
        content,
        timestamp: event.at,
      });
      continue;
    }

    if (partType === "step-start") {
      upsert(key, {
        id: key,
        kind: "step-start",
        timestamp: event.at,
      });
      continue;
    }

    if (partType === "tool-invocation" || partType === "tool-call") {
      const toolName =
        (part.toolName as string | undefined) ??
        (part.tool as string | undefined) ??
        (part.name as string | undefined) ??
        "tool";
      const commandText = extractCommandText(part.input);

      if (isSpawnSubtask(toolName, commandText, part.input)) {
        let childRunId = spawnKeyToChildId.get(key);
        if (!childRunId && spawnCursor < childRunIds.length) {
          const next = childRunIds[spawnCursor++];
          if (next) {
            childRunId = next;
            spawnKeyToChildId.set(key, next);
          }
        }
        upsert(key, {
          id: key,
          kind: "spawn",
          prompt: extractSpawnPrompt(part.input, commandText),
          ...(childRunId ? { childRunId } : {}),
          rawInput: part.input,
          timestamp: event.at,
        });
        continue;
      }

      upsert(key, {
        id: key,
        kind: "tool-call",
        toolName,
        commandText,
        rawInput: part.input,
        timestamp: event.at,
      });
      continue;
    }

    if (partType === "tool-result") {
      const raw = part.output ?? part.result ?? part.stdout ?? "";
      upsert(key, {
        id: key,
        kind: "tool-result",
        output: extractToolResult(raw),
        timestamp: event.at,
      });
      continue;
    }
  }

  return entries.map((e) => e.msg);
}

// --- Rendering ---------------------------------------------------------------

interface ToolChrome {
  label: string;
  border: string;
  header: string;
  text: string;
  icon: typeof TerminalIcon;
}

function chromeForTool(toolName: string, commandText: string): ToolChrome {
  const name = toolName.toLowerCase();
  const cmd = commandText.trim();

  if (name.includes("agent-browser") || cmd.includes("agent-browser")) {
    return {
      label: `agent-browser${name !== "bash" && name !== "shell" ? "" : ""}`,
      border: "border-green-500/30",
      header: "bg-green-500/10 text-green-300",
      text: "text-green-300",
      icon: ImageIcon,
    };
  }

  if (name === "bash" || name === "shell" || name === "execute") {
    return {
      label: name,
      border: "border-blue-500/30",
      header: "bg-blue-500/10 text-blue-300",
      text: "text-blue-300",
      icon: TerminalIcon,
    };
  }

  return {
    label: toolName,
    border: "border-border",
    header: "bg-muted/60 text-muted-foreground",
    text: "text-muted-foreground",
    icon: TerminalIcon,
  };
}

function MarkdownBubble({ text, dim }: { text: string; dim?: boolean }) {
  return (
    <div
      className={cn(
        "max-w-none text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[.85em] [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_pre]:text-xs [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
        dim && "text-muted-foreground",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function TextMessage({ content }: { content: string }) {
  return (
    <div className="flex gap-2">
      <Badge variant="secondary" size="sm" className="mt-0.5 shrink-0 text-[10px]">
        Agent
      </Badge>
      <div className="min-w-0 flex-1 rounded-lg bg-muted/30 px-3 py-2">
        <MarkdownBubble text={content} />
      </div>
    </div>
  );
}

function ReasoningMessage({ content }: { content: string }) {
  return (
    <details className="rounded-lg border border-dashed bg-muted/10 px-3 py-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <ChevronRightIcon className="h-3 w-3 transition-transform duration-150 group-open:rotate-90" />
        <span className="italic">Thinking…</span>
      </summary>
      <div className="mt-2 border-t pt-2">
        <MarkdownBubble text={content} dim />
      </div>
    </details>
  );
}

function ToolCallMessage({ toolName, commandText }: { toolName: string; commandText: string }) {
  const chrome = chromeForTool(toolName, commandText);
  const Icon = chrome.icon;
  return (
    <div className={cn("overflow-hidden rounded-lg border", chrome.border)}>
      <div
        className={cn("flex items-center gap-1.5 px-2 py-1 font-mono text-[11px]", chrome.header)}
      >
        <Icon className="h-3 w-3" />
        <span className="font-semibold">{chrome.label}</span>
        {toolName !== chrome.label && <span className="opacity-60">({toolName})</span>}
      </div>
      <pre className="overflow-x-auto bg-background px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {commandText || "(no command)"}
      </pre>
    </div>
  );
}

function ToolResultMessage({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => output.split("\n"), [output]);
  const isTruncated = lines.length > TRUNCATE_LINES;
  const shown = !isTruncated || expanded ? lines : lines.slice(0, TRUNCATE_LINES);
  const hiddenCount = lines.length - shown.length;

  if (!output.trim()) {
    return (
      <div className="ml-6 text-xs text-muted-foreground/70 italic">
        → <span className="ml-1">(no output)</span>
      </div>
    );
  }

  return (
    <div className="ml-6 rounded-md border border-border/60 bg-background/50 px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>→ result</span>
      </div>
      <pre className="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {shown.join("\n")}
      </pre>
      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[11px] text-primary hover:underline"
        >
          {expanded ? "Show less" : `Show more (${hiddenCount} more lines)`}
        </button>
      )}
    </div>
  );
}

function SpawnMessage({
  prompt,
  childRunId,
  childRun,
  onSelectRun,
}: {
  prompt: string;
  childRunId?: string;
  childRun?: CrucibleRun;
  onSelectRun?: (id: string) => void;
}) {
  const previewPrompt = prompt.length > 220 ? `${prompt.slice(0, 220)}…` : prompt;
  return (
    <div className="overflow-hidden rounded-lg border border-purple-500/40 bg-purple-500/5">
      <div className="flex items-center gap-1.5 border-b border-purple-500/30 bg-purple-500/10 px-3 py-1.5 font-mono text-[11px] text-purple-300">
        <GitBranchIcon className="h-3 w-3" />
        <span className="font-semibold uppercase tracking-wider">Spawned Subtask</span>
        {childRun && <RunStatusBadge status={childRun.status} showLabel />}
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-sm leading-snug whitespace-pre-wrap">{previewPrompt}</p>
        {childRunId && onSelectRun ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onSelectRun(childRunId)}
            className="text-xs"
          >
            View Task →
          </Button>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">
            {childRun ? "Child run not selectable" : "Awaiting child run…"}
          </p>
        )}
      </div>
    </div>
  );
}

function SystemMessage({ content }: { content: string }) {
  return <div className="text-center text-[11px] text-muted-foreground/70 italic">{content}</div>;
}

function StepStartDivider() {
  return (
    <div
      className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60"
      aria-hidden
    >
      <span className="h-px flex-1 bg-border/60" />
      <span>step</span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function ChatMessageRow({
  message,
  taskRunMap,
  onSelectRun,
}: {
  message: ChatMessage;
  taskRunMap: Map<string, CrucibleRun>;
  onSelectRun?: (id: string) => void;
}) {
  switch (message.kind) {
    case "text":
      return <TextMessage content={message.content} />;
    case "reasoning":
      return <ReasoningMessage content={message.content} />;
    case "tool-call":
      return <ToolCallMessage toolName={message.toolName} commandText={message.commandText} />;
    case "tool-result":
      return <ToolResultMessage output={message.output} />;
    case "spawn": {
      const childRun = message.childRunId ? taskRunMap.get(message.childRunId) : undefined;
      return (
        <SpawnMessage
          prompt={message.prompt}
          {...(message.childRunId !== undefined ? { childRunId: message.childRunId } : {})}
          {...(childRun ? { childRun } : {})}
          {...(onSelectRun ? { onSelectRun } : {})}
        />
      );
    }
    case "step-start":
      return <StepStartDivider />;
    case "system":
      return <SystemMessage content={message.content} />;
  }
}

// --- Auto-scroll container ---------------------------------------------------

const AUTO_SCROLL_THRESHOLD_PX = 48;

export function SessionChatView({ run, taskRuns, onSelectRun }: SessionChatViewProps) {
  const messages = useMemo(
    () => parseMessages(run.events, run.childRunIds),
    [run.events, run.childRunIds],
  );

  const taskRunMap = useMemo(() => {
    const map = new Map<string, CrucibleRun>();
    for (const r of taskRuns) map.set(r.id, r);
    return map;
  }, [taskRuns]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Snap to bottom whenever the run updates and the user hasn't scrolled away.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    // Use rAF so we measure after layout finishes (especially for streamed text).
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [autoScroll, run.updatedAt, run.events.length, messages.length]);

  // Observe the inner content size so growing text still pins to bottom.
  useEffect(() => {
    if (!autoScroll) return;
    const inner = innerRef.current;
    const outer = scrollRef.current;
    if (!inner || !outer || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!autoScroll) return;
      outer.scrollTop = outer.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [autoScroll]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setAutoScroll(distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  }, []);

  const hasMessages = messages.length > 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto overscroll-contain px-4 py-3"
      >
        <div ref={innerRef} className="space-y-3">
          {hasMessages ? (
            messages.map((msg) => (
              <ChatMessageRow
                key={msg.id}
                message={msg}
                taskRunMap={taskRunMap}
                {...(onSelectRun ? { onSelectRun } : {})}
              />
            ))
          ) : (
            <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
              {run.status === "starting"
                ? "Agent is starting…"
                : run.status === "error"
                  ? "Run errored before producing chat output."
                  : "No chat messages yet."}
            </div>
          )}
          {run.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <div className="font-semibold">Run error</div>
              <p className="mt-1 whitespace-pre-wrap">{run.error}</p>
            </div>
          )}
          {/* Spacer so the last bubble isn't flush against the viewport edge. */}
          <div className="h-2" />
        </div>
      </div>

      {!autoScroll && (
        <Button
          size="xs"
          variant="secondary"
          onClick={jumpToBottom}
          className="absolute right-4 bottom-4 shadow-md"
        >
          <ArrowDownIcon className="h-3 w-3" />
          Jump to latest
        </Button>
      )}
    </div>
  );
}
