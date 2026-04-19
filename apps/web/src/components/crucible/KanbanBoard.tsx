import { useCallback, useEffect, useRef, useState } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { toastManager } from "~/components/ui/toast";

import type { CrucibleIssue, CrucibleRun } from "./types";
import { CardDetailPanel } from "./CardDetailPanel";
import { KanbanColumn } from "./KanbanColumn";
import { OnboardingView } from "./OnboardingView";
import { deriveKanbanCards, getRepoPath, useCrucibleStore } from "./useCrucibleStore";

const POLL_INTERVAL_MS = 2000;

async function fetchRuns(repo: string): Promise<CrucibleRun[]> {
  try {
    const res = await fetch(`/api/crucible/runs?repo=${encodeURIComponent(repo)}`);
    if (!res.ok) throw new Error("fetch failed");
    const data: unknown = await res.json();
    // The server returns a raw array, not { runs: [...] }.
    if (Array.isArray(data)) return data as CrucibleRun[];
    // Defensive: also handle { runs: [...] } shape in case the API changes.
    if (
      data &&
      typeof data === "object" &&
      "runs" in data &&
      Array.isArray((data as { runs: unknown }).runs)
    ) {
      return (data as { runs: CrucibleRun[] }).runs;
    }
    return [];
  } catch {
    return [];
  }
}

export function KanbanBoard() {
  const selectedRepo = useCrucibleStore((s) => s.selectedRepo);
  const repos = useCrucibleStore((s) => s.repos);
  const issues = useCrucibleStore((s) => s.issues);
  const runs = useCrucibleStore((s) => s.runs);
  const selectedCard = useCrucibleStore((s) => s.selectedCard);
  const upsertRuns = useCrucibleStore((s) => s.upsertRuns);
  const setSelectedCard = useCrucibleStore((s) => s.setSelectedCard);

  const [startingIssueNumber, setStartingIssueNumber] = useState<number | null>(null);

  // ---- Hooks MUST come before any conditional returns. React uses call
  // order to match hooks to their slots; returning early on the first render
  // and then running these on a subsequent render changes the hook count,
  // which throws "Rendered more hooks than during the previous render". ----
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll runs every 2s while a repo is selected.
  useEffect(() => {
    if (!selectedRepo) return;

    const poll = () => {
      void fetchRuns(selectedRepo).then(upsertRuns);
    };

    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [selectedRepo, upsertRuns]);

  const handleStartIssue = useCallback(
    async (issue: CrucibleIssue) => {
      if (!selectedRepo) return;
      const directory = getRepoPath(repos, selectedRepo);
      if (!directory) {
        toastManager.add({
          type: "error",
          title: "Cannot start agent",
          description: "No local directory found for the selected repository.",
        });
        return;
      }
      setStartingIssueNumber(issue.number);
      try {
        const res = await fetch("/api/crucible/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: selectedRepo,
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueBody: issue.body,
            prompt: `Issue #${issue.number}: ${issue.title}\n\n${issue.body}`,
            directory,
            plannerMode: true,
            type: "manager",
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Start failed (${res.status})`);
        }
        toastManager.add({
          type: "success",
          title: "Agent started",
          description: `Agent started for Issue #${issue.number}`,
        });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "Failed to start agent",
          description: err instanceof Error ? err.message : "Unknown error",
        });
      } finally {
        setStartingIssueNumber(null);
      }
    },
    [repos, selectedRepo],
  );

  // ---- Now it's safe to branch on state. ----

  // Show onboarding when no repos are cloned.
  if (repos.length === 0) {
    return <OnboardingView />;
  }

  // Show prompt to select a repo when repos exist but none selected.
  if (!selectedRepo) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyTitle>Select a repository from the dropdown above</EmptyTitle>
          <EmptyDescription>
            Choose a repository to view its issues on the kanban board.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

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
          startingIssueNumber={startingIssueNumber}
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
