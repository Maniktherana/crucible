import { ExternalLinkIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

import { RunStatusBadge } from "./RunStatusBadge";
import type { CrucibleRun } from "./types";

interface RunTreeViewProps {
  managerRun: CrucibleRun;
  taskRuns: CrucibleRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
}

interface RunTreeNodeProps {
  run: CrucibleRun;
  label: string;
  isSelected: boolean;
  onClick: () => void;
  depth: number;
  isLast?: boolean;
}

function truncate(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

function RunTreeNode({ run, label, isSelected, onClick, depth, isLast }: RunTreeNodeProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent/50",
        isSelected && "bg-accent ring-1 ring-border",
      )}
      style={{ paddingLeft: `${8 + depth * 18}px` }}
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
      <span className="font-medium">{label}</span>
      <span className="truncate text-xs text-muted-foreground">{truncate(run.prompt, 80)}</span>
      {run.prUrl && (
        <Badge variant="secondary" size="sm" className="ml-auto shrink-0 text-[10px]">
          <ExternalLinkIcon className="h-2.5 w-2.5" />
          PR
        </Badge>
      )}
    </button>
  );
}

export function RunTreeView({
  managerRun,
  taskRuns,
  selectedRunId,
  onSelectRun,
}: RunTreeViewProps) {
  return (
    <div className="space-y-1">
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Agent Tree
      </h4>

      <RunTreeNode
        run={managerRun}
        label="Manager"
        isSelected={selectedRunId === managerRun.id}
        onClick={() => onSelectRun(managerRun.id)}
        depth={0}
      />

      {taskRuns.map((run, i) => (
        <RunTreeNode
          key={run.id}
          run={run}
          label={`Task ${i + 1}`}
          isSelected={selectedRunId === run.id}
          onClick={() => onSelectRun(run.id)}
          depth={1}
          isLast={i === taskRuns.length - 1}
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
