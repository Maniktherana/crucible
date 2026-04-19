import {
  ArrowDownIcon,
  CheckIcon,
  FilePlusIcon,
  GitBranchIcon,
  LightbulbIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import { RunStatusBadge } from "./RunStatusBadge";
import type { CrucibleRun, CrucibleRunEvent } from "./types";

const AUTO_SCROLL_THRESHOLD_PX = 100;

interface SessionChatViewProps {
  run: CrucibleRun;
  /** All task runs known for the parent manager run, used to resolve spawn child status. */
  taskRuns: CrucibleRun[];
  /** Invoked when the user clicks into a spawned child run. */
  onSelectRun?: (runId: string) => void;
}

// --- Message model ----------------------------------------------------------

type ToolStatus = "pending" | "running" | "completed" | "error";

interface BaseMsg {
  id: string;
  timestamp: string;
}

type ChatMessage =
  | (BaseMsg & { kind: "text"; content: string })
  | (BaseMsg & { kind: "reasoning"; content: string })
  | (BaseMsg & {
      kind: "tool-bash";
      status: ToolStatus;
      command: string;
      title: string;
      output: string;
      exitCode: number | null;
    })
  | (BaseMsg & {
      kind: "tool-edit";
      status: ToolStatus;
      filePath: string;
      oldString: string;
      newString: string;
    })
  | (BaseMsg & {
      kind: "tool-write";
      status: ToolStatus;
      filePath: string;
      content: string;
    })
  | (BaseMsg & {
      kind: "tool-search";
      status: ToolStatus;
      tool: string;
      target: string;
      output: string;
    })
  | (BaseMsg & {
      kind: "tool-generic";
      status: ToolStatus;
      tool: string;
      title: string;
      input: string;
      output: string;
    })
  | (BaseMsg & {
      kind: "spawn";
      status: ToolStatus;
      prompt: string;
      childRunId?: string;
    })
  | (BaseMsg & { kind: "step-start"; stepNumber: number })
  | (BaseMsg & { kind: "screenshot"; path: string; label: string });

// --- Payload helpers --------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringifySafe(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Extract the inner part from opencode's `message.part.updated` payload. */
function partOf(event: CrucibleRunEvent): Record<string, unknown> | null {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const props = asRecord(payload.properties);
  if (!props) return null;
  return asRecord(props.part);
}

function partId(event: CrucibleRunEvent, part: Record<string, unknown> | null): string {
  if (part) {
    const id =
      (part.id as string | undefined) ??
      (part.partId as string | undefined) ??
      (part.part_id as string | undefined);
    if (id) return id;
  }
  return event.id;
}

function toToolStatus(raw: unknown): ToolStatus {
  if (raw === "pending" || raw === "running" || raw === "completed" || raw === "error") {
    return raw;
  }
  return "pending";
}

/** Last two segments of a path, e.g. "apps/web/src/x.ts" → "src/x.ts". */
function shortenPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 2) return filePath;
  return parts.slice(-2).join("/");
}

/** Output blocks can arrive as string, { value }, { text }, array of content, etc. */
function toOutputString(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  const rec = asRecord(raw);
  if (rec) {
    if (typeof rec.value === "string") return rec.value;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.stdout === "string") return rec.stdout;
    if (typeof rec.output === "string") return rec.output;
    if (Array.isArray(rec.content)) {
      return rec.content
        .map((c) => (typeof c === "string" ? c : ((asRecord(c)?.text as string | undefined) ?? "")))
        .join("\n");
    }
  }
  if (Array.isArray(raw)) {
    return raw
      .map((c) => (typeof c === "string" ? c : ((asRecord(c)?.text as string | undefined) ?? "")))
      .join("\n");
  }
  return stringifySafe(raw);
}

function isSpawnCommand(command: string): boolean {
  return command.includes("spawn-subtask");
}

/** Pull the subtask prompt out of a spawn-subtask bash command. */
function extractSpawnPrompt(command: string): string {
  const flag = command.match(/--prompt(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/);
  if (flag) return (flag[1] ?? flag[2] ?? flag[3] ?? "").trim();
  const quoted = [...command.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)];
  if (quoted.length > 0) {
    const last = quoted[quoted.length - 1]!;
    return (last[1] ?? last[2] ?? "").trim();
  }
  const idx = command.indexOf("spawn-subtask");
  if (idx >= 0) return command.slice(idx + "spawn-subtask".length).trim();
  return command;
}

