/**
 * Crucible run persistence — SQLite CRUD via better-sqlite3.
 *
 * Plain synchronous functions, no Effect dependency.  Events are NOT stored
 * here (too high volume) — they live in NDJSON log files on disk.  This
 * module only persists the run record metadata so that runs survive server
 * restarts.
 *
 * @module crucible/persistence
 */

import * as FS from "node:fs";
import * as Path from "node:path";

import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types (mirrors the subset of CrucibleRunRecord we persist)
// ---------------------------------------------------------------------------

export interface CrucibleAttachment {
  id: string;
  runId: string;
  path: string;
  label: string;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface CrucibleApproval {
  id: string;
  runId: string;
  /** Repo identifier (`owner/name`) the approval applies to. */
  repo: string;
  command: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  /** If true at approval time, the command was also appended to the repo allowlist file. */
  addedToAllowlist: boolean;
}

export interface PersistedCrucibleRun {
  id: string;
  type: string;
  status: string;
  repo: string;
  issueNumber?: number;
  title: string;
  prompt: string;
  directory: string;
  parentRunId?: string;
  childRunIds: string[];
  sessionId?: string;
  serverUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  langfuseTraceId?: string;
  langfuseSpanId?: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

// ---------------------------------------------------------------------------
// Prepared statements (lazily initialised after DB open)
// ---------------------------------------------------------------------------

interface Statements {
  upsertRun: Database.Statement;
  updateStatus: Database.Statement;
  updateChildRunIds: Database.Statement;
  selectAll: Database.Statement;
  deleteById: Database.Statement;
  selectByRepo: Database.Statement;
  insertAttachment: Database.Statement;
  selectAttachmentsByRun: Database.Statement;
  deleteAttachmentsByRun: Database.Statement;
  insertApproval: Database.Statement;
  selectApprovalById: Database.Statement;
  selectApprovalsByRun: Database.Statement;
  selectPendingApprovalsByRun: Database.Statement;
  updateApprovalStatus: Database.Statement;
  deleteApprovalsByRun: Database.Statement;
}

let stmts: Statements | null = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crucible_runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'manager',
  status TEXT NOT NULL DEFAULT 'starting',
  repo TEXT NOT NULL DEFAULT '',
  issue_number INTEGER,
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL DEFAULT '',
  parent_run_id TEXT,
  child_run_ids TEXT NOT NULL DEFAULT '[]',
  session_id TEXT,
  server_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  langfuse_trace_id TEXT,
  langfuse_span_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_crucible_runs_repo ON crucible_runs(repo);
CREATE INDEX IF NOT EXISTS idx_crucible_runs_parent ON crucible_runs(parent_run_id);

CREATE TABLE IF NOT EXISTS crucible_attachments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES crucible_runs(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_run_path ON crucible_attachments(run_id, path);
CREATE INDEX IF NOT EXISTS idx_attachments_run ON crucible_attachments(run_id);

CREATE TABLE IF NOT EXISTS crucible_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  repo TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  added_to_allowlist INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (run_id) REFERENCES crucible_runs(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_run_command ON crucible_approvals(run_id, command);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON crucible_approvals(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON crucible_approvals(status);
`;

export function initCrucibleDb(dbPath: string): void {
  FS.mkdirSync(Path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  stmts = {
    upsertRun: db.prepare(`
      INSERT OR REPLACE INTO crucible_runs (
        id, type, status, repo, issue_number, title, prompt, directory,
        parent_run_id, child_run_ids, session_id, server_url, error,
        created_at, updated_at, started_at, completed_at, duration_ms,
        langfuse_trace_id, langfuse_span_id
      ) VALUES (
        @id, @type, @status, @repo, @issueNumber, @title, @prompt, @directory,
        @parentRunId, @childRunIds, @sessionId, @serverUrl, @error,
        @createdAt, @updatedAt, @startedAt, @completedAt, @durationMs,
        @langfuseTraceId, @langfuseSpanId
      )
    `),

    updateStatus: db.prepare(`
      UPDATE crucible_runs
      SET status = @status,
          updated_at = @updatedAt,
          error = @error,
          started_at = COALESCE(@startedAt, started_at),
          completed_at = COALESCE(@completedAt, completed_at),
          duration_ms = COALESCE(@durationMs, duration_ms),
          session_id = COALESCE(@sessionId, session_id),
          server_url = COALESCE(@serverUrl, server_url)
      WHERE id = @id
    `),

    updateChildRunIds: db.prepare(`
      UPDATE crucible_runs
      SET child_run_ids = @childRunIds,
          updated_at = @updatedAt
      WHERE id = @id
    `),

    selectAll: db.prepare("SELECT * FROM crucible_runs ORDER BY created_at DESC"),

    deleteById: db.prepare("DELETE FROM crucible_runs WHERE id = @id"),

    selectByRepo: db.prepare("SELECT id FROM crucible_runs WHERE repo = @repo"),

    insertAttachment: db.prepare(`
      INSERT OR IGNORE INTO crucible_attachments (id, run_id, path, label, created_at)
      VALUES (@id, @runId, @path, @label, @createdAt)
    `),

    selectAttachmentsByRun: db.prepare(`
      SELECT id, run_id, path, label, created_at
      FROM crucible_attachments
      WHERE run_id = @runId
      ORDER BY created_at ASC
    `),

    deleteAttachmentsByRun: db.prepare("DELETE FROM crucible_attachments WHERE run_id = @runId"),

    insertApproval: db.prepare(`
      INSERT OR IGNORE INTO crucible_approvals (
        id, run_id, repo, command, reason, status, added_to_allowlist,
        created_at, resolved_at
      ) VALUES (
        @id, @runId, @repo, @command, @reason, @status, @addedToAllowlist,
        @createdAt, @resolvedAt
      )
    `),

    selectApprovalById: db.prepare(`
      SELECT id, run_id, repo, command, reason, status, added_to_allowlist,
             created_at, resolved_at
      FROM crucible_approvals
      WHERE id = @id
    `),

    selectApprovalsByRun: db.prepare(`
      SELECT id, run_id, repo, command, reason, status, added_to_allowlist,
             created_at, resolved_at
      FROM crucible_approvals
      WHERE run_id = @runId
      ORDER BY created_at ASC
    `),

    selectPendingApprovalsByRun: db.prepare(`
      SELECT id, run_id, repo, command, reason, status, added_to_allowlist,
             created_at, resolved_at
      FROM crucible_approvals
      WHERE run_id = @runId AND status = 'pending'
      ORDER BY created_at ASC
    `),

    updateApprovalStatus: db.prepare(`
      UPDATE crucible_approvals
      SET status = @status,
          added_to_allowlist = @addedToAllowlist,
          resolved_at = @resolvedAt
      WHERE id = @id
    `),

    deleteApprovalsByRun: db.prepare("DELETE FROM crucible_approvals WHERE run_id = @runId"),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function persistRun(run: PersistedCrucibleRun): void {
  stmts?.upsertRun.run({
    id: run.id,
    type: run.type,
    status: run.status,
    repo: run.repo,
    issueNumber: run.issueNumber ?? null,
    title: run.title,
    prompt: run.prompt,
    directory: run.directory,
    parentRunId: run.parentRunId ?? null,
    childRunIds: JSON.stringify(run.childRunIds),
    sessionId: run.sessionId ?? null,
    serverUrl: run.serverUrl ?? null,
    error: run.error ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    durationMs: run.durationMs ?? null,
    langfuseTraceId: run.langfuseTraceId ?? null,
    langfuseSpanId: run.langfuseSpanId ?? null,
  });
}

export function updateRunStatus(
  runId: string,
  status: string,
  extra?: {
    error?: string | undefined;
    startedAt?: string | undefined;
    completedAt?: string | undefined;
    durationMs?: number | undefined;
    sessionId?: string | undefined;
    serverUrl?: string | undefined;
  },
): void {
  stmts?.updateStatus.run({
    id: runId,
    status,
    updatedAt: new Date().toISOString(),
    error: extra?.error ?? null,
    startedAt: extra?.startedAt ?? null,
    completedAt: extra?.completedAt ?? null,
    durationMs: extra?.durationMs ?? null,
    sessionId: extra?.sessionId ?? null,
    serverUrl: extra?.serverUrl ?? null,
  });
}

export function addChildRunId(parentId: string, childId: string): void {
  if (!db) return;
  const row = db.prepare("SELECT child_run_ids FROM crucible_runs WHERE id = ?").get(parentId) as
    | { child_run_ids: string }
    | undefined;
  if (!row) return;
  const ids: string[] = JSON.parse(row.child_run_ids);
  if (!ids.includes(childId)) {
    ids.push(childId);
  }
  stmts?.updateChildRunIds.run({
    id: parentId,
    childRunIds: JSON.stringify(ids),
    updatedAt: new Date().toISOString(),
  });
}

interface RawRunRow {
  id: string;
  type: string;
  status: string;
  repo: string;
  issue_number: number | null;
  title: string;
  prompt: string;
  directory: string;
  parent_run_id: string | null;
  child_run_ids: string;
  session_id: string | null;
  server_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  langfuse_trace_id: string | null;
  langfuse_span_id: string | null;
}

function rowToRun(row: RawRunRow): PersistedCrucibleRun {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    repo: row.repo,
    ...(row.issue_number != null ? { issueNumber: row.issue_number } : {}),
    title: row.title,
    prompt: row.prompt,
    directory: row.directory,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    childRunIds: JSON.parse(row.child_run_ids) as string[],
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.server_url ? { serverUrl: row.server_url } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
    ...(row.langfuse_trace_id ? { langfuseTraceId: row.langfuse_trace_id } : {}),
    ...(row.langfuse_span_id ? { langfuseSpanId: row.langfuse_span_id } : {}),
  };
}

export function loadAllRuns(): PersistedCrucibleRun[] {
  if (!stmts) return [];
  const rows = stmts.selectAll.all() as RawRunRow[];
  return rows.map(rowToRun);
}

export function deleteRunsByRepo(repo: string): number {
  if (!stmts || !db) return 0;

  // Collect all IDs for this repo (including children whose parent is in this repo)
  const directIds = (stmts.selectByRepo.all({ repo }) as { id: string }[]).map((r) => r.id);
  const allIds = new Set(directIds);

  // Transitively collect children
  const queue = [...directIds];
  while (queue.length > 0) {
    const parentId = queue.pop()!;
    const row = db.prepare("SELECT child_run_ids FROM crucible_runs WHERE id = ?").get(parentId) as
      | { child_run_ids: string }
      | undefined;
    if (!row) continue;
    const childIds: string[] = JSON.parse(row.child_run_ids);
    for (const childId of childIds) {
      if (!allIds.has(childId)) {
        allIds.add(childId);
        queue.push(childId);
      }
    }
  }

  for (const id of allIds) {
    stmts.deleteById.run({ id });
  }

  return allIds.size;
}

export function deleteAllRuns(): number {
  if (!db) return 0;
  const result = db.prepare("DELETE FROM crucible_runs").run();
  return result.changes;
}

// ---------------------------------------------------------------------------
// Attachment CRUD
// ---------------------------------------------------------------------------

export function persistAttachment(a: CrucibleAttachment): void {
  stmts?.insertAttachment.run({
    id: a.id,
    runId: a.runId,
    path: a.path,
    label: a.label,
    createdAt: a.createdAt,
  });
}

export function getAttachmentsForRun(runId: string): CrucibleAttachment[] {
  const rows = (stmts?.selectAttachmentsByRun.all({ runId }) ?? []) as Array<{
    id: string;
    run_id: string;
    path: string;
    label: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    path: r.path,
    label: r.label,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  run_id: string;
  repo: string;
  command: string;
  reason: string;
  status: ApprovalStatus;
  added_to_allowlist: number;
  created_at: string;
  resolved_at: string | null;
}

function rowToApproval(r: ApprovalRow): CrucibleApproval {
  const approval: CrucibleApproval = {
    id: r.id,
    runId: r.run_id,
    repo: r.repo,
    command: r.command,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    addedToAllowlist: r.added_to_allowlist === 1,
  };
  if (r.resolved_at) approval.resolvedAt = r.resolved_at;
  return approval;
}

export function persistApproval(a: CrucibleApproval): void {
  stmts?.insertApproval.run({
    id: a.id,
    runId: a.runId,
    repo: a.repo,
    command: a.command,
    reason: a.reason,
    status: a.status,
    addedToAllowlist: a.addedToAllowlist ? 1 : 0,
    createdAt: a.createdAt,
    resolvedAt: a.resolvedAt ?? null,
  });
}

export function getApprovalById(id: string): CrucibleApproval | null {
  const row = stmts?.selectApprovalById.get({ id }) as ApprovalRow | undefined;
  return row ? rowToApproval(row) : null;
}

export function getApprovalsForRun(runId: string): CrucibleApproval[] {
  const rows = (stmts?.selectApprovalsByRun.all({ runId }) ?? []) as ApprovalRow[];
  return rows.map(rowToApproval);
}

export function getPendingApprovalsForRun(runId: string): CrucibleApproval[] {
  const rows = (stmts?.selectPendingApprovalsByRun.all({ runId }) ?? []) as ApprovalRow[];
  return rows.map(rowToApproval);
}

export function resolveApproval(params: {
  id: string;
  status: "approved" | "denied";
  addedToAllowlist: boolean;
  resolvedAt: string;
}): void {
  stmts?.updateApprovalStatus.run({
    id: params.id,
    status: params.status,
    addedToAllowlist: params.addedToAllowlist ? 1 : 0,
    resolvedAt: params.resolvedAt,
  });
}
