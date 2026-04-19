import { create } from "zustand";

import type {
  CrucibleIssue,
  CrucibleRepo,
  CrucibleRun,
  GhStatus,
  KanbanCard,
  KanbanColumnId,
} from "./types";

interface CrucibleState {
  // Data
  selectedRepo: string | null; // "owner/name"
  repos: CrucibleRepo[];
  issues: CrucibleIssue[];
  runs: CrucibleRun[];
  selectedCard: KanbanCard | null;
  /** Map of runId -> latest GitHub CI status payload (polled per-run). */
  ghStatus: Record<string, GhStatus>;

  // Actions
  setSelectedRepo: (repo: string | null) => void;
  setRepos: (repos: CrucibleRepo[]) => void;
  setIssues: (issues: CrucibleIssue[]) => void;
  setRuns: (runs: CrucibleRun[]) => void;
  upsertRuns: (runs: CrucibleRun[]) => void;
  setSelectedCard: (card: KanbanCard | null) => void;
  setGhStatus: (runId: string, status: GhStatus) => void;
}

export const useCrucibleStore = create<CrucibleState>((set) => ({
  selectedRepo: null,
  repos: [],
  issues: [],
  runs: [],
  selectedCard: null,
  ghStatus: {},

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
  setGhStatus: (runId, status) =>
    set((state) => ({ ghStatus: { ...state.ghStatus, [runId]: status } })),
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

/**
 * Distinct colors used to visually identify individual issues across the board,
 * the detail panel, and the run tree. Deterministic per `issueNumber` so the
 * same issue always shows the same accent everywhere it appears.
 */
export const ISSUE_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#f97316", // orange
  "#84cc16", // lime
] as const;

export function getIssueColor(issueNumber: number): string {
  const n = ((issueNumber % ISSUE_COLORS.length) + ISSUE_COLORS.length) % ISSUE_COLORS.length;
  // Guaranteed in-range because of the modulo above.
  return ISSUE_COLORS[n]!;
}
