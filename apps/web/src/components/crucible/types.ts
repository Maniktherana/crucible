// Crucible shared data types — consumed by Stream 2 (kanban) and Stream 3 (detail panel).

export interface CrucibleIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  state: "open" | "closed";
  url: string;
  html_url: string;
}

export type CrucibleRunStatus = "starting" | "running" | "completed" | "error";

export type CrucibleRunType = "manager" | "task";

export interface CrucibleRunEvent {
  id: string;
  at: string;
  type: string;
  summary: string;
  payload: unknown;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CrucibleRun {
  id: string;
  type: CrucibleRunType;
  issueNumber?: number;
  repo: string;
  status: CrucibleRunStatus;
  parentRunId?: string;
  childRunIds: string[];
  sessionId?: string;
  directory: string;
  prompt: string;
  events: CrucibleRunEvent[];
  createdAt: string;
  updatedAt: string;
  prUrl?: string;
  error?: string;
  langfuseTraceId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export type KanbanColumnId = "todo" | "in_progress" | "done";

export interface KanbanCard {
  issue: CrucibleIssue;
  column: KanbanColumnId;
  managerRun?: CrucibleRun;
  taskRuns: CrucibleRun[];
}

export interface CrucibleRepo {
  name: string; // "owner/repo"
  path: string; // absolute path on disk
  hasGit: boolean;
}
