import { useCallback, useEffect, useRef } from "react";

import type { CrucibleIssue, CrucibleRun } from "./types";
import { CardDetailPanel } from "./CardDetailPanel";
import { KanbanColumn } from "./KanbanColumn";
import { deriveKanbanCards, useCrucibleStore } from "./useCrucibleStore";

const POLL_INTERVAL_MS = 2000;

async function fetchRuns(repo: string): Promise<CrucibleRun[]> {
  try {
    const res = await fetch(`/api/crucible/runs?repo=${encodeURIComponent(repo)}`);
    if (!res.ok) throw new Error("fetch failed");
    const data = (await res.json()) as { runs: CrucibleRun[] };
    return data.runs;
  } catch {
    return [];
  }
}

export function KanbanBoard() {
  const selectedRepo = useCrucibleStore((s) => s.selectedRepo);
  const issues = useCrucibleStore((s) => s.issues);
  const runs = useCrucibleStore((s) => s.runs);
  const selectedCard = useCrucibleStore((s) => s.selectedCard);
  const upsertRuns = useCrucibleStore((s) => s.upsertRuns);
  const setSelectedCard = useCrucibleStore((s) => s.setSelectedCard);

  // Poll runs every 2s while a repo is selected
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!selectedRepo) return;

    const poll = () => {
      void fetchRuns(selectedRepo).then(upsertRuns);
    };

    // Immediate first poll
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [selectedRepo, upsertRuns]);

  const handleStartIssue = useCallback(
    async (issue: CrucibleIssue) => {
      if (!selectedRepo) return;
      try {
        await fetch("/api/crucible/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: selectedRepo,
            issueNumber: issue.number,
            prompt: `Issue #${issue.number}: ${issue.title}\n\n${issue.body}`,
            plannerMode: true,
            type: "manager",
          }),
        });
        // Polling will pick up the new run automatically
      } catch {
        // Silently fail — polling will reconcile
      }
    },
    [selectedRepo],
  );

  const cards = deriveKanbanCards(issues, runs);
  const todoCards = cards.filter((c) => c.column === "todo");
  const inProgressCards = cards.filter((c) => c.column === "in_progress");
  const doneCards = cards.filter((c) => c.column === "done");

  return (
    <>
      <div className="flex h-full gap-4 overflow-x-auto p-4">
        <KanbanColumn
          title="Todo"
          columnId="todo"
          cards={todoCards}
          onStartIssue={handleStartIssue}
        />
        <KanbanColumn title="In Progress" columnId="in_progress" cards={inProgressCards} />
        <KanbanColumn title="Done" columnId="done" cards={doneCards} />
      </div>

      {selectedCard && (
        <CardDetailPanel card={selectedCard} onClose={() => setSelectedCard(null)} />
      )}
    </>
  );
}