const SCREENSHOT_MARKER_RE = /^SCREENSHOT_SAVED:\s+(\S+)$/gm;
const AGENT_BROWSER_SCREENSHOT_RE =
  /agent-browser\s+screenshot\s+(?:--\S+\s+)*([^\s"'`]+\.(?:png|jpe?g|webp))/i;

function extractScreenshotPathsFromText(text: string): string[] {
  if (!text) return [];
  const re = new RegExp(SCREENSHOT_MARKER_RE.source, "gm");
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) paths.push(m[1]);
  }
  return paths;
}

function extractScreenshotPathFromBashCommand(command: string): string | null {
  if (!command) return null;
  const match = AGENT_BROWSER_SCREENSHOT_RE.exec(command);
  return match?.[1] ?? null;
}

function labelFromPath(path: string): string {
  if (/-before\.(png|jpe?g|webp)$/i.test(path)) return "before";
  if (/-after\.(png|jpe?g|webp)$/i.test(path)) return "after";
  return "";
}

// --- Parser -----------------------------------------------------------------

/**
 * Parse raw run events into an ordered, deduplicated list of chat messages.
 *
 * opencode emits `message.part.updated` events whose nested `part` carries
 * the real payload. Current shape:
 *
 *   event.payload.properties.part = {
 *     type: "text" | "reasoning" | "tool" | "step-start" | "step-finish",
 *     id:   "prt_...",
 *     // when type === "tool":
 *     tool: "bash" | "edit" | "write" | "read" | "glob" | "grep" | ...,
 *     state: {
 *       status: "pending" | "running" | "completed" | "error",
 *       input: { command, filePath, oldString, newString, ... },
 *       output: "..." | { ... },
 *       metadata: { exit, description, ... },
 *       title: "...",
 *     }
 *   }
 *
 * Each update carries the full part-so-far for a stable `part.id`, so we
 * upsert by id — the latest status replaces earlier ones while preserving
 * position in the conversation.
 */
