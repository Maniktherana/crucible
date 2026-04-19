import { useCallback, useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetPanel,
} from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import type { CrucibleRun, CrucibleRunEvent } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-400";
    case "running":
      return "text-blue-400";
    case "error":
      return "text-red-400";
    case "starting":
      return "text-yellow-400";
    default:
      return "text-muted-foreground";
  }
}

// ---------------------------------------------------------------------------
// Nested payload extractors for raw output rendering
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function partOf(event: CrucibleRunEvent): Record<string, unknown> | null {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const props = asRecord(payload.properties);
  if (!props) return null;
  return asRecord(props.part);
}

function extractToolInfo(event: CrucibleRunEvent): {
  toolName: string;
  status: string;
  input: string;
  output: string;
} | null {
  const part = partOf(event);
  if (!part) return null;
  if (part.type !== "tool" && part.type !== "tool-invocation" && part.type !== "tool-result") {
    return null;
  }
  const toolName = String(part.tool ?? part.toolName ?? part.name ?? "tool");
  const state = asRecord(part.state);
  const stateStatus = String(state?.status ?? "");
  const stateInput = asRecord(state?.input) ?? asRecord(part.input);
  const stateOutput = state?.output ?? (asRecord(state?.metadata) ?? {}).output ?? "";

  let inputStr = "";
  if (stateInput) {
    // For bash: show the command. For other tools: show JSON.
    if (typeof stateInput.command === "string") {
      inputStr = stateInput.command;
    } else {
      inputStr = JSON.stringify(stateInput, null, 2);
    }
  }

  return {
    toolName,
    status: stateStatus,
    input: inputStr,
    output: typeof stateOutput === "string" ? stateOutput : JSON.stringify(stateOutput, null, 2),
  };
}

