import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpenCodeSettings } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import {
  buildOpenCodePermissionRules,
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  type OpenCodeServerConnection,
} from "../provider/opencodeRuntime.ts";

const MAX_STORED_EVENTS = 200;
const MAX_FILE_PREVIEW_CHARS = 2_000;
const REPO_ROOT = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SPAWN_SUBTASK_SCRIPT_PATH = Path.join(REPO_ROOT, "scripts", "spawn-subtask.ts");

type CrucibleRunType = "manager" | "task";
type CrucibleRunStatus = "starting" | "running" | "completed" | "error";

const CrucibleRunStartInput = Schema.Struct({
  directory: Schema.String,
  title: Schema.optionalKey(Schema.String),
  prompt: Schema.String,
  expectedFilePath: Schema.optionalKey(Schema.String),
  expectedText: Schema.optionalKey(Schema.String),
  plannerMode: Schema.optionalKey(Schema.Boolean),
  parentRunId: Schema.optionalKey(Schema.String),
  spawnCommand: Schema.optionalKey(Schema.String),
  spawnTool: Schema.optionalKey(Schema.String),
  spawnNote: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Literals(["manager", "task"])),
  repo: Schema.optionalKey(Schema.String),
  issueNumber: Schema.optionalKey(Schema.Number),
});

type CrucibleRunStartInput = typeof CrucibleRunStartInput.Type;

interface CrucibleRunEvent {
  readonly id: string;
  readonly at: string;
  readonly type: string;
  readonly summary: string;
  readonly payload: unknown;
}

interface CrucibleRunRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly directory: string;
  readonly title: string;
  readonly prompt: string;
  readonly type: CrucibleRunType;
  readonly repo: string;
  readonly expectedFilePath?: string;
  readonly expectedText?: string;
  readonly parentRunId?: string;
  readonly childRunIds: string[];
  readonly spawnCommand?: string;
  readonly spawnTool?: string;
  readonly spawnNote?: string;
  readonly issueNumber?: number;
  readonly abortController: AbortController;
  readonly events: CrucibleRunEvent[];
  status: CrucibleRunStatus;
  updatedAt: string;
  sessionId?: string;
  serverUrl?: string;
  error?: string;
  client?: OpencodeClient;
  server?: OpenCodeServerConnection;
}

interface CrucibleStore {
  readonly runs: Map<string, CrucibleRunRecord>;
}

const globalCrucibleStore = globalThis as typeof globalThis & {
  __t3CrucibleStore?: CrucibleStore;
};

const crucibleStore: CrucibleStore = globalCrucibleStore.__t3CrucibleStore ?? {
  runs: new Map<string, CrucibleRunRecord>(),
};

if (!globalCrucibleStore.__t3CrucibleStore) {
  globalCrucibleStore.__t3CrucibleStore = crucibleStore;
}

class CrucibleHttpError extends Data.TaggedError("CrucibleHttpError")<{
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

const requireCrucibleAccess = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverConfig = yield* ServerConfig;
  const serverAuth = yield* ServerAuth;
  const hasAuthCredential =
    typeof request.headers.authorization === "string" ||
    Object.keys(request.cookies ?? {}).length > 0;

  if (!hasAuthCredential) {
    const loopbackHost = serverConfig.host;
    if (
      loopbackHost === undefined ||
      loopbackHost === "localhost" ||
      loopbackHost === "127.0.0.1" ||
      loopbackHost === "::1" ||
      loopbackHost === "[::1]" ||
      loopbackHost.startsWith("127.")
    ) {
      return;
    }
  }

  yield* serverAuth.authenticateHttpRequest(request);
});

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pushRunEvent(run: CrucibleRunRecord, event: Omit<CrucibleRunEvent, "id" | "at">): void {
  run.events.push({
    id: randomUUID(),
    at: nowIso(),
    ...event,
  });
  if (run.events.length > MAX_STORED_EVENTS) {
    run.events.splice(0, run.events.length - MAX_STORED_EVENTS);
  }
  run.updatedAt = nowIso();
}

function setRunStatus(run: CrucibleRunRecord, status: CrucibleRunStatus, error?: string): void {
  run.status = status;
  run.updatedAt = nowIso();
  if (error !== undefined) {
    run.error = error;
    return;
  }
  delete run.error;
}

