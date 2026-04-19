import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { AgentBrowserPreview, detectAgentBrowserScreenshot } from "./AgentBrowserPreview";
import type { CrucibleRun, CrucibleRunEvent } from "./types";

export type EventFilterMode = "all" | "tools" | "text" | "errors";

interface EventStreamViewProps {
  run: CrucibleRun;
  filterMode: EventFilterMode;
  onFilterChange: (mode: EventFilterMode) => void;
}

type EventCategory = "tool" | "text" | "error" | "system";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * opencode `message.part.updated` events nest the real part under
 * `payload.properties.part`. Everything tool/text related lives there.
 */
function partOf(event: CrucibleRunEvent): Record<string, unknown> | null {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const props = asRecord(payload.properties);
  if (!props) return null;
  return asRecord(props.part);
}

export function categorizeEvent(event: CrucibleRunEvent): EventCategory {
  if (event.type === "session.error" || event.type.endsWith(".error")) return "error";

  if (event.type === "message.part.updated") {
    const part = partOf(event);
    const partType = part?.type;
    if (partType === "tool-invocation" || partType === "tool-call" || partType === "tool-result") {
      return "tool";
    }
    if (partType === "text" || partType === "reasoning") {
      return "text";
    }
  }
  return "system";
}

function formatRelativeTime(isoString: string): string {
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isSpawnSubtask(event: CrucibleRunEvent): boolean {
  const summary = event.summary?.toLowerCase?.() ?? "";
  if (summary.includes("spawn-subtask") || summary.includes("spawn subtask")) return true;
  const part = partOf(event);
  if (!part) return false;
  const toolName = (part.toolName ?? part.tool ?? part.name) as unknown;
  if (typeof toolName === "string" && toolName.toLowerCase().includes("spawn-subtask")) {
    return true;
  }
  const input = asRecord(part.input);
  const command = input?.command;
  return typeof command === "string" && command.includes("spawn-subtask");
}

function extractBashCommand(event: CrucibleRunEvent): string | null {
  const part = partOf(event);
  if (!part) return null;
  const toolName = (part.toolName ?? part.tool ?? part.name) as unknown;
  const isBash =
    typeof toolName === "string" &&
    (toolName === "bash" || toolName === "shell" || toolName.endsWith("bash"));
  const input = asRecord(part.input);
  const command = input?.command;
  if (isBash && typeof command === "string") return command;
  // Fall-through: sometimes the summary is like "bash: <cmd>"
  if (event.summary?.startsWith?.("bash:")) {
    return event.summary.slice("bash:".length).trim();
  }
  return null;
}

function EventCard({ event }: { event: CrucibleRunEvent }) {
  const [expanded, setExpanded] = useState(false);
  const category = categorizeEvent(event);
  const bashCommand = category === "tool" ? extractBashCommand(event) : null;
  const showAgentBrowser = detectAgentBrowserScreenshot(event);
  const spawnSubtask = isSpawnSubtask(event);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card/40 p-3 text-sm",
        category === "error" && "border-red-500/40 bg-red-500/5",
        category === "tool" && "border-blue-500/25 bg-blue-500/5",
        spawnSubtask && "border-purple-500/40 bg-purple-500/5",
      )}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{formatRelativeTime(event.at)}</span>
        <Badge variant="secondary" size="sm" className="font-mono text-[10px]">
          {event.type}
        </Badge>
        {spawnSubtask && (
          <Badge size="sm" className="bg-purple-500/20 text-purple-300 text-[10px]">
            spawn-subtask
          </Badge>
        )}
        {category === "error" && (
          <Badge size="sm" variant="destructive" className="text-[10px]">
            error
          </Badge>
        )}
        {(event.inputTokens != null || event.outputTokens != null) && (
          <Badge variant="secondary" size="sm" className="font-mono text-[10px]">
            {event.inputTokens ?? 0}&rarr;{event.outputTokens ?? 0} tokens
          </Badge>
        )}
      </div>

      {/* Summary */}
      {event.summary && (
        <p className="mt-1.5 break-words whitespace-pre-wrap text-sm leading-snug">
          {event.summary}
        </p>
      )}

      {/* Bash code block */}
      {bashCommand && (
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          <span className="text-muted-foreground">$ </span>
          {bashCommand}
        </pre>
      )}

      {/* Agent-browser preview */}
      {showAgentBrowser && <AgentBrowserPreview event={event} />}

      {/* Expandable raw payload */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDownIcon className="h-3 w-3" />
        ) : (
          <ChevronRightIcon className="h-3 w-3" />
        )}
        {expanded ? "Hide" : "Show"} raw payload
      </button>
      {expanded && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

const FILTERS: { id: EventFilterMode; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tools", label: "Tools" },
  { id: "text", label: "Text" },
  { id: "errors", label: "Errors" },
];

/**
 * Raw / debug view of the run. Displays every event as a timeline card with
 * expandable payloads. Filtering by category (All/Tools/Text/Errors) is
 * preserved from the original L3 observability surface — the chat-first view
 * is rendered separately by `SessionChatView`.
 */
export function EventStreamView({ run, filterMode, onFilterChange }: EventStreamViewProps) {
  const filteredEvents = run.events.filter((event) => {
    if (filterMode === "all") return true;
    const category = categorizeEvent(event);
    if (filterMode === "tools") return category === "tool";
    if (filterMode === "text") return category === "text";
    if (filterMode === "errors") return category === "error";
    return true;
  });

  return (
    <div className="space-y-3">
      {/* Duration */}
      {run.durationMs != null && (
        <div className="text-xs text-muted-foreground">
          Duration:{" "}
          {run.durationMs < 60_000
            ? `${(run.durationMs / 1000).toFixed(1)}s`
            : `${(run.durationMs / 60_000).toFixed(1)}m`}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">Filter:</span>
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            size="xs"
            variant={filterMode === f.id ? "default" : "ghost"}
            className="text-xs"
            onClick={() => onFilterChange(f.id)}
          >
            {f.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {filteredEvents.length} / {run.events.length} events
        </span>
      </div>

      {run.error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
          <div className="font-semibold">Run error</div>
          <p className="mt-1 whitespace-pre-wrap">{run.error}</p>
        </div>
      )}

      {filteredEvents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          No events yet.
        </div>
      ) : (
        <div className="space-y-2">
          {filteredEvents.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
