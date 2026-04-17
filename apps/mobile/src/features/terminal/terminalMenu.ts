import type { KnownTerminalSession } from "@t3tools/client-runtime";
import { DEFAULT_TERMINAL_ID, type ProjectScript } from "@t3tools/contracts";

export interface TerminalMenuSession {
  readonly terminalId: string;
  readonly cwd: string | null;
  readonly status: "starting" | "running" | "exited" | "error" | "closed";
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
}

export function basename(input: string | null): string | null {
  if (!input) {
    return null;
  }

  const normalized = input.replace(/\/+$/, "");
  if (normalized.length === 0) {
    return "/";
  }

  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

export function getTerminalLabel(terminalId: string): string {
  if (terminalId === DEFAULT_TERMINAL_ID) {
    return "Main shell";
  }

  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

export function getTerminalStatusLabel(input: {
  readonly status: TerminalMenuSession["status"];
  readonly hasRunningSubprocess?: boolean;
}): string {
  if (input.status === "running") {
    return input.hasRunningSubprocess ? "Task running" : "Ready";
  }
  if (input.status === "starting") {
    return "Starting";
  }
  if (input.status === "exited") {
    return "Exited";
  }
  if (input.status === "error") {
    return "Error";
  }

  return "Not started";
}

export function nextTerminalId(existingTerminalIds: ReadonlyArray<string>): string {
  const usedIds = new Set(existingTerminalIds);
  let nextIndex = 2;
  while (usedIds.has(`term-${nextIndex}`)) {
    nextIndex += 1;
  }

  return `term-${nextIndex}`;
}

export function buildTerminalMenuSessions(input: {
  readonly knownSessions: ReadonlyArray<KnownTerminalSession>;
  readonly workspaceRoot: string | null;
  readonly currentSession?: TerminalMenuSession | null;
}): ReadonlyArray<TerminalMenuSession> {
  const sessionsById = new Map<string, TerminalMenuSession>();

  sessionsById.set(DEFAULT_TERMINAL_ID, {
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: input.workspaceRoot,
    status: "closed",
    hasRunningSubprocess: false,
    updatedAt: null,
  });

  for (const session of input.knownSessions) {
    if (
      session.state.status !== "running" &&
      session.state.status !== "starting" &&
      session.target.terminalId !== input.currentSession?.terminalId
    ) {
      continue;
    }

    sessionsById.set(session.target.terminalId, {
      terminalId: session.target.terminalId,
      cwd: session.state.summary?.cwd ?? input.workspaceRoot,
      status: session.state.status,
      hasRunningSubprocess: session.state.hasRunningSubprocess,
      updatedAt: session.state.updatedAt,
    });
  }

  if (input.currentSession && !sessionsById.has(input.currentSession.terminalId)) {
    sessionsById.set(input.currentSession.terminalId, input.currentSession);
  }

  return Array.from(sessionsById.values()).sort((left, right) => {
    if (left.terminalId === DEFAULT_TERMINAL_ID) return -1;
    if (right.terminalId === DEFAULT_TERMINAL_ID) return 1;

    const leftUpdatedAt = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightUpdatedAt = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    return left.terminalId.localeCompare(right.terminalId);
  });
}

export function resolveProjectScriptTerminalId(input: {
  readonly existingTerminalIds: ReadonlyArray<string>;
  readonly hasRunningTerminal: boolean;
}): string {
  if (!input.hasRunningTerminal) {
    return DEFAULT_TERMINAL_ID;
  }

  return nextTerminalId(input.existingTerminalIds);
}

export function projectScriptMenuLabel(script: ProjectScript): string {
  return script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name;
}

export function projectScriptMenuIcon(icon: ProjectScript["icon"]) {
  if (icon === "test") return "flask";
  if (icon === "lint") return "checklist";
  if (icon === "configure") return "wrench.and.screwdriver";
  if (icon === "build") return "hammer";
  if (icon === "debug") return "ladybug";
  return "play";
}
