import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Sheet, SheetPopup } from "~/components/ui/sheet";

import { EventStreamView, type EventFilterMode } from "./EventStreamView";
import { RunStatusBadge } from "./RunStatusBadge";
import { RunTreeView } from "./RunTreeView";
import type { CrucibleRun, KanbanCard } from "./types";
import { getRepoPath, useCrucibleStore } from "./useCrucibleStore";

const RUN_POLL_INTERVAL_MS = 2000;

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

/**
 * Polls the server for the given run ids every 2s and upserts the results
 * into the global store. Cancels cleanly on unmount / id-set change.
 */
function useRunPolling(runIds: string[]) {
  const upsertRuns = useCrucibleStore((s) => s.upsertRuns);
  // Serialize the ids so that the effect only re-runs when the set of ids
  // actually changes (not when the array reference changes every render).
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

export function CardDetailPanel({ card, onClose }: CardDetailPanelProps) {
  const runs = useCrucibleStore((s) => s.runs);
  const repos = useCrucibleStore((s) => s.repos);
  const selectedRepo = useCrucibleStore((s) => s.selectedRepo);

  // Prefer the latest version of the card's runs from the global store
  // (polling updates land there), falling back to what the card was seeded with.
  const managerRun = useMemo<CrucibleRun | undefined>(() => {
    if (!card.managerRun) return undefined;
    return runs.find((r) => r.id === card.managerRun?.id) ?? card.managerRun;
  }, [card.managerRun, runs]);

  const taskRuns = useMemo<CrucibleRun[]>(() => {
    const managerId = managerRun?.id;
    if (managerId) {
      // Prefer children linked through the manager run's own child ids.
      const byParent = runs.filter((r) => r.parentRunId === managerId);
      if (byParent.length > 0) return byParent;
    }
    // Fallback: use runs captured on the card at mount time, but refreshed
    // with store data when available.
    return card.taskRuns.map((cardRun) => runs.find((r) => r.id === cardRun.id) ?? cardRun);
  }, [card.taskRuns, managerRun?.id, runs]);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(managerRun?.id ?? null);
  const [filterMode, setFilterMode] = useState<EventFilterMode>("all");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Re-seed the selected run when a manager run first appears (e.g. after Start).
  useEffect(() => {
    if (!selectedRunId && managerRun) {
      setSelectedRunId(managerRun.id);
    }
  }, [managerRun, selectedRunId]);

  // Poll the manager run + all current task runs.
  const pollIds = useMemo(() => {
    const ids: string[] = [];
    if (managerRun) ids.push(managerRun.id);
    for (const t of taskRuns) ids.push(t.id);
    return ids;
  }, [managerRun, taskRuns]);
  useRunPolling(pollIds);

  const selectedRun = useMemo<CrucibleRun | null>(() => {
    if (!selectedRunId) return null;
    if (managerRun?.id === selectedRunId) return managerRun;
    return taskRuns.find((r) => r.id === selectedRunId) ?? null;
  }, [managerRun, selectedRunId, taskRuns]);

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
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-xs text-muted-foreground">#{card.issue.number}</span>
              <h2 className="truncate text-sm font-semibold">{card.issue.title}</h2>
              {managerRun && <RunStatusBadge status={managerRun.status} showLabel />}
              {managerRun?.langfuseTraceId && (
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

          <ScrollArea className="min-h-0 flex-1">
            {/* Issue body + labels */}
            <div className="border-b px-4 py-3">
              <div className="max-w-none text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[.85em] [&_h1]:my-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:my-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:text-xs [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
                {card.issue.body ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.issue.body}</ReactMarkdown>
                ) : (
                  <p className="text-muted-foreground italic">No description</p>
                )}
              </div>
              {card.issue.labels.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {card.issue.labels.map((l) => (
                    <Badge key={l.name} variant="secondary" size="sm" className="text-[10px]">
                      {l.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Start button if no run */}
            {!managerRun && (
              <div className="border-b px-4 py-3">
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
              <div className="border-b px-4 py-3">
                <RunTreeView
                  managerRun={managerRun}
                  taskRuns={taskRuns}
                  selectedRunId={selectedRunId}
                  onSelectRun={setSelectedRunId}
                />
              </div>
            )}

            {/* Event stream for selected run */}
            {selectedRun && (
              <div className="px-4 py-3">
                <EventStreamView
                  run={selectedRun}
                  filterMode={filterMode}
                  onFilterChange={setFilterMode}
                />
              </div>
            )}
          </ScrollArea>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
