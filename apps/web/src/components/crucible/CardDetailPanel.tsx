import { CheckIcon, CopyIcon, ExternalLinkIcon, ServerIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Sheet, SheetPopup } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";

import { EventStreamView, type EventFilterMode } from "./EventStreamView";
import { RunStatusBadge } from "./RunStatusBadge";
import { RunTreeView } from "./RunTreeView";
import { SessionChatView } from "./SessionChatView";
import type { CrucibleRun, CrucibleRunEvent, GhStatus, KanbanCard } from "./types";
import { getIssueColor, getRepoPath, useCrucibleStore } from "./useCrucibleStore";

const RUN_POLL_INTERVAL_MS = 2000;
const GH_STATUS_POLL_INTERVAL_MS = 10_000;

type StreamViewMode = "chat" | "raw";

interface CardDetailPanelProps {
  card: KanbanCard;
  onClose: () => void;
}

async function fetchRun(runId: string): Promise<CrucibleRun | null> {
  try {
    const res = await fetch(`/api/crucible/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) return null;
    return (await res.json()) as CrucibleRun;
  } catch {
    return null;
  }
}

async function fetchGhStatus(runId: string): Promise<GhStatus | null> {
  try {
    const res = await fetch(`/api/crucible/runs/${encodeURIComponent(runId)}/gh-status`);
    if (!res.ok) return null;
    const payload = (await res.json()) as unknown;
    if (!payload || typeof payload !== "object") return null;
    // Trust the shape declared by the server; narrow the `status` discriminator.
    const status = (payload as { status?: unknown }).status;
    if (
      status === "no_pr" ||
      status === "pending" ||
      status === "passing" ||
      status === "failing" ||
      status === "merged"
    ) {
      return payload as GhStatus;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Polls the server for the given run ids every 2s and upserts the results
 * into the global store. Cancels cleanly on unmount / id-set change.
 */
function useRunPolling(runIds: string[]) {
  const upsertRuns = useCrucibleStore((s) => s.upsertRuns);
  const idsKey = useMemo(() => runIds.toSorted().join(","), [runIds]);

  useEffect(() => {
    if (!idsKey) return;
    const ids = idsKey.split(",").filter(Boolean);
    if (ids.length === 0) return;

    let cancelled = false;

    const poll = async () => {
      const results = await Promise.all(ids.map(fetchRun));
      if (cancelled) return;
      const runs = results.filter((r): r is CrucibleRun => r !== null);
      if (runs.length > 0) upsertRuns(runs);
    };

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, RUN_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [idsKey, upsertRuns]);
}

/**
 * Polls the backend gh-status endpoint every 10s for runs that have a PR URL.
 * Runs without a PR are skipped. When the server responds `no_pr` the status
 * is cached so the UI can render nothing for that run.
 *
 * The endpoint is implemented by Stream 1. If the request fails (for example
 * because the backend hasn't shipped it yet) the hook silently no-ops - we
 * just don't show CI status.
 */
function useGhStatusPolling(runsWithPrUrl: CrucibleRun[]) {
  const setGhStatus = useCrucibleStore((s) => s.setGhStatus);
  const idsKey = useMemo(
    () =>
      runsWithPrUrl
        .map((r) => r.id)
        .toSorted()
        .join(","),
    [runsWithPrUrl],
  );

  useEffect(() => {
    if (!idsKey) return;
    const ids = idsKey.split(",").filter(Boolean);
    if (ids.length === 0) return;

    let cancelled = false;

    const poll = async () => {
      const results = await Promise.all(
        ids.map((id) => fetchGhStatus(id).then((s) => ({ id, s }))),
      );
      if (cancelled) return;
      for (const { id, s } of results) {
        if (s) setGhStatus(id, s);
      }
    };

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, GH_STATUS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [idsKey, setGhStatus]);
}

// ---------------------------------------------------------------------------
// Process detection (dev-server indicator)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function partOfEvent(event: CrucibleRunEvent): Record<string, unknown> | null {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const props = asRecord(payload.properties);
  if (!props) return null;
  return asRecord(props.part);
}

const DEV_SERVER_PATTERNS = /\b(dev|serve|start|preview|watch)\b/i;

/**
 * Scan the given runs for bash tool calls with `state.status === "running"`
 * whose command looks like a dev server. Returns the first match (the header
 * shows one indicator; a tooltip with the command surfaces details).
 */
function detectRunningDevServer(runs: CrucibleRun[]): string | null {
  for (const run of runs) {
    // Walk backwards - the latest running bash command wins when multiple exist.
    for (let i = run.events.length - 1; i >= 0; i--) {
      const event = run.events[i]!;
      if (event.type !== "message.part.updated") continue;
      const part = partOfEvent(event);
      if (!part) continue;
      if (part.type !== "tool" && part.type !== "tool-invocation" && part.type !== "tool-call") {
        continue;
      }
      const toolName = (part.tool ?? part.toolName ?? part.name) as unknown;
      if (typeof toolName !== "string") continue;
      const isBash = toolName === "bash" || toolName === "shell" || toolName.endsWith("bash");
      if (!isBash) continue;
      const state = asRecord(part.state);
      if (!state) continue;
      const status = typeof state.status === "string" ? state.status : "";
      if (status !== "running") continue;
      const input = asRecord(state.input) ?? asRecord(part.input);
      const command = input && typeof input.command === "string" ? input.command : "";
      if (!command) continue;
      if (DEV_SERVER_PATTERNS.test(command)) return command;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worktree chip
// ---------------------------------------------------------------------------

function shortWorktreeLabel(directory: string): string {
  if (!directory) return "";
  const segments = directory.split("/").filter(Boolean);
  // If the path contains `.crucible-worktrees/<id>`, surface that pair.
  const idx = segments.lastIndexOf(".crucible-worktrees");
  if (idx !== -1 && idx + 1 < segments.length) {
    return `.crucible-worktrees/${segments[idx + 1]}`;
  }
  // Fallback to the last two segments.
  return segments.slice(-2).join("/");
}

function WorktreeChip({ directory }: { directory: string }) {
  const [copied, setCopied] = useState(false);
  const label = shortWorktreeLabel(directory);
  if (!label) return null;

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(directory);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // best-effort
      }
    },
    [directory],
  );

  return (
    <div className="flex items-center gap-1">
      <span
        title={directory}
        className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
      >
        {label}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40"
        title="Copy full worktree path"
      >
        {copied ? (
          <>
            <CheckIcon className="h-2.5 w-2.5 text-green-400" />
            Copied
          </>
        ) : (
          <>
            <CopyIcon className="h-2.5 w-2.5" />
            Open worktree
          </>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GH CI indicator
// ---------------------------------------------------------------------------

function GhStatusBadge({ status }: { status: GhStatus }) {
  if (status.status === "no_pr") return null;
  const common = "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]";
  const label =
    status.prNumber !== undefined ? ` PR #${status.prNumber}` : status.prUrl ? " PR" : "";
  switch (status.status) {
    case "pending":
      return (
        <span className={cn(common, "border-yellow-500/40 bg-yellow-500/10 text-yellow-400")}>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
          CI pending{label}
        </span>
      );
    case "passing":
      return (
        <span className={cn(common, "border-green-500/40 bg-green-500/10 text-green-400")}>
          <CheckIcon className="h-2.5 w-2.5" />
          CI passing{label}
        </span>
      );
    case "failing":
      return (
        <span className={cn(common, "border-red-500/40 bg-red-500/10 text-red-400")}>
          <XIcon className="h-2.5 w-2.5" />
          CI failing{label}
        </span>
      );
    case "merged":
      return (
        <span className={cn(common, "border-purple-500/40 bg-purple-500/10 text-purple-400")}>
          <CheckIcon className="h-2.5 w-2.5" />
          Merged{label}
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function CardDetailPanel({ card, onClose }: CardDetailPanelProps) {
  const runs = useCrucibleStore((s) => s.runs);
  const repos = useCrucibleStore((s) => s.repos);
  const selectedRepo = useCrucibleStore((s) => s.selectedRepo);
  const ghStatusMap = useCrucibleStore((s) => s.ghStatus);

  // Prefer the latest version of the card's runs from the global store
  // (polling updates land there), falling back to what the card was seeded with.
  const managerRun = useMemo<CrucibleRun | undefined>(() => {
    if (!card.managerRun) return undefined;
    return runs.find((r) => r.id === card.managerRun?.id) ?? card.managerRun;
  }, [card.managerRun, runs]);

  const taskRuns = useMemo<CrucibleRun[]>(() => {
    const managerId = managerRun?.id;
    if (managerId) {
      const byParent = runs.filter((r) => r.parentRunId === managerId);
      if (byParent.length > 0) return byParent;
    }
    return card.taskRuns.map((cardRun) => runs.find((r) => r.id === cardRun.id) ?? cardRun);
  }, [card.taskRuns, managerRun?.id, runs]);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(managerRun?.id ?? null);
  const [viewMode, setViewMode] = useState<StreamViewMode>("chat");
  const [filterMode, setFilterMode] = useState<EventFilterMode>("all");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRunId && managerRun) {
      setSelectedRunId(managerRun.id);
    }
  }, [managerRun, selectedRunId]);

  const pollIds = useMemo(() => {
    const ids: string[] = [];
    if (managerRun) ids.push(managerRun.id);
    for (const t of taskRuns) ids.push(t.id);
    return ids;
  }, [managerRun, taskRuns]);
  useRunPolling(pollIds);

  // Only poll gh-status for runs that actually have a PR URL.
  const runsWithPrUrl = useMemo(() => {
    const all: CrucibleRun[] = [];
    if (managerRun?.prUrl) all.push(managerRun);
    for (const t of taskRuns) if (t.prUrl) all.push(t);
    return all;
  }, [managerRun, taskRuns]);
  useGhStatusPolling(runsWithPrUrl);

  const selectedRun = useMemo<CrucibleRun | null>(() => {
    if (!selectedRunId) return null;
    if (managerRun?.id === selectedRunId) return managerRun;
    return taskRuns.find((r) => r.id === selectedRunId) ?? null;
  }, [managerRun, selectedRunId, taskRuns]);

  const allRuns = useMemo<CrucibleRun[]>(() => {
    return managerRun ? [managerRun, ...taskRuns] : taskRuns;
  }, [managerRun, taskRuns]);

  const runningDevServer = useMemo(() => detectRunningDevServer(allRuns), [allRuns]);

  const issueAccent = getIssueColor(card.issue.number);

  const repoForStart = selectedRepo ?? card.managerRun?.repo ?? null;
  const handleStart = useCallback(async () => {
    if (!repoForStart) {
      setStartError("No repository selected.");
      return;
    }
    const directory = getRepoPath(repos, repoForStart);
    if (!directory) {
      setStartError("No local directory found for the selected repository.");
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/crucible/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: repoForStart,
          issueNumber: card.issue.number,
          issueTitle: card.issue.title,
          issueBody: card.issue.body,
          prompt: `Issue #${card.issue.number}: ${card.issue.title}\n\n${card.issue.body}`,
          directory,
          plannerMode: true,
          type: "manager",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Start failed (${res.status})`);
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setStarting(false);
    }
  }, [card.issue.body, card.issue.number, card.issue.title, repoForStart, repos]);

  const hasIssueBody = !!card.issue.body?.trim();

  const selectedRunGhStatus = selectedRun ? ghStatusMap[selectedRun.id] : undefined;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        className="w-[50vw] max-w-none p-0 sm:max-w-none"
      >
        <div
          className="flex h-full min-h-0 flex-col overflow-hidden border-l-4"
          style={{ borderLeftColor: issueAccent }}
        >
          {/* Header */}
          <div className="flex shrink-0 flex-col gap-1 border-b px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">#{card.issue.number}</span>
                <h2 className="truncate text-sm font-semibold">{card.issue.title}</h2>
              </div>
              <div className="flex items-center gap-1">
                {card.issue.html_url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    render={
                      <a href={card.issue.html_url} target="_blank" rel="noreferrer">
                        <ExternalLinkIcon className="h-4 w-4" />
                      </a>
                    }
                  />
                )}
                <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
                  <XIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Status row: run status, worktree chip, process indicator, PR/CI, langfuse */}
            {managerRun && (
              <div className="flex flex-wrap items-center gap-2">
                <RunStatusBadge status={managerRun.status} showLabel />
                <WorktreeChip directory={managerRun.directory} />
                {runningDevServer && (
                  <span
                    title={runningDevServer}
                    className="inline-flex items-center gap-1 rounded border border-green-500/40 bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-400"
                  >
                    <ServerIcon className="h-2.5 w-2.5" />
                    Dev server running
                  </span>
                )}
                {selectedRunGhStatus && <GhStatusBadge status={selectedRunGhStatus} />}
                {managerRun.langfuseTraceId && (
                  <a
                    href={`https://cloud.langfuse.com/project/cmo5hp4ig0060ad087u3nvi5d/traces/${managerRun.langfuseTraceId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline"
                  >
                    Langfuse
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Issue body + labels — collapsible so the chat view gets most of the space. */}
          <details
            className="group shrink-0 border-b bg-muted/10 [&_summary::-webkit-details-marker]:hidden"
            open={!managerRun}
          >
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/20">
              <span className="font-medium uppercase tracking-wider">Issue</span>
              {card.issue.labels.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {card.issue.labels.map((l) => (
                    <Badge key={l.name} variant="secondary" size="sm" className="text-[10px]">
                      {l.name}
                    </Badge>
                  ))}
                </div>
              )}
              <span className="ml-auto text-[10px] opacity-60 group-open:hidden">expand</span>
              <span className="ml-auto hidden text-[10px] opacity-60 group-open:inline">
                collapse
              </span>
            </summary>
            <div className="max-h-64 overflow-auto px-4 pb-3">
              <div className="max-w-none text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[.85em] [&_h1]:my-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:text-xs [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
                {hasIssueBody ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.issue.body}</ReactMarkdown>
                ) : (
                  <p className="text-muted-foreground italic">No description</p>
                )}
              </div>
            </div>
          </details>

          {/* Start button if no run */}
          {!managerRun && (
            <div className="shrink-0 border-b px-4 py-3">
              <Button
                onClick={() => void handleStart()}
                disabled={starting || !repoForStart}
                className="w-full"
              >
                {starting ? "Starting…" : "Start Agent"}
              </Button>
              {startError && <p className="mt-2 text-xs text-red-400">{startError}</p>}
              {!repoForStart && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Select a repository to start an agent.
                </p>
              )}
            </div>
          )}

          {/* Run tree */}
          {managerRun && (
            <div className="shrink-0 border-b px-4 py-3">
              <RunTreeView
                managerRun={managerRun}
                taskRuns={taskRuns}
                selectedRunId={selectedRunId}
                onSelectRun={setSelectedRunId}
                accentColor={issueAccent}
              />
            </div>
          )}

          {/* Tabs + main view */}
          {selectedRun && (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b bg-muted/10 px-4 py-2">
                <TabButton
                  active={viewMode === "chat"}
                  onClick={() => setViewMode("chat")}
                  label="Chat"
                />
                <TabButton
                  active={viewMode === "raw"}
                  onClick={() => setViewMode("raw")}
                  label="Raw"
                  hint="Debug timeline"
                />
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {selectedRun.events.length} events
                </span>
              </div>

              <div className="min-h-0 flex-1">
                {viewMode === "chat" ? (
                  <SessionChatView
                    run={selectedRun}
                    taskRuns={taskRuns}
                    onSelectRun={setSelectedRunId}
                  />
                ) : (
                  <ScrollArea className="h-full">
                    <div className="px-4 py-3">
                      <EventStreamView
                        run={selectedRun}
                        filterMode={filterMode}
                        onFilterChange={setFilterMode}
                      />
                    </div>
                  </ScrollArea>
                )}
              </div>
            </>
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

function TabButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
      title={hint}
    >
      {label}
    </button>
  );
}
