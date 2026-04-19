import { cn } from "~/lib/utils";

import type { CrucibleRunStatus } from "./types";

interface RunStatusBadgeProps {
  status: CrucibleRunStatus;
  /** If true, renders the textual label after the dot. */
  showLabel?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<CrucibleRunStatus, { color: string; label: string; pulse?: boolean }> =
  {
    starting: { color: "bg-yellow-500", label: "Starting" },
    running: { color: "bg-blue-500", label: "Running", pulse: true },
    completed: { color: "bg-green-500", label: "Completed" },
    error: { color: "bg-red-500", label: "Error" },
  };

export function RunStatusBadge({ status, showLabel = false, className }: RunStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={config.label}
      aria-label={`Status: ${config.label}`}
    >
      <span
        className={cn(
          "inline-block h-2 w-2 shrink-0 rounded-full",
          config.color,
          config.pulse && "animate-pulse",
        )}
      />
      {showLabel && <span className="text-xs text-muted-foreground">{config.label}</span>}
    </span>
  );
}
