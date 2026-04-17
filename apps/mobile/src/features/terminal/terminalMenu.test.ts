import { describe, expect, it } from "vitest";

import type { KnownTerminalSession } from "@t3tools/client-runtime";
import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { buildTerminalMenuSessions, resolveProjectScriptTerminalId } from "./terminalMenu";

function makeKnownSession(input: {
  readonly terminalId: string;
  readonly status: KnownTerminalSession["state"]["status"];
  readonly cwd?: string | null;
  readonly updatedAt?: string | null;
}): KnownTerminalSession {
  return {
    target: {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: input.terminalId,
    },
    state: {
      summary: input.cwd
        ? {
            threadId: "thread-1",
            terminalId: input.terminalId,
            cwd: input.cwd,
            worktreePath: input.cwd,
            status: input.status === "closed" ? "error" : input.status,
            pid: input.status === "running" ? 123 : null,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            updatedAt: input.updatedAt ?? "2026-04-15T20:00:00.000Z",
          }
        : null,
      buffer: "",
      status: input.status,
      error: null,
      hasRunningSubprocess: false,
      updatedAt: input.updatedAt ?? "2026-04-15T20:00:00.000Z",
      version: 1,
    },
  };
}

describe("buildTerminalMenuSessions", () => {
  it("keeps the default shell and only includes running sessions by default", () => {
    expect(
      buildTerminalMenuSessions({
        knownSessions: [
          makeKnownSession({
            terminalId: "term-3",
            status: "running",
            cwd: "/workspace/feature",
            updatedAt: "2026-04-15T20:05:00.000Z",
          }),
          makeKnownSession({
            terminalId: "term-2",
            status: "exited",
            cwd: "/workspace/exited",
            updatedAt: "2026-04-15T20:06:00.000Z",
          }),
        ],
        workspaceRoot: "/workspace/root",
      }),
    ).toEqual([
      {
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/workspace/root",
        status: "closed",
        hasRunningSubprocess: false,
        updatedAt: null,
      },
      {
        terminalId: "term-3",
        cwd: "/workspace/feature",
        status: "running",
        hasRunningSubprocess: false,
        updatedAt: "2026-04-15T20:05:00.000Z",
      },
    ]);
  });

  it("keeps the current terminal visible even if it is no longer running", () => {
    expect(
      buildTerminalMenuSessions({
        knownSessions: [],
        workspaceRoot: "/workspace/root",
        currentSession: {
          terminalId: "term-4",
          cwd: "/workspace/exited",
          status: "exited",
          hasRunningSubprocess: false,
          updatedAt: "2026-04-15T20:07:00.000Z",
        },
      }),
    ).toEqual([
      {
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/workspace/root",
        status: "closed",
        hasRunningSubprocess: false,
        updatedAt: null,
      },
      {
        terminalId: "term-4",
        cwd: "/workspace/exited",
        status: "exited",
        hasRunningSubprocess: false,
        updatedAt: "2026-04-15T20:07:00.000Z",
      },
    ]);
  });
});

describe("resolveProjectScriptTerminalId", () => {
  it("reuses the default shell when no terminal is running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID],
        hasRunningTerminal: false,
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
  });

  it("opens a new terminal when a shell is already running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID, "term-2", "term-4"],
        hasRunningTerminal: true,
      }),
    ).toBe("term-3");
  });
});