function summarizeEvent(event: unknown): { readonly type: string; readonly summary: string } {
  if (!event || typeof event !== "object" || !("type" in event)) {
    return {
      type: "unknown",
      summary: "Unknown OpenCode event",
    };
  }

  const typedEvent = event as {
    readonly type: string;
    readonly properties?: Record<string, unknown>;
  };

  switch (typedEvent.type) {
    case "session.status": {
      const statusType =
        typeof typedEvent.properties?.status === "object" &&
        typedEvent.properties?.status &&
        "type" in typedEvent.properties.status
          ? String(typedEvent.properties.status.type)
          : "unknown";
      return {
        type: typedEvent.type,
        summary: `Session status changed to ${statusType}`,
      };
    }
    case "message.part.updated": {
      const part =
        typeof typedEvent.properties?.part === "object" && typedEvent.properties.part
          ? (typedEvent.properties.part as Record<string, unknown>)
          : null;
      if (!part) {
        return {
          type: typedEvent.type,
          summary: "Message part updated",
        };
      }

      if (part.type === "tool") {
        const toolName = typeof part.tool === "string" ? part.tool : "tool";
        const toolStatus =
          typeof part.state === "object" &&
          part.state &&
          "status" in part.state &&
          typeof part.state.status === "string"
            ? part.state.status
            : "updated";
        return {
          type: typedEvent.type,
          summary: `${toolName} ${toolStatus}`,
        };
      }

      if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        const preview = part.text.replace(/\s+/g, " ").trim().slice(0, 120);
        return {
          type: typedEvent.type,
          summary: preview.length > 0 ? preview : `${String(part.type)} updated`,
        };
      }

      return {
        type: typedEvent.type,
        summary: `Message part ${String(part.type ?? "updated")}`,
      };
    }
    case "message.part.delta": {
      const delta =
        typeof typedEvent.properties?.delta === "string"
          ? typedEvent.properties.delta.replace(/\s+/g, " ").trim()
          : "";
      return {
        type: typedEvent.type,
        summary: delta.length > 0 ? delta.slice(0, 120) : "Message delta received",
      };
    }
    case "permission.asked":
      return {
        type: typedEvent.type,
        summary: `Permission requested: ${String(typedEvent.properties?.permission ?? "unknown")}`,
      };
    case "session.error":
      return {
        type: typedEvent.type,
        summary: "Session reported an error",
      };
    default:
      return {
        type: typedEvent.type,
        summary: typedEvent.type,
      };
  }
}

function addChildRun(parent: CrucibleRunRecord, child: CrucibleRunRecord): void {
  if (!parent.childRunIds.includes(child.id)) {
    parent.childRunIds.push(child.id);
  }
  parent.updatedAt = nowIso();
  pushRunEvent(parent, {
    type: "run.child.created",
    summary: `Spawned child run ${child.id}`,
    payload: {
      childRunId: child.id,
      childTitle: child.title,
      childSessionId: child.sessionId ?? null,
      parentRunId: parent.id,
      spawnCommand: child.spawnCommand ?? null,
      spawnTool: child.spawnTool ?? null,
      spawnNote: child.spawnNote ?? null,
    },
  });
}

async function readFileCheck(run: CrucibleRunRecord) {
  const expectedFilePath = normalizeOptionalString(run.expectedFilePath);
  if (!expectedFilePath) {
    return null;
  }

  const absolutePath = Path.isAbsolute(expectedFilePath)
    ? expectedFilePath
    : Path.resolve(run.directory, expectedFilePath);

  try {
    const content = await FS.readFile(absolutePath, "utf8");
    const expectedText = normalizeOptionalString(run.expectedText);
    return {
      path: expectedFilePath,
      absolutePath,
      exists: true,
      containsExpectedText: expectedText ? content.includes(expectedText) : null,
      preview: content.slice(0, MAX_FILE_PREVIEW_CHARS),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        path: expectedFilePath,
        absolutePath,
        exists: false,
        containsExpectedText: null,
        preview: "",
      };
    }
    throw error;
  }
}

