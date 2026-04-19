import { AlertTriangleIcon, CheckIcon, ExternalLinkIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import type { CrucibleRun, CrucibleRunEvent, CrucibleRunStatus, KanbanCard } from "./types";
import { getIssueColor } from "./useCrucibleStore";

interface IssueCardProps {
  card: KanbanCard;
  onClick: () => void;
  onStart?: () => void;
  starting?: boolean;
}

const STATUS_LABEL: Record<CrucibleRunStatus, string> = {
  starting: "Starting\u2026",
  running: "Running\u2026",
  completed: "Completed",
  error: "Error",
};

function RunStatusDot({ status }: { status: CrucibleRunStatus }) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={cn(
          "h-2 w-2 rounded-full",
          status === "starting" && "bg-yellow-500",
          status === "running" && "animate-pulse bg-blue-500",
          status === "completed" && "bg-green-500",
          status === "error" && "bg-red-500",
        )}
      />
      <span
        className={cn(
          "text-[10px]",
          status === "starting" && "text-yellow-500",
          status === "running" && "text-blue-500",
          status === "completed" && "text-green-500",
          status === "error" && "text-red-500",
        )}
      >
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}

// -- Derivations -------------------------------------------------------------

function countRunningAgents(managerRun: CrucibleRun | undefined, taskRuns: CrucibleRun[]): number {
  let n = 0;
  if (managerRun && managerRun.status === "running") n += 1;
  for (const r of taskRuns) if (r.status === "running" || r.status === "starting") n += 1;
  return n;
}

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

/**
 * Find the most recent agent text output across all runs on this card, for
 * the "activity ticker" on in-progress cards. Walks events in reverse so the
 * cost is bounded by early exits.
 */
function latestAgentText(runs: CrucibleRun[]): string | null {
  let candidate: { text: string; at: string } | null = null;
  for (const run of runs) {
    for (let i = run.events.length - 1; i >= 0; i--) {
      const event = run.events[i]!;
      if (event.type !== "message.part.updated") continue;
      const part = partOfEvent(event);
      if (!part) continue;
      if (part.type !== "text") continue;
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (!text) continue;
      if (!candidate || event.at > candidate.at) {
        candidate = { text, at: event.at };
      }
      break;
    }
  }
  if (!candidate) return null;
  const oneLine = candidate.text.replace(/\s+/g, " ").trim();
  return oneLine.length > 50 ? `${oneLine.slice(0, 50)}…` : oneLine;
}

function extractPrNumber(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function cardDurationMs(run: CrucibleRun): number | null {
  if (typeof run.durationMs === "number") return run.durationMs;
  const start = run.startedAt ?? run.createdAt;
  const end = run.completedAt ?? run.updatedAt;
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// ----------------------------------------------------------------------------

export function IssueCard({ card, onClick, onStart, starting }: IssueCardProps) {
  const completedTasks = card.taskRuns.filter((r) => r.status === "completed").length;
  const totalTasks = card.taskRuns.length;
  const isActive =
    card.column === "in_progress" &&
    card.managerRun &&
    (card.managerRun.status === "starting" || card.managerRun.status === "running");
  const runningAgents = countRunningAgents(card.managerRun, card.taskRuns);
  const allRuns = card.managerRun ? [card.managerRun, ...card.taskRuns] : card.taskRuns;
  const latestText = isActive ? latestAgentText(allRuns) : null;
  const needsInput =
    card.managerRun?.needsInput === true || card.taskRuns.some((r) => r.needsInput === true);

  const prUrl = card.managerRun?.prUrl ?? card.taskRuns.find((r) => !!r.prUrl)?.prUrl ?? undefined;
  const prNumber = prUrl ? extractPrNumber(prUrl) : null;

  // Duration: prefer manager-run duration for "done" cards.
  const doneDurationMs =
    card.column === "done" && card.managerRun ? cardDurationMs(card.managerRun) : null;

  const issueColor = getIssueColor(card.issue.number);
  const inlineBorderStyle: React.CSSProperties | undefined =
    card.column === "in_progress" ? { borderLeftColor: issueColor } : undefined;

  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors hover:bg-accent/50",
        "border-l-4",
        card.column === "todo" && "border-l-muted-foreground/30",
        card.column === "done" && "border-l-green-500",
      )}
      style={inlineBorderStyle}
      render={
        <div
          role="button"
          tabIndex={0}
          onClick={onClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onClick();
          }}
        />
      }
    >
      <CardHeader className="p-3 pb-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">#{card.issue.number}</span>
          <div className="flex items-center gap-2">
            {needsInput && (
              <Badge size="sm" className="bg-orange-500/20 text-orange-400 text-[10px]">
                <AlertTriangleIcon className="h-2.5 w-2.5" />
                Needs input
              </Badge>
            )}
            {card.managerRun && <RunStatusDot status={card.managerRun.status} />}
          </div>
        </div>
        <CardTitle className="text-sm font-medium leading-snug">{card.issue.title}</CardTitle>
      </CardHeader>
      <CardPanel className="p-3 pt-1">
        {card.issue.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {card.issue.labels.map((l) => (
              <Badge key={l.name} variant="secondary" className="text-[10px]">
                {l.name}
              </Badge>
            ))}
          </div>
        )}

        {/* In-progress: "N agents running" + latest activity ticker */}
        {isActive && (
          <div className="mt-1.5 space-y-1">
            <div className="flex items-center gap-2 text-[11px] text-blue-500">
              <Spinner className="h-3 w-3" />
              <span>
                {runningAgents > 0
                  ? `${runningAgents} agent${runningAgents !== 1 ? "s" : ""} running`
                  : "Agent working…"}
              </span>
              {totalTasks > 0 && (
                <span className="text-muted-foreground">
                  · {completedTasks}/{totalTasks} done
                </span>
              )}
            </div>
            {latestText && (
              <p className="truncate text-[11px] text-muted-foreground" title={latestText}>
                {latestText}
              </p>
            )}
          </div>
        )}

        {/* Non-active cards that still have task breakdowns (e.g. after error) */}
        {!isActive && totalTasks > 0 && card.column !== "done" && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {completedTasks}/{totalTasks} subtask{totalTasks !== 1 ? "s" : ""} done
          </span>
        )}

        {/* Done column: completion summary */}
        {card.column === "done" && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-green-500">
            <span className="flex items-center gap-1">
              <CheckIcon className="h-3 w-3" />
              Completed
            </span>
            {doneDurationMs !== null && (
              <span className="text-muted-foreground">Took {formatDuration(doneDurationMs)}</span>
            )}
          </div>
        )}

        {/* PR badge (any column) */}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-1.5 inline-flex items-center gap-1 rounded border bg-muted/30 px-1.5 py-0.5 text-[11px] font-mono text-foreground hover:bg-muted/60"
          >
            <ExternalLinkIcon className="h-2.5 w-2.5" />
            {prNumber !== null ? `PR #${prNumber}` : "PR"}
          </a>
        )}

        {onStart && (
          <Button
            size="sm"
            className="mt-2 w-full"
            disabled={!!starting || isActive === true}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onStart();
            }}
          >
            {starting || isActive ? (
              <>
                <Spinner className="mr-1.5 h-3.5 w-3.5" />
                {isActive ? "Running…" : "Starting…"}
              </>
            ) : (
              "Start"
            )}
          </Button>
        )}
      </CardPanel>
    </Card>
  );
}
