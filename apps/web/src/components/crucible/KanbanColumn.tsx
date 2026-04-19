import { Badge } from "~/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";

import type { CrucibleIssue, KanbanCard, KanbanColumnId } from "./types";
import { IssueCard } from "./IssueCard";
import { useCrucibleStore } from "./useCrucibleStore";

interface KanbanColumnProps {
  title: string;
  columnId: KanbanColumnId;
  cards: KanbanCard[];
  onStartIssue?: (issue: CrucibleIssue) => void;
  startingIssueNumber?: number | null;
}

export function KanbanColumn({
  title,
  columnId,
  cards,
  onStartIssue,
  startingIssueNumber,
}: KanbanColumnProps) {
  const setSelectedCard = useCrucibleStore((s) => s.setSelectedCard);

  return (
    <div className="flex w-80 shrink-0 flex-col rounded-lg bg-muted/30">
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="secondary">{cards.length}</Badge>
      </div>
      <ScrollArea className="flex-1 px-2 pb-2">
        {cards.length === 0 && columnId === "todo" ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle>No open issues found</EmptyTitle>
              <EmptyDescription>Create issues on GitHub to see them here</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {cards.map((card) => (
              <IssueCard
                key={card.issue.number}
                card={card}
                onClick={() => setSelectedCard(card)}
                starting={card.issue.number === startingIssueNumber}
                {...(columnId === "todo" && onStartIssue
                  ? { onStart: () => onStartIssue(card.issue) }
                  : {})}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