async function serializeRun(run: CrucibleRunRecord) {
  return {
    id: run.id,
    type: run.type,
    repo: run.repo,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    directory: run.directory,
    title: run.title,
    prompt: run.prompt,
    sessionId: run.sessionId ?? null,
    serverUrl: run.serverUrl ?? null,
    error: run.error ?? null,
    expectedFilePath: run.expectedFilePath ?? null,
    expectedText: run.expectedText ?? null,
    parentRunId: run.parentRunId ?? null,
    childRunIds: [...run.childRunIds],
    issueNumber: run.issueNumber ?? null,
    spawnCommand: run.spawnCommand ?? null,
    spawnTool: run.spawnTool ?? null,
    spawnNote: run.spawnNote ?? null,
    events: run.events,
    fileCheck: await readFileCheck(run),
  };
}

async function serializeRunList(repoFilter?: string) {
  let runs = [...crucibleStore.runs.values()].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  if (repoFilter) {
    runs = runs.filter((run) => run.repo === repoFilter);
  }
  return Promise.all(runs.map((run) => serializeRun(run)));
}

async function watchRunEventStream(
  run: CrucibleRunRecord,
  subscription: Awaited<ReturnType<NonNullable<CrucibleRunRecord["client"]>["event"]["subscribe"]>>,
) {
  try {
    for await (const event of subscription.stream) {
      const payloadSessionId =
        "properties" in event &&
        event.properties &&
        typeof event.properties === "object" &&
        "sessionID" in event.properties
          ? event.properties.sessionID
          : undefined;
      if (payloadSessionId !== run.sessionId) {
        continue;
      }

      const summary = summarizeEvent(event);
      pushRunEvent(run, {
        type: summary.type,
        summary: summary.summary,
        payload: event,
      });

      if (event.type === "session.status") {
        const statusType =
          typeof event.properties.status === "object" &&
          event.properties.status &&
          "type" in event.properties.status
            ? String(event.properties.status.type)
            : "unknown";
        if (statusType === "busy") {
          setRunStatus(run, "running");
        } else if (statusType === "idle" && run.status !== "error") {
          setRunStatus(run, "completed");
        }
      }

      if (event.type === "session.error") {
        setRunStatus(run, "error", "OpenCode reported a session error.");
      }
    }
  } catch (error) {
    if (run.abortController.signal.aborted) {
      return;
    }

    pushRunEvent(run, {
      type: "watch.error",
      summary: error instanceof Error ? error.message : "Event subscription failed.",
      payload: error,
    });
    setRunStatus(
      run,
      "error",
      error instanceof Error ? error.message : "Event subscription failed.",
    );
  }
}

