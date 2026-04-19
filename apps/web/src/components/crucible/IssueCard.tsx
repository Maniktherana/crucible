import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import type { CrucibleRunStatus, KanbanCard } from "./types";

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

export function IssueCard({ card, onClick, onStart, starting }: IssueCardProps) {
  const completedTasks = card.taskRuns.filter((r) => r.status === "completed").length;
  const totalTasks = card.taskRuns.length;
  const totalEvents = card.managerRun ? card.managerRun.events.length : 0;
  const isActive =
    card.column === "in_progress" &&
    card.managerRun &&
    (card.managerRun.status === "starting" || card.managerRun.status === "running");

  return (
    <Card
      className={cn(
        "cursor-pointer transition-colors hover:bg-accent/50",
        "border-l-4",
        card.column === "todo" && "border-l-muted-foreground/30",
        card.column === "in_progress" && "border-l-blue-500",
        card.column === "done" && "border-l-green-500",
      )}
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
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">#{card.issue.number}</span>
          {card.managerRun && <RunStatusDot status={card.managerRun.status} />}
        </div>
        <CardTitle className="text-sm font-medium leading-snug">{card.issue.title}</CardTitle>
      </CardHeader>
      <CardPanel className="p-3 pt-1">
        <div className="flex items-center gap-2">
          {card.issue.labels.map((l) => (
            <Badge key={l.name} variant="secondary" className="text-[10px]">
              {l.name}
            </Badge>
          ))}
        </div>

        {/* In-progress activity info */}
        {isActive && (
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-blue-500">
            <Spinner className="h-3 w-3" />
            <span>
              {totalEvents > 0 && `${totalEvents} event${totalEvents !== 1 ? "s" : ""}`}
              {totalEvents > 0 && totalTasks > 0 && " · "}
              {totalTasks > 0 && `${completedTasks}/${totalTasks} subtasks done`}
              {totalEvents === 0 && totalTasks === 0 && "Agent working\u2026"}
            </span>
          </div>
        )}

        {/* Subtask summary for non-active cards that have tasks */}
        {!isActive && totalTasks > 0 && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {completedTasks}/{totalTasks} subtask{totalTasks !== 1 ? "s" : ""} done
          </span>
        )}

        {onStart && (
          <Button
            size="sm"
            className="mt-2 w-full"
            disabled={!!starting}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onStart();
            }}
          >
            {starting ? (
              <>
                <Spinner className="mr-1.5 h-3.5 w-3.5" />
                Starting…
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