function parseMessages(events: CrucibleRunEvent[], childRunIds: string[]): ChatMessage[] {
  const entries: { key: string; msg: ChatMessage }[] = [];
  const keyToIndex = new Map<string, number>();
  const spawnKeyToChildId = new Map<string, string>();
  let spawnCursor = 0;
  let stepCounter = 0;

  const upsert = (key: string, msg: ChatMessage) => {
    const existing = keyToIndex.get(key);
    if (existing !== undefined) {
      entries[existing] = { key, msg };
    } else {
      keyToIndex.set(key, entries.length);
      entries.push({ key, msg });
    }
  };

  // Prefix-extend fallback for text/reasoning parts that lack a stable id.
  const tryPrefixExtend = (text: string, at: string, kind: "text" | "reasoning"): boolean => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const prev = entries[i]!.msg;
      if (prev.kind === "text" || prev.kind === "reasoning") {
        if (prev.kind === kind && text.startsWith(prev.content) && text !== prev.content) {
          entries[i]!.msg = { ...prev, content: text, timestamp: at };
          return true;
        }
        break;
      }
    }
    return false;
  };

  for (const event of events) {
    if (event.type !== "message.part.updated") continue;
    const part = partOf(event);
    if (!part) continue;
    const partType = part.type;
    const key = partId(event, part);

    // ---- Text / Reasoning ----
    if (partType === "text" || partType === "reasoning") {
      const content = typeof part.text === "string" ? part.text : "";
      if (!content.trim()) continue;

      const hasStableKey = key !== event.id;
      if (!hasStableKey && tryPrefixExtend(content, event.at, partType)) continue;

      upsert(key, { id: key, kind: partType, content, timestamp: event.at });

      // Extract screenshot markers from text parts as separate screenshot messages.
      if (partType === "text") {
        const screenshotPaths = extractScreenshotPathsFromText(content);
        for (const scPath of screenshotPaths) {
          const sKey = `${key}:screenshot:${scPath}`;
          upsert(sKey, {
            id: sKey,
            kind: "screenshot",
            path: scPath,
            label: labelFromPath(scPath),
            timestamp: event.at,
          });
        }
      }

      continue;
    }

    // ---- Step markers ----
    if (partType === "step-start") {
      if (!keyToIndex.has(key)) stepCounter += 1;
      const existing = keyToIndex.get(key);
      const stepNumber =
        existing !== undefined && entries[existing]!.msg.kind === "step-start"
          ? (entries[existing]!.msg as Extract<ChatMessage, { kind: "step-start" }>).stepNumber
          : stepCounter;
      upsert(key, { id: key, kind: "step-start", stepNumber, timestamp: event.at });
      continue;
    }
    if (partType === "step-finish") continue;

    // ---- Tool calls (current opencode shape: part.type === "tool") ----
    if (partType === "tool") {
      const toolName = typeof part.tool === "string" ? part.tool : "tool";
      const state = asRecord(part.state) ?? {};
      const status = toToolStatus(state.status);
      const input = asRecord(state.input) ?? {};
      const metadata = asRecord(state.metadata) ?? {};
      const title =
        (typeof state.title === "string" && state.title) ||
        (typeof metadata.description === "string" && metadata.description) ||
        (typeof input.description === "string" && input.description) ||
        "";

      if (toolName === "bash") {
        const command =
          (typeof input.command === "string" && input.command) ||
          (typeof metadata.command === "string" && metadata.command) ||
          "";
        const output =
          toOutputString(state.output) ||
          toOutputString(metadata.output) ||
          toOutputString(metadata.stdout);
        const exitRaw = metadata.exit ?? metadata.exitCode ?? metadata.exit_code;
        const exitCode = typeof exitRaw === "number" ? exitRaw : null;

        if (isSpawnCommand(command)) {
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
            status,
            prompt: extractSpawnPrompt(command),
            ...(childRunId ? { childRunId } : {}),
            timestamp: event.at,
          });
          continue;
        }

        upsert(key, {
          id: key,
          kind: "tool-bash",
          status,
          command,
          title,
          output,
          exitCode,
          timestamp: event.at,
        });
        continue;
      }

      if (toolName === "edit") {
        upsert(key, {
          id: key,
          kind: "tool-edit",
          status,
          filePath: typeof input.filePath === "string" ? input.filePath : "",
          oldString: typeof input.oldString === "string" ? input.oldString : "",
          newString: typeof input.newString === "string" ? input.newString : "",
          timestamp: event.at,
        });
        continue;
      }

      if (toolName === "write") {
        upsert(key, {
          id: key,
          kind: "tool-write",
          status,
          filePath: typeof input.filePath === "string" ? input.filePath : "",
          content: typeof input.content === "string" ? input.content : "",
          timestamp: event.at,
        });
        continue;
      }

      if (toolName === "read" || toolName === "glob" || toolName === "grep") {
        const target =
          (typeof input.filePath === "string" && input.filePath) ||
          (typeof input.pattern === "string" && input.pattern) ||
          (typeof input.path === "string" && input.path) ||
          "";
        upsert(key, {
          id: key,
          kind: "tool-search",
          status,
          tool: toolName,
          target,
          output: toOutputString(state.output) || toOutputString(metadata.output),
          timestamp: event.at,
        });
        continue;
      }

      upsert(key, {
        id: key,
        kind: "tool-generic",
        status,
        tool: toolName,
        title,
        input: stringifySafe(input),
        output: toOutputString(state.output) || toOutputString(metadata.output),
        timestamp: event.at,
      });
      continue;
    }

    // ---- Legacy AI-SDK shape (tool-invocation / tool-result) ----
    if (partType === "tool-invocation" || partType === "tool-call") {
      const toolName =
        (part.toolName as string | undefined) ??
        (part.tool as string | undefined) ??
        (part.name as string | undefined) ??
        "tool";
      const inputRec = asRecord(part.input) ?? {};
      const command = typeof inputRec.command === "string" ? inputRec.command : "";
      if (toolName === "bash" && isSpawnCommand(command)) {
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
          status: "running",
          prompt: extractSpawnPrompt(command),
          ...(childRunId ? { childRunId } : {}),
          timestamp: event.at,
        });
        continue;
      }
      upsert(key, {
        id: key,
        kind: "tool-generic",
        status: "running",
        tool: toolName,
        title: "",
        input: command || stringifySafe(inputRec),
        output: "",
        timestamp: event.at,
      });
      continue;
    }

    if (partType === "tool-result") {
      upsert(key, {
        id: key,
        kind: "tool-generic",
        status: "completed",
        tool: "tool",
        title: "",
        input: "",
        output: toOutputString(part.output ?? part.result ?? part.stdout),
        timestamp: event.at,
      });
      continue;
    }
  }

  return entries.map((e) => e.msg);
}