async function startRun(
  input: CrucibleRunStartInput,
  opencodeSettings: OpenCodeSettings,
): Promise<CrucibleRunRecord> {
  if (!opencodeSettings.enabled) {
    throw new CrucibleHttpError({
      message: "OpenCode is disabled in server settings.",
      status: 400,
    });
  }

  const directory = input.directory.trim();
  if (directory.length === 0) {
    throw new CrucibleHttpError({
      message: "Directory is required.",
      status: 400,
    });
  }

  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new CrucibleHttpError({
      message: "Prompt is required.",
      status: 400,
    });
  }

  await FS.mkdir(directory, { recursive: true });
  const expectedFilePath = normalizeOptionalString(input.expectedFilePath);
  const expectedText = normalizeOptionalString(input.expectedText);
  const plannerMode = input.plannerMode === true;
  const parentRunId = normalizeOptionalString(input.parentRunId);
  const spawnCommand = normalizeOptionalString(input.spawnCommand);
  const spawnTool = normalizeOptionalString(input.spawnTool);
  const spawnNote = normalizeOptionalString(input.spawnNote);
  const repo = normalizeOptionalString(input.repo) ?? "";
  const issueNumber = input.issueNumber;
  const runType: CrucibleRunType = input.type ?? (plannerMode ? "manager" : "task");

  const run: CrucibleRunRecord = {
    id: randomUUID(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    title: normalizeOptionalString(input.title) ?? "Crucible Run",
    directory,
    prompt,
    status: "starting",
    type: runType,
    repo,
    abortController: new AbortController(),
    events: [],
    childRunIds: [],
    ...(parentRunId !== undefined ? { parentRunId } : {}),
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(expectedFilePath !== undefined ? { expectedFilePath } : {}),
    ...(expectedText !== undefined ? { expectedText } : {}),
    ...(spawnCommand !== undefined ? { spawnCommand } : {}),
    ...(spawnTool !== undefined ? { spawnTool } : {}),
    ...(spawnNote !== undefined ? { spawnNote } : {}),
  };

  const plannerPrompt = plannerMode
    ? [
        "Planner mode is enabled.",
        "You can delegate work by running this command from bash:",
        `${shellQuote("bun")} ${shellQuote(SPAWN_SUBTASK_SCRIPT_PATH)} --parent-run-id ${shellQuote(run.id)} "<prompt>"`,
        "That command creates a child Crucible run in a fresh directory and prints JSON.",
        "Use it when delegation helps. Keep child prompts small and explicit.",
        "If you need a fixed child directory, add --directory <path>.",
        "",
        input.prompt.trim(),
      ].join("\n")
    : prompt;

  if (parentRunId) {
    const parentRun = crucibleStore.runs.get(parentRunId);
    if (!parentRun) {
      throw new CrucibleHttpError({
        message: `Parent run '${parentRunId}' was not found.`,
        status: 404,
      });
    }
    if (parentRun.id === run.id) {
      throw new CrucibleHttpError({
        message: "A run cannot be its own parent.",
        status: 400,
      });
    }
  }

  crucibleStore.runs.set(run.id, run);
  await FS.writeFile(Path.join(directory, ".crucible-run-id"), `${run.id}\n`, "utf8");
  pushRunEvent(run, {
    type: "run.created",
    summary: `Preparing run in ${directory}`,
    payload: {
      directory,
      title: run.title,
      type: run.type,
      repo: run.repo,
      issueNumber: run.issueNumber ?? null,
      plannerMode,
      parentRunId: run.parentRunId ?? null,
      spawnCommand: run.spawnCommand ?? null,
      spawnTool: run.spawnTool ?? null,
      spawnNote: run.spawnNote ?? null,
    },
  });

  if (parentRunId) {
    const parentRun = crucibleStore.runs.get(parentRunId);
    if (parentRun) {
      addChildRun(parentRun, run);
    }
  }

  try {
    const server = await connectToOpenCodeServer({
      binaryPath: opencodeSettings.binaryPath,
      serverUrl: opencodeSettings.serverUrl,
    });
    const client = createOpenCodeSdkClient({
      baseUrl: server.url,
      directory,
      ...(server.external && opencodeSettings.serverPassword
        ? { serverPassword: opencodeSettings.serverPassword }
        : {}),
    });

    run.client = client;
    run.server = server;
    run.serverUrl = server.url;

    const session = await client.session.create({
      title: run.title,
      permission: buildOpenCodePermissionRules("full-access"),
    });

    if (!session.data) {
      throw new Error("OpenCode session.create returned no session payload.");
    }

    run.sessionId = session.data.id;
    setRunStatus(run, "running");
    pushRunEvent(run, {
      type: "session.created",
      summary: `Created OpenCode session ${session.data.id}`,
      payload: session.data,
    });

    const subscription = await client.event.subscribe(undefined, {
      signal: run.abortController.signal,
    });
    pushRunEvent(run, {
      type: "watch.ready",
      summary: "Attached event stream before prompt dispatch",
      payload: {
        sessionId: session.data.id,
      },
    });
    void watchRunEventStream(run, subscription);

    await client.session.promptAsync({
      sessionID: session.data.id,
      parts: [{ type: "text", text: plannerPrompt }],
    });

    pushRunEvent(run, {
      type: "prompt.sent",
      summary: "Prompt sent to OpenCode",
      payload: {
        prompt: plannerPrompt,
      },
    });

    return run;
  } catch (error) {
    run.abortController.abort();
    run.server?.close();
    setRunStatus(run, "error", error instanceof Error ? error.message : "Failed to start run.");
    pushRunEvent(run, {
      type: "run.error",
      summary: run.error ?? "Failed to start run.",
      payload: error,
    });
    throw error;
  }
}

async function getRunOrThrow(runId: string): Promise<CrucibleRunRecord> {
  const run = crucibleStore.runs.get(runId);
  if (!run) {
    throw new CrucibleHttpError({
      message: "Run not found.",
      status: 404,
    });
  }
  return run;
}

const handleCrucibleHttpError = (error: CrucibleHttpError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("crucible route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      { status: error.status },
    );
  });

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

function parseOwnerNameFromRemote(remoteUrl: string): string | null {
  // https://github.com/owner/name.git  or  https://github.com/owner/name
  // name can contain dots (e.g. manikrana.dev)
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }
  // git@github.com:owner/name.git
  const sshMatch = remoteUrl.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  return null;
}

