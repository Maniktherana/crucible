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

export interface CrucibleAttachment {
  id: string;
  runId: string;
  path: string;
  /** "before" | "after" | "" */
  label: string;
  createdAt: string;
}

export type CrucibleApprovalStatus = "pending" | "approved" | "denied";

export interface CrucibleApproval {
  id: string;
  runId: string;
  repo: string;
  command: string;
  reason: string;
  status: CrucibleApprovalStatus;
  addedToAllowlist: boolean;
  createdAt: string;
  resolvedAt?: string;
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
  attachments?: CrucibleAttachment[];
  /** Pending + resolved operator command-approval requests for this run. */
  approvals?: CrucibleApproval[];
  /** Run is waiting on external input (e.g. permission prompt from the agent). */
  needsInput?: boolean;
}

/**
 * CI status for a PR, populated by polling
 * `GET /api/crucible/runs/:runId/gh-status` (Stream 1 endpoint).
 *
 * When the server responds with `{ status: "no_pr" }` the UI should render
 * nothing for this run.
 */
export type GhCiStatus = "no_pr" | "pending" | "passing" | "failing" | "merged";

export interface GhStatus {
  status: GhCiStatus;
  /** Short GitHub PR number (e.g. 42). Absent when status === "no_pr". */
  prNumber?: number;
  /** Full PR URL, when known. */
  prUrl?: string;
  /** ISO timestamp of the last check run, when known. */
  updatedAt?: string;
}

/** Result from GET /api/crucible/runs/:runId/gh-status (polled when prUrl is set). */
export interface CrucibleGhStatus {
  status: "no_pr" | "pending" | "passing" | "failing" | "merged";
  /** e.g. "5/7 checks passing" */
  summary?: string;
  prNumber?: number;
  prUrl?: string;
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
