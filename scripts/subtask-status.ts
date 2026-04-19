#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { parseArgs } from "node:util";

const argv = parseArgs({
  options: {
    "run-id": { type: "string" },
    origin: { type: "string" },
    token: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  subtask-status [--run-id <id>] [--origin <url>] [--token <bearer>]",
      "",
      "Run ID resolution (priority order):",
      "  1. --run-id flag",
      "  2. CRUCIBLE_RUN_ID env var",
      "  3. .crucible-run-id file in cwd",
      "",
      "Origin resolution:",
      "  1. --origin flag",
      "  2. T3CODE_SERVER_ORIGIN env var",
      "  3. server-runtime.json files",
      "",
      "Exit codes:",
      "  0 — all children completed",
      "  1 — any child errored",
      "  2 — still running (some children not done)",
      "  3 — run not found or API error",
    ].join("\n"),
  );
}

async function readJsonIfExists(filePath: string): Promise<{ readonly origin?: string } | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { readonly origin?: unknown };
    if (typeof parsed.origin === "string" && parsed.origin.trim().length > 0) {
      return { origin: parsed.origin.trim() };
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolveRunId(): Promise<string> {
  const fromFlag = argv.values["run-id"]?.trim();
  if (fromFlag && fromFlag.length > 0) return fromFlag;

  const fromEnv = process.env.CRUCIBLE_RUN_ID?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  try {
    const raw = await readFile(Path.join(process.cwd(), ".crucible-run-id"), "utf8");
    const runId = raw.trim();
    if (runId.length > 0) return runId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }
  }

  throw new Error(
    "Unable to resolve run ID. Pass --run-id, set CRUCIBLE_RUN_ID, or ensure .crucible-run-id exists in cwd.",
  );
}

async function resolveOrigin(): Promise<string> {
  const explicitOrigin = argv.values.origin?.trim() || process.env.T3CODE_SERVER_ORIGIN?.trim();
  if (explicitOrigin) return explicitOrigin;

  const baseDir = process.env.T3CODE_HOME?.trim();
  const candidates = [...(baseDir ? [baseDir] : []), Path.join(OS.homedir(), ".t3")];

  for (const root of candidates) {
    for (const candidate of [
      Path.join(root, "dev", "server-runtime.json"),
      Path.join(root, "userdata", "server-runtime.json"),
    ]) {
      const state = await readJsonIfExists(candidate);
      if (state?.origin) return state.origin;
    }
  }

  throw new Error(
    "Unable to resolve the Crucible server origin. Pass --origin or set T3CODE_SERVER_ORIGIN/T3CODE_HOME.",
  );
}

interface RunPayload {
  readonly id: string;
  readonly status: string;
  readonly childRunIds: string[];
  readonly prUrl?: string | null;
  readonly error?: string | null;
}

async function fetchRun(origin: string, runId: string, token?: string): Promise<RunPayload> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${origin}/api/crucible/runs/${encodeURIComponent(runId)}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.trim().length > 0 ? text : `Request failed with ${res.status}`);
  }
  return (await res.json()) as RunPayload;
}

async function main(): Promise<void> {
  if (argv.values.help) {
    printUsage();
    return;
  }

  const runId = await resolveRunId();
  const origin = await resolveOrigin();
  const token = argv.values.token?.trim() || process.env.T3CODE_BEARER_TOKEN?.trim() || undefined;

  const parentRun = await fetchRun(origin, runId, token);

  const children: { id: string; status: string; prUrl?: string | null }[] = [];
  for (const childId of parentRun.childRunIds) {
    try {
      const child = await fetchRun(origin, childId, token);
      children.push({
        id: child.id,
        status: child.status,
        ...(child.prUrl ? { prUrl: child.prUrl } : {}),
      });
    } catch {
      children.push({ id: childId, status: "unknown" });
    }
  }

  const output = {
    id: parentRun.id,
    status: parentRun.status,
    childRunIds: parentRun.childRunIds,
    children,
  };

  console.log(JSON.stringify(output, null, 2));

  // Determine exit code
  const hasError = children.some((c) => c.status === "error" || c.status === "unknown");
  if (hasError) {
    process.exitCode = 1;
    return;
  }

  const allDone = children.length > 0 && children.every((c) => c.status === "completed");
  if (allDone) {
    process.exitCode = 0;
    return;
  }

  // Still running or no children yet
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 3;
});
