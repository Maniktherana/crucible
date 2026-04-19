import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

import { RunStatusBadge } from "./RunStatusBadge";
import type { CrucibleRun } from "./types";

interface RunTreeViewProps {
  managerRun: CrucibleRun;
  taskRuns: CrucibleRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  /** Issue accent color applied to each node's left rail. */
  accentColor?: string;
}

interface RunTreeNodeProps {
  run: CrucibleRun;
  label: string;
  detail: string;
  isSelected: boolean;
  onClick: () => void;
  depth: number;
  isLast?: boolean;
  accentColor?: string;
}

function truncate(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function sumTokens(run: CrucibleRun): number {
  return run.events.reduce((sum, e) => sum + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0);
}

function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

function extractPrNumber(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/** First 50 chars of the run prompt (one-lined) for a human-readable task name. */
function taskNameFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Task";
  return cleaned.length > 50 ? `${cleaned.slice(0, 50)}…` : cleaned;
}

function RunTreeNode({
  run,
  label,
  detail,
  isSelected,
  onClick,
  depth,
  isLast,
  accentColor,
}: RunTreeNodeProps) {
  const totalTokens = sumTokens(run);
  const prNumber = run.prUrl ? extractPrNumber(run.prUrl) : null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent/50",
        isSelected && "bg-accent ring-1 ring-border",
      )}
      style={{
        paddingLeft: `${8 + depth * 18}px`,
        ...(accentColor
          ? { borderLeft: `3px solid ${accentColor}`, paddingLeft: `${10 + depth * 18}px` }
          : {}),
      }}
    >
      {depth > 0 && (
        <span
          aria-hidden
          className={cn(
            "inline-block font-mono text-muted-foreground/50 select-none",
            isLast ? "before:content-['└─']" : "before:content-['├─']",
          )}
        />
      )}
      <RunStatusBadge status={run.status} />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
      {totalTokens > 0 && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatTokenCount(totalTokens)} tokens
        </span>
      )}
      {run.needsInput && (
        <Badge size="sm" className="shrink-0 bg-orange-500/20 text-orange-400 text-[10px]">
          <AlertTriangleIcon className="h-2.5 w-2.5" />
          Blocked
        </Badge>
      )}
      {run.prUrl && (
        <a
          href={run.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border bg-background/40 px-1.5 py-0.5 text-[10px] font-mono text-foreground hover:bg-background"
        >
          <ExternalLinkIcon className="h-2.5 w-2.5" />
          {prNumber !== null ? `PR #${prNumber}` : "PR"}
        </a>
      )}
    </button>
  );
}

export function RunTreeView({
  managerRun,
  taskRuns,
  selectedRunId,
  onSelectRun,
  accentColor,
}: RunTreeViewProps) {
  return (
    <div className="space-y-1">
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Agent Tree
      </h4>

      <RunTreeNode
        run={managerRun}
        label="Manager"
        detail={truncate(managerRun.prompt, 80)}
        isSelected={selectedRunId === managerRun.id}
        onClick={() => onSelectRun(managerRun.id)}
        depth={0}
        {...(accentColor ? { accentColor } : {})}
      />

      {taskRuns.map((run, i) => (
        <RunTreeNode
          key={run.id}
          run={run}
          label={taskNameFromPrompt(run.prompt)}
          detail=""
          isSelected={selectedRunId === run.id}
          onClick={() => onSelectRun(run.id)}
          depth={1}
          isLast={i === taskRuns.length - 1}
          {...(accentColor ? { accentColor } : {})}
        />
      ))}

      {taskRuns.length === 0 && (
        <div
          className="px-2 py-1 text-xs text-muted-foreground/70 italic"
          style={{ paddingLeft: `${8 + 1 * 18}px` }}
        >
          No subtasks spawned yet
        </div>
      )}
    </div>
  );
}
