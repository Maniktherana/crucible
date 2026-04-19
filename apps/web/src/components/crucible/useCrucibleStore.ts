import { create } from "zustand";

import type { CrucibleIssue, CrucibleRepo, CrucibleRun, KanbanCard, KanbanColumnId } from "./types";

interface CrucibleState {
  // Data
  selectedRepo: string | null; // "owner/name"
  repos: CrucibleRepo[];
  issues: CrucibleIssue[];
  runs: CrucibleRun[];
  selectedCard: KanbanCard | null;

  // Actions
  setSelectedRepo: (repo: string | null) => void;
  setRepos: (repos: CrucibleRepo[]) => void;
  setIssues: (issues: CrucibleIssue[]) => void;
  setRuns: (runs: CrucibleRun[]) => void;
  upsertRuns: (runs: CrucibleRun[]) => void;
  setSelectedCard: (card: KanbanCard | null) => void;
}

export const useCrucibleStore = create<CrucibleState>((set) => ({
  selectedRepo: null,
  repos: [],
  issues: [],
  runs: [],
  selectedCard: null,

  setSelectedRepo: (repo) => set({ selectedRepo: repo }),
  setRepos: (repos) => set({ repos }),
  setIssues: (issues) => set({ issues }),
  setRuns: (runs) => set({ runs }),
  upsertRuns: (incoming) =>
    set((state) => {
      const map = new Map(state.runs.map((r) => [r.id, r]));
      for (const run of incoming) {
        map.set(run.id, run);
      }
      return { runs: Array.from(map.values()) };
    }),
  setSelectedCard: (card) => set({ selectedCard: card }),
}));

/** Look up the on-disk path for the currently selected repo. */
export function getRepoPath(repos: CrucibleRepo[], repoName: string | null): string | null {
  if (!repoName) return null;
  const match = repos.find((r) => r.name === repoName);
  return match?.path ?? null;
}

/** Derive kanban cards from issues + runs (pure selector, not stored). */
export function deriveKanbanCards(issues: CrucibleIssue[], runs: CrucibleRun[]): KanbanCard[] {
  return issues.map((issue) => {
    const issueRuns = runs.filter((r) => r.issueNumber === issue.number);
    const managerRun = issueRuns.find((r) => r.type === "manager");
    const taskRuns = issueRuns.filter((r) => r.type === "task");

    let column: KanbanColumnId = "todo";
    if (managerRun) {
      if (managerRun.status === "completed" && taskRuns.every((r) => r.status === "completed")) {
        column = "done";
      } else {
        column = "in_progress";
      }
    }

    const card: KanbanCard = { issue, column, taskRuns };
    if (managerRun) {
      card.managerRun = managerRun;
    }
    return card;
  });
}