// --- Shared UI --------------------------------------------------------------

function MarkdownBubble({ text, dim }: { text: string; dim?: boolean }) {
  return (
    <div
      className={cn(
        "max-w-none text-sm leading-relaxed",
        "[&_a]:text-primary [&_a]:underline",
        "[&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[.85em]",
        "[&_li]:my-0.5",
        "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_p]:my-1",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_pre]:text-xs",
        "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
        dim && "text-muted-foreground",
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function ToolStatusIcon({ status }: { status: ToolStatus }) {
  if (status === "running" || status === "pending") return <Spinner className="h-3 w-3" />;
  if (status === "completed") return <CheckIcon className="h-3 w-3 text-green-500" />;
  if (status === "error") return <XIcon className="h-3 w-3 text-red-500" />;
  return null;
}

// --- Message rows -----------------------------------------------------------

function TextMessage({ content }: { content: string }) {
  return (
    <div className="flex gap-2">
      <Badge size="sm" className="mt-0.5 shrink-0 bg-primary/15 text-primary text-[10px]">
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
    <div className="rounded-lg border border-dashed border-muted-foreground/30 bg-muted/10 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <LightbulbIcon className="h-3 w-3" />
        <span className="font-medium uppercase tracking-wider">Thinking</span>
      </div>
      <MarkdownBubble text={content} dim />
    </div>
  );
}

function StepDivider({ stepNumber }: { stepNumber: number }) {
  return (
    <div
      className="flex items-center gap-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/55"
      aria-hidden
    >
      <span className="h-px flex-1 bg-border/60" />
      <span>Step {stepNumber}</span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function ScreenshotInline({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  const url = `/api/crucible/files?path=${encodeURIComponent(path)}`;
  if (failed) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-muted-foreground/40" />
        Waiting for screenshot…
      </div>
    );
  }
  return (
    <img
      src={url}
      alt="agent-browser screenshot"
      className="max-h-72 w-full bg-background object-contain"
      onError={() => setFailed(true)}
    />
  );
}

function ScreenshotMessage({ path, label }: { path: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const url = `/api/crucible/files?path=${encodeURIComponent(path)}`;
  const labelBadge = label === "before" ? "Before" : label === "after" ? "After" : "Screenshot";

  return (
    <div className="flex gap-2">
      <Badge variant="outline" size="sm" className="mt-0.5 shrink-0 text-[10px]">
        📸 {labelBadge}
      </Badge>
      <div className="min-w-0 flex-1 overflow-hidden rounded-lg border bg-muted/20">
        {failed ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-muted-foreground/40" />
            Waiting for screenshot…
            <span className="ml-auto truncate font-mono text-[10px] opacity-60">{path}</span>
          </div>
        ) : (
          <>
            <img
              src={url}
              alt={`agent-browser ${labelBadge.toLowerCase()} screenshot`}
              className="max-h-72 w-full bg-background object-contain"
              onError={() => setFailed(true)}
            />
            <div className="flex items-center gap-2 border-t bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">
              <span className="truncate font-mono">{path}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BashMessage({
  command,
  status,
  title,
  output,
  exitCode,
}: {
  command: string;
  status: ToolStatus;
  title: string;
  output: string;
  exitCode: number | null;
}) {
  const lineCount = output ? output.split("\n").length : 0;
  return (
    <div className="overflow-hidden rounded-lg border border-blue-500/30 border-l-[4px] bg-card/30">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <TerminalIcon className="h-3.5 w-3.5 text-blue-400" />
        <span className="font-mono font-semibold text-blue-300">bash</span>
        {title && (
          <span className="min-w-0 truncate text-muted-foreground" title={title}>
            {title}
          </span>
        )}
        <span className="ml-auto">
          <ToolStatusIcon status={status} />
        </span>
      </div>
      <pre className="overflow-x-auto bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        <span className="text-muted-foreground">$ </span>
        {command || "(no command)"}
      </pre>
      {(() => {
        const screenshotPath =
          extractScreenshotPathFromBashCommand(command) ??
          extractScreenshotPathsFromText(output)[0] ??
          null;
        if (!screenshotPath) return null;
        return (
          <div className="border-t bg-background/40">
            <ScreenshotInline path={screenshotPath} />
          </div>
        );
      })()}
      {(output.trim() || exitCode != null) && (
        <div className="border-t border-border/60">
          <div className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>output</span>
            {exitCode != null && (
              <Badge
                size="sm"
                className={cn(
                  "font-mono text-[10px]",
                  exitCode === 0 ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400",
                )}
              >
                exit {exitCode}
              </Badge>
            )}
            {lineCount > 0 && <span className="ml-auto font-mono">{lineCount} lines</span>}
          </div>
          {output.trim() ? (
            <pre className="max-h-[60vh] overflow-auto bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {output}
            </pre>
          ) : (
            <p className="px-3 pb-2 text-xs text-muted-foreground italic">(no output)</p>
          )}
        </div>
      )}
    </div>
  );
}

function EditMessage({
  filePath,
  status,
  oldString,
  newString,
}: {
  filePath: string;
  status: ToolStatus;
  oldString: string;
  newString: string;
}) {
  const oldLines = oldString ? oldString.split("\n") : [];
  const newLines = newString ? newString.split("\n") : [];
  return (
    <div className="overflow-hidden rounded-lg border border-amber-500/30 border-l-[4px] bg-card/30">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <PencilIcon className="h-3.5 w-3.5 text-amber-400" />
        <span className="font-mono font-semibold text-amber-300">edit</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={filePath}>
          {shortenPath(filePath)}
        </span>
        <span className="ml-auto">
          <ToolStatusIcon status={status} />
        </span>
      </div>
      {(oldLines.length > 0 || newLines.length > 0) && (
        // Render each side as a single <pre> instead of per-line <div>s so we
        // don't need per-line keys. Colors still come through via bg classes
        // on the block itself.
        <div className="max-h-[60vh] overflow-auto bg-background/60 font-mono text-xs leading-relaxed">
          {oldLines.length > 0 && (
            <pre className="bg-red-500/10 px-3 py-1 text-red-300/90 whitespace-pre-wrap break-all">
              {oldLines.map((l) => `− ${l}`).join("\n")}
            </pre>
          )}
          {newLines.length > 0 && (
            <pre className="bg-green-500/10 px-3 py-1 text-green-300/90 whitespace-pre-wrap break-all">
              {newLines.map((l) => `+ ${l}`).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function WriteMessage({
  filePath,
  status,
  content,
}: {
  filePath: string;
  status: ToolStatus;
  content: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-emerald-500/30 border-l-[4px] bg-card/30">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <FilePlusIcon className="h-3.5 w-3.5 text-emerald-400" />
        <span className="font-mono font-semibold text-emerald-300">write</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={filePath}>
          {shortenPath(filePath)}
        </span>
        <span className="ml-auto">
          <ToolStatusIcon status={status} />
        </span>
      </div>
      {content && (
        <pre className="max-h-[60vh] overflow-auto bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  );
}

function SearchMessage({
  tool,
  target,
  output,
  status,
}: {
  tool: string;
  target: string;
  output: string;
  status: ToolStatus;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border border-l-[4px] bg-card/30">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <SearchIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono font-semibold">{tool}</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={target}>
          {target || "—"}
        </span>
        <span className="ml-auto">
          <ToolStatusIcon status={status} />
        </span>
      </div>
      {output.trim() && (
        <pre className="max-h-[60vh] overflow-auto border-t border-border/60 bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {output}
        </pre>
      )}
    </div>
  );
}

function GenericToolMessage({
  tool,
  title,
  input,
  output,
  status,
}: {
  tool: string;
  title: string;
  input: string;
  output: string;
  status: ToolStatus;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border border-l-[4px] bg-card/30">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <TerminalIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono font-semibold">{tool}</span>
        {title && (
          <span className="min-w-0 truncate text-muted-foreground" title={title}>
            {title}
          </span>
        )}
        <span className="ml-auto">
          <ToolStatusIcon status={status} />
        </span>
      </div>
      {input && (
        <pre className="max-h-64 overflow-auto border-t border-border/60 bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {input}
        </pre>
      )}
      {output.trim() && (
        <div className="border-t border-border/60">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            output
          </div>
          <pre className="max-h-[60vh] overflow-auto bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {output}
          </pre>
        </div>
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
    <div className="overflow-hidden rounded-lg border border-purple-500/50 border-l-[4px] bg-purple-500/5">
      <div className="flex items-center gap-1.5 border-b border-purple-500/30 bg-purple-500/10 px-3 py-1.5 font-mono text-[11px] text-purple-300">
        <GitBranchIcon className="h-3 w-3" />
        <span className="font-semibold uppercase tracking-wider">Spawned Task</span>
        {childRun && <RunStatusBadge status={childRun.status} showLabel />}
      </div>
      <div className="space-y-2 px-3 py-2">
        <p className="text-sm leading-snug whitespace-pre-wrap">{previewPrompt || "(no prompt)"}</p>
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

// --- Dispatcher -------------------------------------------------------------

function ChatMessageRow({
  message,
  taskRunMap,
  onSelectRun,
  inlineBashScreenshotPaths,
}: {
  message: ChatMessage;
  taskRunMap: Map<string, CrucibleRun>;
  onSelectRun?: (id: string) => void;
  inlineBashScreenshotPaths: Set<string>;
}) {
  switch (message.kind) {
    case "text":
      return <TextMessage content={message.content} />;
    case "reasoning":
      return <ReasoningMessage content={message.content} />;
    case "step-start":
      return <StepDivider stepNumber={message.stepNumber} />;
    case "tool-bash":
      return (
        <BashMessage
          command={message.command}
          status={message.status}
          title={message.title}
          output={message.output}
          exitCode={message.exitCode}
        />
      );
    case "tool-edit":
      return (
        <EditMessage
          filePath={message.filePath}
          status={message.status}
          oldString={message.oldString}
          newString={message.newString}
        />
      );
    case "tool-write":
      return (
        <WriteMessage
          filePath={message.filePath}
          status={message.status}
          content={message.content}
        />
      );
    case "tool-search":
      return (
        <SearchMessage
          tool={message.tool}
          target={message.target}
          output={message.output}
          status={message.status}
        />
      );
    case "tool-generic":
      return (
        <GenericToolMessage
          tool={message.tool}
          title={message.title}
          input={message.input}
          output={message.output}
          status={message.status}
        />
      );
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
    case "screenshot":
      if (inlineBashScreenshotPaths.has(message.path)) return null;
      return <ScreenshotMessage path={message.path} label={message.label} />;
  }
}

// --- Container with auto-scroll --------------------------------------------

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

  const inlineBashScreenshotPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const m of messages) {
      if (m.kind !== "tool-bash") continue;
      const cmdPath = extractScreenshotPathFromBashCommand(m.command);
      if (cmdPath) paths.add(cmdPath);
      for (const p of extractScreenshotPathsFromText(m.output)) paths.add(p);
    }
    return paths;
  }, [messages]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Pin to bottom whenever the run updates and the user hasn't scrolled away.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [autoScroll, run.updatedAt, run.events.length, messages.length]);

  // ResizeObserver: keep pinned as streamed text grows the content height.
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
        <div ref={innerRef} className="space-y-2.5">
          {hasMessages ? (
            messages.map((msg) => (
              <ChatMessageRow
                key={msg.id}
                message={msg}
                taskRunMap={taskRunMap}
                inlineBashScreenshotPaths={inlineBashScreenshotPaths}
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