function extractTextContent(event: CrucibleRunEvent): string | null {
  const part = partOf(event);
  if (!part) return null;
  if (part.type === "text" || part.type === "reasoning") {
    return typeof part.text === "string" ? part.text : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// RunOutputLine — a single line in the raw output sidebar
// ---------------------------------------------------------------------------

function RunOutputLine({ event }: { event: CrucibleRunEvent }) {
  const tool = extractToolInfo(event);
  const text = extractTextContent(event);
  const time = new Date(event.at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Tool call with input/output
  if (tool) {
    return (
      <div className="border-b border-border/40 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground">{time}</span>
          <Badge variant="secondary" size="sm" className="font-mono text-[10px]">
            {tool.toolName}
          </Badge>
          {tool.status && (
            <span
              className={cn(
                "text-[10px]",
                tool.status === "completed" && "text-green-400",
                tool.status === "running" && "text-blue-400",
                tool.status === "error" && "text-red-400",
              )}
            >
              {tool.status}
            </span>
          )}
        </div>
        {tool.input && (
          <pre className="mt-1 overflow-x-auto rounded bg-background p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            <span className="text-blue-400">{">"} </span>
            {tool.input}
          </pre>
        )}
        {tool.output && (
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-background p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {tool.output}
          </pre>
        )}
      </div>
    );
  }

  // AI text / reasoning
  if (text) {
    return (
      <div className="border-b border-border/40 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground">{time}</span>
          <span className="text-[10px] text-purple-400">assistant</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
      </div>
    );
  }

  // System / status / other events — compact single line
  return (
    <div className="flex items-center gap-2 border-b border-border/40 py-1.5 text-xs text-muted-foreground">
      <span className="font-mono">{time}</span>
      <span className="font-mono text-[10px]">[{event.type}]</span>
      <span className="truncate">{event.summary}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunOutputSidebar — full raw output for a single run
// ---------------------------------------------------------------------------

function RunOutputSidebar({
  run,
  open,
  onOpenChange,
}: {
  run: CrucibleRun | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="max-w-2xl">
        {run && (
          <>
            <SheetHeader>
              <SheetTitle className="text-base">
                {run.type === "manager" ? "Manager" : "Task"}: {run.prompt.slice(0, 80)}
                {run.prompt.length > 80 ? "..." : ""}
              </SheetTitle>
              <SheetDescription>
                <span className={statusColor(run.status)}>{run.status}</span>
                {" | "}
                {run.id.slice(0, 8)}
                {run.issueNumber != null && ` | Issue #${run.issueNumber}`}
                {run.durationMs != null && ` | ${formatDuration(run.durationMs)}`}
                {run.prUrl && (
                  <>
                    {" | "}
                    <a
                      href={run.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:underline"
                    >
                      PR
                    </a>
                  </>
                )}
              </SheetDescription>
            </SheetHeader>
            <SheetPanel>
              <div className="space-y-0">
                {run.events.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No events recorded.
                  </p>
                ) : (
                  run.events.map((event) => <RunOutputLine key={event.id} event={event} />)
                )}
              </div>
              {run.error && (
                <div className="mt-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
                  <strong>Error:</strong> {run.error}
                </div>
              )}
            </SheetPanel>
          </>
        )}
      </SheetPopup>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// ManageRunsDialog — the table + sidebar combo
// ---------------------------------------------------------------------------

export function ManageRunsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [allRuns, setAllRuns] = useState<CrucibleRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRun, setSelectedRun] = useState<CrucibleRun | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const fetchAllRuns = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/crucible/runs");
      if (!res.ok) return;
      const data = (await res.json()) as CrucibleRun[];
      setAllRuns(Array.isArray(data) ? data : []);
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void fetchAllRuns();
    }
  }, [open, fetchAllRuns]);

  const handleRowClick = (run: CrucibleRun) => {
    setSelectedRun(run);
    setSidebarOpen(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-4xl" showCloseButton>
          <DialogHeader>
            <DialogTitle>Manage Runs</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto px-6 pb-6">
            {loading && allRuns.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>
            ) : allRuns.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No runs found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="pb-2 pr-3 font-medium">Type</th>
                    <th className="pb-2 pr-3 font-medium">Issue</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 pr-3 font-medium">Repo</th>
                    <th className="pb-2 pr-3 font-medium">Duration</th>
                    <th className="pb-2 pr-3 font-medium">Started</th>
                    <th className="pb-2 font-medium">PR</th>
                  </tr>
                </thead>
                <tbody>
                  {allRuns.map((run) => (
                    <tr
                      key={run.id}
                      onClick={() => handleRowClick(run)}
                      className="cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/50"
                    >
                      <td className="py-2 pr-3">
                        <Badge
                          variant="secondary"
                          size="sm"
                          className={cn(
                            "text-[10px]",
                            run.type === "manager" && "bg-purple-500/20 text-purple-300",
                            run.type === "task" && "bg-blue-500/20 text-blue-300",
                          )}
                        >
                          {run.type}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">
                        {run.issueNumber != null ? `#${run.issueNumber}` : "-"}
                      </td>
                      <td className={cn("py-2 pr-3 text-xs font-medium", statusColor(run.status))}>
                        {run.status}
                        {run.needsInput && (
                          <span className="ml-1 text-yellow-400" title="Waiting for input">
                            (blocked)
                          </span>
                        )}
                      </td>
                      <td className="max-w-[140px] truncate py-2 pr-3 font-mono text-xs text-muted-foreground">
                        {run.repo || "-"}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                        {run.durationMs != null ? formatDuration(run.durationMs) : "-"}
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {run.createdAt ? formatTime(run.createdAt) : "-"}
                      </td>
                      <td className="py-2 text-xs">
                        {run.prUrl ? (
                          <a
                            href={run.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            PR
                          </a>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {allRuns.length} run{allRuns.length === 1 ? "" : "s"} total
              </span>
              <Button variant="ghost" size="sm" onClick={() => void fetchAllRuns()}>
                Refresh
              </Button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>

      <RunOutputSidebar run={selectedRun} open={sidebarOpen} onOpenChange={setSidebarOpen} />
    </>
  );
}
