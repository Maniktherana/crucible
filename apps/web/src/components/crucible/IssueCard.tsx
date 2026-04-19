import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";

import type { CrucibleRunStatus, KanbanCard } from "./types";

interface IssueCardProps {
  card: KanbanCard;
  onClick: () => void;
  onStart?: () => void;
}

function RunStatusDot({ status }: { status: CrucibleRunStatus }) {
  return (
    <div
      className={cn(
        "h-2 w-2 rounded-full",
        status === "starting" && "bg-yellow-500",
        status === "running" && "animate-pulse bg-blue-500",
        status === "completed" && "bg-green-500",
        status === "error" && "bg-red-500",
      )}
    />
  );
}

export function IssueCard({ card, onClick, onStart }: IssueCardProps) {
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
        {card.taskRuns.length > 0 && (
          <span className="mt-1 block text-xs text-muted-foreground">
            {card.taskRuns.length} subtask{card.taskRuns.length !== 1 ? "s" : ""}
          </span>
        )}
        {onStart && (
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onStart();
            }}
          >
            Start
          </Button>
        )}
      </CardPanel>
    </Card>
  );
}