function gitRemoteOrigin(dir: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

function contentTypeForPath(filePath: string): string {
  const ext = Path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".json":
      return "application/json";
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "application/javascript";
    default:
      return "text/plain";
  }
}

// ---------------------------------------------------------------------------
// Route layers
// ---------------------------------------------------------------------------

export const crucibleConfigRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/config",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    return HttpServerResponse.jsonUnsafe(
      {
        suggestedDirectory: Path.join(OS.tmpdir(), "t3code-crucible-smoke"),
        workspaceDirectory: REPO_ROOT,
        spawnSubtaskCommand: `bun ${SPAWN_SUBTASK_SCRIPT_PATH}`,
        opencode: {
          enabled: settings.providers.opencode.enabled,
          binaryPath: settings.providers.opencode.binaryPath,
          hasExternalServer: settings.providers.opencode.serverUrl.trim().length > 0,
        },
      },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const crucibleRunCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/crucible/runs",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const payload = yield* HttpServerRequest.schemaBodyJson(CrucibleRunStartInput).pipe(
      Effect.mapError(
        (cause) =>
          new CrucibleHttpError({
            message: "Invalid Crucible run payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;
    const run = yield* Effect.tryPromise({
      try: () => startRun(payload, settings.providers.opencode),
      catch: (cause) =>
        cause instanceof CrucibleHttpError
          ? cause
          : new CrucibleHttpError({
              message: cause instanceof Error ? cause.message : "Failed to start Crucible run.",
              status: 500,
              cause,
            }),
    });
    const response = yield* Effect.tryPromise({
      try: () => serializeRun(run),
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to serialize Crucible run.",
          status: 500,
          cause,
        }),
    });
    return HttpServerResponse.jsonUnsafe(response, { status: 202 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

export const crucibleRunListRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/runs",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const repoFilter = Option.isSome(url)
      ? (url.value.searchParams.get("repo") ?? undefined)
      : undefined;
    const response = yield* Effect.tryPromise({
      try: () => serializeRunList(repoFilter),
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to serialize Crucible runs.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe(response, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

export const crucibleRunGetRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/runs/:runId",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    const runId = decodeURIComponent(url.value.pathname.split("/").at(-1) ?? "");
    if (!runId) {
      return yield* new CrucibleHttpError({
        message: "Run id is required.",
        status: 400,
      });
    }

    const run = yield* Effect.tryPromise({
      try: () => getRunOrThrow(runId),
      catch: (cause) =>
        cause instanceof CrucibleHttpError
          ? cause
          : new CrucibleHttpError({
              message: "Failed to load Crucible run.",
              status: 500,
              cause,
            }),
    });

    const response = yield* Effect.tryPromise({
      try: () => serializeRun(run),
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to serialize Crucible run.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe(response, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/repos — list git repos in workspace dir
// ---------------------------------------------------------------------------

export const crucibleReposListRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/repos",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const serverConfig = yield* ServerConfig;
    const workspaceDir = serverConfig.cwd;

    const repos = yield* Effect.tryPromise({
      try: async () => {
        const entries = await FS.readdir(workspaceDir, { withFileTypes: true });
        const results: { name: string; path: string; hasGit: boolean }[] = [];

        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const dirPath = Path.join(workspaceDir, entry.name);

          let hasGit = false;
          try {
            const stat = await FS.stat(Path.join(dirPath, ".git"));
            hasGit = stat.isDirectory();
          } catch {
            // not a git repo
          }

          if (!hasGit) continue;

          const remoteUrl = gitRemoteOrigin(dirPath);
          const ownerName = remoteUrl ? parseOwnerNameFromRemote(remoteUrl) : null;

          results.push({
            name: ownerName ?? entry.name,
            path: dirPath,
            hasGit,
          });
        }

        return results;
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message: "Failed to list repos.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe({ repos }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// POST /api/crucible/repos/clone — clone a repo by URL
// ---------------------------------------------------------------------------

const CrucibleCloneInput = Schema.Struct({
  url: Schema.String,
});

export const crucibleReposCloneRouteLayer = HttpRouter.add(
  "POST",
  "/api/crucible/repos/clone",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const payload = yield* HttpServerRequest.schemaBodyJson(CrucibleCloneInput).pipe(
      Effect.mapError(
        (cause) =>
          new CrucibleHttpError({
            message: "Invalid clone payload. Provide { url: string }.",
            status: 400,
            cause,
          }),
      ),
    );

    const serverConfig = yield* ServerConfig;
    const workspaceDir = serverConfig.cwd;
    const repoUrl = payload.url.trim();

    if (repoUrl.length === 0) {
      return yield* new CrucibleHttpError({
        message: "url is required.",
        status: 400,
      });
    }

    const ownerName = parseOwnerNameFromRemote(repoUrl);
    const repoBaseName = ownerName?.split("/")[1] ?? Path.basename(repoUrl, ".git");
    const targetPath = Path.join(workspaceDir, repoBaseName);

    const repo = yield* Effect.tryPromise({
      try: async () => {
        // Check if already exists and is a git repo
        try {
          const stat = await FS.stat(Path.join(targetPath, ".git"));
          if (stat.isDirectory()) {
            return {
              name: ownerName ?? repoBaseName,
              path: targetPath,
              hasGit: true,
            };
          }
        } catch {
          // does not exist yet, proceed to clone
        }

        execSync(`git clone ${shellQuote(repoUrl)} ${shellQuote(targetPath)}`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });

        return {
          name: ownerName ?? repoBaseName,
          path: targetPath,
          hasGit: true,
        };
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message: cause instanceof Error ? `Clone failed: ${cause.message}` : "Clone failed.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe(repo, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/repos/:owner/:name/issues — fetch GitHub issues via gh CLI
// ---------------------------------------------------------------------------

export const crucibleRepoIssuesRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/repos/:owner/:name/issues",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    // Extract owner/name from the path: /api/crucible/repos/:owner/:name/issues
    const segments = url.value.pathname.split("/").filter(Boolean);
    // segments: ["api", "crucible", "repos", owner, name, "issues"]
    const owner = segments[3];
    const name = segments[4];
    if (!owner || !name) {
      return yield* new CrucibleHttpError({
        message: "owner and name are required path parameters.",
        status: 400,
      });
    }

    const repoSlug = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;

    const issues = yield* Effect.tryPromise({
      try: async () => {
        const output = execSync(
          `gh issue list --repo ${shellQuote(repoSlug)} --json number,title,body,labels,assignees,state,url --limit 50`,
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          },
        );
        return JSON.parse(output) as unknown[];
      },
      catch: (cause) =>
        new CrucibleHttpError({
          message:
            cause instanceof Error
              ? `Failed to list issues: ${cause.message}`
              : "Failed to list issues.",
          status: 500,
          cause,
        }),
    });

    return HttpServerResponse.jsonUnsafe({ issues }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);

// ---------------------------------------------------------------------------
// GET /api/crucible/files?path=<absolute> — serve files within workspace
// ---------------------------------------------------------------------------

export const crucibleFilesRouteLayer = HttpRouter.add(
  "GET",
  "/api/crucible/files",
  Effect.gen(function* () {
    yield* requireCrucibleAccess;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverConfig = yield* ServerConfig;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CrucibleHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }

    const filePath = url.value.searchParams.get("path");
    if (!filePath || filePath.trim().length === 0) {
      return yield* new CrucibleHttpError({
        message: "path query parameter is required.",
        status: 400,
      });
    }

    // Security: resolve both and check prefix
    const workspaceDir = Path.resolve(serverConfig.cwd);
    const resolvedPath = Path.resolve(filePath);
    if (!resolvedPath.startsWith(workspaceDir + Path.sep) && resolvedPath !== workspaceDir) {
      return yield* new CrucibleHttpError({
        message: "Path is outside the workspace directory.",
        status: 403,
      });
    }

    const fileContent = yield* Effect.tryPromise({
      try: () => FS.readFile(resolvedPath),
      catch: (cause) =>
        new CrucibleHttpError({
          message:
            (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
              ? "File not found."
              : "Failed to read file.",
          status: (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? 404 : 500,
          cause,
        }),
    });

    const ct = contentTypeForPath(resolvedPath);

    return HttpServerResponse.raw(fileContent, {
      status: 200,
      headers: {
        "content-type": ct,
        "cache-control": "no-store",
      },
    });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("CrucibleHttpError", handleCrucibleHttpError),
  ),
);
