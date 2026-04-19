import { createFileRoute } from "@tanstack/react-router";
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { SidebarInset } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";

interface OrwellConfigResponse {
  readonly suggestedDirectory: string;
  readonly workspaceDirectory: string;
  readonly spawnSubtaskCommand?: string;
  readonly opencode: {
    readonly enabled: boolean;
    readonly binaryPath: string;
    readonly hasExternalServer: boolean;
  };
}

interface OrwellEvent {
  readonly id: string;
  readonly at: string;
  readonly type: string;
  readonly summary: string;
  readonly payload: unknown;
}

interface OrwellFileCheck {
  readonly path: string;
  readonly absolutePath: string;
  readonly exists: boolean;
  readonly containsExpectedText: boolean | null;
  readonly preview: string;
}

interface OrwellRunResponse {
  readonly id: string;
  readonly status: "starting" | "running" | "completed" | "error";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly directory: string;
  readonly title: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly serverUrl: string | null;
  readonly error: string | null;
  readonly expectedFilePath: string | null;
  readonly expectedText: string | null;
  readonly events: ReadonlyArray<OrwellEvent>;
  readonly fileCheck: OrwellFileCheck | null;
  readonly parentRunId?: string | null;
  readonly childRunIds?: ReadonlyArray<string>;
}

interface OrwellApiError {
  readonly error?: string;
}

const DEFAULT_TITLE = "Orwell Stage 0";
const DEFAULT_PROMPT = "Create hello.txt containing exactly the word banana.";
const DEFAULT_EXPECTED_FILE = "hello.txt";
const DEFAULT_EXPECTED_TEXT = "banana";
const ORWELL_STORAGE_KEY = "crucible.orwell.runs";

export const Route = createFileRoute("/orwell")({
  component: OrwellRouteView,
  head: () => ({
    meta: [{ title: "Orwell | Crucible" }],
  }),
});

function OrwellRouteView() {
  const [config, setConfig] = useState<OrwellConfigResponse | null>(null);
  const [directory, setDirectory] = useState("");
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [expectedFilePath, setExpectedFilePath] = useState(DEFAULT_EXPECTED_FILE);
  const [expectedText, setExpectedText] = useState(DEFAULT_EXPECTED_TEXT);
  const [plannerMode, setPlannerMode] = useState(false);
  const [runsById, setRunsById] = useState<Record<string, OrwellRunResponse>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [eventPanelsOpenByRunId, setEventPanelsOpenByRunId] = useState<Record<string, boolean>>({});
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [hydratedFromStorage, setHydratedFromStorage] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ORWELL_STORAGE_KEY);
      if (!raw) {
        setHydratedFromStorage(true);
        return;
      }

      const parsed = JSON.parse(raw) as {
        readonly plannerMode?: unknown;
        readonly selectedRunId?: unknown;
        readonly runs?: unknown;
      };
      if (typeof parsed.plannerMode === "boolean") {
        setPlannerMode(parsed.plannerMode);
      }
      if (typeof parsed.selectedRunId === "string" && parsed.selectedRunId.trim().length > 0) {
        setSelectedRunId(parsed.selectedRunId);
      }
      if (Array.isArray(parsed.runs)) {
        const restoredRuns: Record<string, OrwellRunResponse> = {};
        for (const value of parsed.runs) {
          try {
            const run = normalizeRunLike(value);
            restoredRuns[run.id] = run;
          } catch {
            // Ignore malformed cached runs and keep going.
          }
        }
        setRunsById(restoredRuns);
      }
    } catch {
      // Ignore malformed local cache and start fresh.
    } finally {
      setHydratedFromStorage(true);
    }
  }, []);

  useEffect(() => {
    if (!hydratedFromStorage) {
      return;
    }

    try {
      window.localStorage.setItem(
        ORWELL_STORAGE_KEY,
        JSON.stringify({
          plannerMode,
          selectedRunId,
          runs: Object.values(runsById),
        }),
      );
    } catch {
      // Persistence is a convenience only.
    }
  }, [hydratedFromStorage, plannerMode, runsById, selectedRunId]);

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      setLoadingConfig(true);
      setRequestError(null);
      try {
        const response = await fetch("/api/orwell/config", {
          credentials: "same-origin",
        });
        const body = await parseApiBody<OrwellConfigResponse | OrwellApiError>(response);
        if (!response.ok) {
          throw new Error(bodyError(body, "Failed to load Orwell config."));
        }
        if (cancelled) {
          return;
        }
        setConfig(body as OrwellConfigResponse);
        setDirectory((current) =>
          current.trim().length > 0 ? current : (body as OrwellConfigResponse).suggestedDirectory,
        );
      } catch (error) {
        if (cancelled) {
          return;
        }
        setRequestError(errorMessage(error, "Failed to load Orwell config."));
      } finally {
        if (!cancelled) {
          setLoadingConfig(false);
        }
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadRuns = async () => {
      try {
        const response = await fetch("/api/orwell/runs", {
          credentials: "same-origin",
        });
        const body = await parseApiBody<ReadonlyArray<OrwellRunResponse> | OrwellApiError>(
          response,
        );
        if (!response.ok || !Array.isArray(body)) {
          return;
        }

        if (cancelled) {
          return;
        }

        for (const value of body) {
          try {
            upsertRun(setRunsById, normalizeRunLike(value));
          } catch {
            // Skip malformed runs and keep the rest visible.
          }
        }
      } catch {
        // Keep the existing run cache visible if the server is temporarily unavailable.
      }
    };

    void loadRuns();
    const intervalId = window.setInterval(() => {
      void loadRuns();
    }, 1_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const runList = useMemo(
    () =>
      Object.values(runsById).sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt) || Date.parse(left.createdAt) || 0;
        const rightTime = Date.parse(right.updatedAt) || Date.parse(right.createdAt) || 0;
        return rightTime - leftTime;
      }),
    [runsById],
  );

  const visibleRun = useMemo(() => {
    if (selectedRunId) {
      return runsById[selectedRunId] ?? runList[0] ?? null;
    }
    return runList[0] ?? null;
  }, [runList, runsById, selectedRunId]);

  useEffect(() => {
    if (selectedRunId || runList.length === 0) {
      return;
    }
    setSelectedRunId(runList[0]?.id ?? null);
  }, [runList, selectedRunId]);

  const runGraph = useMemo(() => buildRunGraph(runList), [runList]);
  const activeRootRunId = useMemo(
    () => findRootRunId(visibleRun?.id ?? null, runsById),
    [runsById, visibleRun?.id],
  );
  const linkedRunIds = useMemo(
    () =>
      collectLinkedRunIds({
        rootRunId: activeRootRunId,
        runsById,
        childrenByParentId: runGraph.childrenByParentId,
      }),
    [activeRootRunId, runGraph.childrenByParentId, runsById],
  );
  const linkedRuns = useMemo(
    () =>
      (linkedRunIds.length > 0
        ? linkedRunIds.map((runId) => runsById[runId]).filter(Boolean)
        : runList) as OrwellRunResponse[],
    [linkedRunIds, runList, runsById],
  );
  const currentStatusBadge = statusVariant(visibleRun?.status);
  const areEventPanelsExpanded = visibleRun
    ? (eventPanelsOpenByRunId[visibleRun.id] ?? false)
    : false;

  const handleRun = async () => {
    setSubmitting(true);
    setRequestError(null);

    try {
      const response = await fetch("/api/orwell/runs", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory,
          title,
          prompt: prompt.trim(),
          expectedFilePath,
          expectedText,
          plannerMode,
        }),
      });

      const body = await parseApiBody<OrwellRunResponse | OrwellApiError>(response);
      if (!response.ok) {
        throw new Error(bodyError(body, "Failed to start Orwell run."));
      }

      const nextRun = normalizeRunLike(body);
      upsertRun(setRunsById, nextRun);
      setSelectedRunId(nextRun.id);
    } catch (error) {
      setRequestError(errorMessage(error, "Failed to start Orwell run."));
    } finally {
      setSubmitting(false);
    }
  };

  const canRun = directory.trim().length > 0 && prompt.trim().length > 0 && !submitting;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="min-h-0 flex flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6">
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">/orwell</Badge>
              <Badge variant={currentStatusBadge.variant}>{currentStatusBadge.label}</Badge>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Stage 0 verification surface</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Start an OpenCode session, inject a prompt, and verify the result from one page.
              Planner mode turns this into a Stage 0b harness by instructing the model to delegate
              through <span className="font-mono">spawn-subtask</span>.
            </p>
          </header>

          {requestError ? (
            <Card className="border-destructive/30">
              <CardHeader>
                <CardTitle className="text-base">Request error</CardTitle>
                <CardDescription>{requestError}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Run controls</CardTitle>
                <CardDescription>
                  Configure the scratch directory, prompt, and expected output for the smoke test.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <Field label="Directory">
                  <Input
                    value={directory}
                    onChange={(event) => setDirectory(event.target.value)}
                    placeholder={
                      loadingConfig
                        ? "Loading suggested directory..."
                        : "/tmp/crucible-orwell-smoke"
                    }
                  />
                </Field>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Run title">
                    <Input value={title} onChange={(event) => setTitle(event.target.value)} />
                  </Field>

                  <Field label="Expected file">
                    <Input
                      value={expectedFilePath}
                      onChange={(event) => setExpectedFilePath(event.target.value)}
                      placeholder="hello.txt"
                    />
                  </Field>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-background/60 px-4 py-3">
                  <div className="grid gap-1">
                    <div className="text-sm font-medium">Planner mode</div>
                    <div className="text-xs text-muted-foreground">
                      The server augments your prompt with a delegation instruction that documents{" "}
                      <span className="font-mono">spawn-subtask</span>.
                    </div>
                  </div>
                  <Switch
                    checked={plannerMode}
                    onCheckedChange={(checked) => setPlannerMode(Boolean(checked))}
                    aria-label="Enable planner mode"
                  />
                </div>

                <Field label="Prompt">
                  <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder={DEFAULT_PROMPT}
                    className="min-h-32"
                  />
                </Field>

                <Field label="Expected text match">
                  <Input
                    value={expectedText}
                    onChange={(event) => setExpectedText(event.target.value)}
                    placeholder="banana"
                  />
                </Field>

                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => void handleRun()} disabled={!canRun}>
                    {submitting
                      ? "Starting..."
                      : plannerMode
                        ? "Run planner Stage 0"
                        : "Run Stage 0"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setTitle(DEFAULT_TITLE);
                      setPrompt(DEFAULT_PROMPT);
                      setExpectedFilePath(DEFAULT_EXPECTED_FILE);
                      setExpectedText(DEFAULT_EXPECTED_TEXT);
                      setPlannerMode(false);
                      if (config) {
                        setDirectory(config.suggestedDirectory);
                      }
                    }}
                  >
                    Reset defaults
                  </Button>
                  {config ? (
                    <Button
                      variant="outline"
                      onClick={() => setDirectory(config.workspaceDirectory)}
                    >
                      Use workspace root
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Environment</CardTitle>
                <CardDescription>
                  The server-side OpenCode configuration this page is running against.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <InfoBlock
                  label="Suggested scratch directory"
                  value={
                    config?.suggestedDirectory ?? (loadingConfig ? "Loading..." : "Unavailable")
                  }
                />
                <InfoBlock
                  label="Workspace directory"
                  value={
                    config?.workspaceDirectory ?? (loadingConfig ? "Loading..." : "Unavailable")
                  }
                />
                <InfoBlock
                  label="OpenCode binary"
                  value={
                    config?.opencode.binaryPath ?? (loadingConfig ? "Loading..." : "Unavailable")
                  }
                />
                <InfoBlock
                  label="OpenCode mode"
                  value={
                    !config
                      ? loadingConfig
                        ? "Loading..."
                        : "Unavailable"
                      : config.opencode.hasExternalServer
                        ? "External server"
                        : "Managed local server"
                  }
                />
                <InfoBlock
                  label="Spawn CLI"
                  value={
                    config?.spawnSubtaskCommand ?? (loadingConfig ? "Loading..." : "Unavailable")
                  }
                  mono
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>All runs</CardTitle>
              <CardDescription>
                Active OpenCode sessions linked to this run. Click any run to replace the lower
                state and event panels without losing cached logs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {linkedRuns.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {linkedRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => setSelectedRunId(run.id)}
                      className={[
                        "rounded-xl border px-4 py-3 text-left transition-colors",
                        selectedRunId === run.id
                          ? "border-primary/60 bg-primary/8"
                          : "border-border/70 bg-background/60 hover:bg-accent/40",
                      ].join(" ")}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={statusVariant(run.status).variant}>
                          {statusVariant(run.status).label}
                        </Badge>
                        <span className="text-sm font-medium">{shortRunId(run.id)}</span>
                        {run.parentRunId ? (
                          <Badge variant="outline">Child</Badge>
                        ) : (
                          <Badge variant="outline">Root</Badge>
                        )}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Session: {run.sessionId ?? "Pending"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {run.events.length} cached event{run.events.length === 1 ? "" : "s"}
                      </div>
                      <div className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                        {run.prompt || "No prompt captured yet."}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
                  No linked runs yet. Start a Stage 0 run to watch OpenCode create a session and do
                  work.
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Selected run state</CardTitle>
                <CardDescription>
                  Session metadata and the file-level verification we care about for Stage 0.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoBlock label="Run id" value={visibleRun?.id ?? "Not started"} mono />
                  <InfoBlock label="Session id" value={visibleRun?.sessionId ?? "Pending"} mono />
                  <InfoBlock label="Server URL" value={visibleRun?.serverUrl ?? "Pending"} mono />
                  <InfoBlock
                    label="Last updated"
                    value={visibleRun ? formatTimestamp(visibleRun.updatedAt) : "Not started"}
                  />
                </div>

                <div className="rounded-xl border border-border/70 bg-background/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">File check</span>
                    <Badge variant={fileCheckVariant(visibleRun?.fileCheck).variant}>
                      {fileCheckVariant(visibleRun?.fileCheck).label}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-3 text-sm">
                    <InfoRow
                      label="Expected path"
                      value={visibleRun?.fileCheck?.path ?? visibleRun?.expectedFilePath ?? "None"}
                    />
                    <InfoRow
                      label="Absolute path"
                      value={visibleRun?.fileCheck?.absolutePath ?? "Will resolve after run starts"}
                      mono
                    />
                    <InfoRow
                      label="Contains expected text"
                      value={containsExpectedTextLabel(visibleRun?.fileCheck)}
                    />
                    {visibleRun?.parentRunId ? (
                      <InfoRow label="Parent run" value={shortRunId(visibleRun.parentRunId)} mono />
                    ) : null}
                  </div>

                  {visibleRun?.childRunIds?.length ? (
                    <div className="mt-4">
                      <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Child runs
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {visibleRun.childRunIds.map((childRunId) => {
                          const childRun = runsById[childRunId];
                          return (
                            <Button
                              key={childRunId}
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedRunId(childRunId)}
                              className="h-auto min-h-8 px-3 py-2"
                            >
                              <span className="font-mono text-[11px]">
                                {shortRunId(childRunId)}
                              </span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                {childRun ? statusVariant(childRun.status).label : "Pending"}
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4">
                    <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      File preview
                    </div>
                    <pre className="max-h-72 overflow-auto rounded-lg border border-border/70 bg-background px-3 py-3 text-xs leading-relaxed whitespace-pre-wrap">
                      {filePreview(visibleRun?.fileCheck)}
                    </pre>
                  </div>
                </div>

                {visibleRun?.error ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive-foreground">
                    {visibleRun.error}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>Event stream</CardTitle>
                    <CardDescription>
                      Raw OpenCode activity as the run progresses. This is the main verification
                      surface for session creation, prompt injection, and tool execution.
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!visibleRun) {
                          return;
                        }
                        setEventPanelsOpenByRunId((current) => ({
                          ...current,
                          [visibleRun.id]: true,
                        }));
                      }}
                      disabled={!visibleRun?.events.length || areEventPanelsExpanded}
                    >
                      Expand all
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!visibleRun) {
                          return;
                        }
                        setEventPanelsOpenByRunId((current) => ({
                          ...current,
                          [visibleRun.id]: false,
                        }));
                      }}
                      disabled={!visibleRun?.events.length || !areEventPanelsExpanded}
                    >
                      Collapse all
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {visibleRun?.events.length ? (
                  visibleRun.events.toReversed().map((event) => (
                    <details
                      key={event.id}
                      open={areEventPanelsExpanded}
                      className="overflow-hidden rounded-xl border border-border/70 bg-background/70"
                    >
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">{event.type}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatTimestamp(event.at)}
                            </span>
                          </div>
                          <div className="mt-2 text-sm">{event.summary}</div>
                        </div>
                      </summary>
                      <pre className="max-h-96 overflow-auto border-t border-border/70 bg-background px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </details>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
                    No run events yet. Start a Stage 0 run to watch OpenCode create a session and do
                    work.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function buildRunGraph(runs: ReadonlyArray<OrwellRunResponse>) {
  const childrenByParentId = new Map<string, string[]>();

  const addChild = (parentId: string, childId: string) => {
    const existing = childrenByParentId.get(parentId) ?? [];
    if (!existing.includes(childId)) {
      childrenByParentId.set(parentId, [...existing, childId]);
    }
  };

  for (const run of runs) {
    if (run.parentRunId) {
      addChild(run.parentRunId, run.id);
    }

    for (const childId of run.childRunIds ?? []) {
      addChild(run.id, childId);
    }
  }

  return {
    childrenByParentId,
  };
}

function findRootRunId(
  runId: string | null,
  runsById: Record<string, OrwellRunResponse>,
): string | null {
  if (!runId) {
    return null;
  }

  const visited = new Set<string>();
  let currentRun = runsById[runId] ?? null;
  while (currentRun?.parentRunId) {
    if (visited.has(currentRun.id)) {
      break;
    }
    visited.add(currentRun.id);
    const parentRun = runsById[currentRun.parentRunId];
    if (!parentRun) {
      return currentRun.id;
    }
    currentRun = parentRun;
  }

  return currentRun?.id ?? runId;
}

function collectLinkedRunIds(input: {
  readonly rootRunId: string | null;
  readonly runsById: Record<string, OrwellRunResponse>;
  readonly childrenByParentId: Map<string, string[]>;
}) {
  if (!input.rootRunId) {
    return [];
  }

  const visited = new Set<string>();
  const queue = [input.rootRunId];
  const collected: OrwellRunResponse[] = [];

  while (queue.length > 0) {
    const runId = queue.shift();
    if (!runId || visited.has(runId)) {
      continue;
    }
    visited.add(runId);

    const run = input.runsById[runId];
    if (!run) {
      continue;
    }
    collected.push(run);

    const childIds = uniqueStrings([
      ...(input.childrenByParentId.get(runId) ?? []),
      ...(run.childRunIds ?? []),
    ]);

    for (const childId of childIds) {
      if (!visited.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return collected
    .toSorted((left, right) => {
      const leftTime = Date.parse(left.updatedAt) || Date.parse(left.createdAt) || 0;
      const rightTime = Date.parse(right.updatedAt) || Date.parse(right.createdAt) || 0;
      return rightTime - leftTime;
    })
    .map((run) => run.id);
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-medium">{props.label}</span>
      {props.children}
    </label>
  );
}

function InfoBlock(props: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/60 px-4 py-3">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.label}
      </div>
      <div className={`mt-2 break-words text-sm ${props.mono ? "font-mono text-[12px]" : ""}`}>
        {props.value}
      </div>
    </div>
  );
}

function InfoRow(props: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="text-muted-foreground">{props.label}</span>
      <span className={props.mono ? "break-all font-mono text-[12px]" : "text-right"}>
        {props.value}
      </span>
    </div>
  );
}

function statusVariant(status: OrwellRunResponse["status"] | undefined) {
  switch (status) {
    case "completed":
      return { label: "Completed", variant: "success" as const };
    case "error":
      return { label: "Error", variant: "error" as const };
    case "running":
      return { label: "Running", variant: "info" as const };
    case "starting":
      return { label: "Starting", variant: "warning" as const };
    default:
      return { label: "Idle", variant: "outline" as const };
  }
}

function fileCheckVariant(fileCheck: OrwellFileCheck | null | undefined) {
  if (!fileCheck) {
    return { label: "Not configured", variant: "outline" as const };
  }
  if (!fileCheck.exists) {
    return { label: "File missing", variant: "warning" as const };
  }
  if (fileCheck.containsExpectedText === false) {
    return { label: "Text mismatch", variant: "warning" as const };
  }
  if (fileCheck.containsExpectedText === true || fileCheck.exists) {
    return { label: "Verified", variant: "success" as const };
  }
  return { label: "Pending", variant: "outline" as const };
}

function containsExpectedTextLabel(fileCheck: OrwellFileCheck | null | undefined) {
  if (!fileCheck) {
    return "Not checked";
  }
  if (fileCheck.containsExpectedText === null) {
    return "Not checked";
  }
  return fileCheck.containsExpectedText ? "Yes" : "No";
}

function filePreview(fileCheck: OrwellFileCheck | null | undefined) {
  const preview = fileCheck?.preview ?? "";
  return preview.length > 0 ? preview : "No file content yet.";
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function bodyError(
  body: OrwellRunResponse | OrwellConfigResponse | OrwellApiError,
  fallback: string,
) {
  return "error" in body && typeof body.error === "string" && body.error.trim().length > 0
    ? body.error
    : fallback;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function shortRunId(runId: string) {
  return runId.length > 10 ? `${runId.slice(0, 10)}…` : runId;
}

function isRunStatus(value: unknown): value is OrwellRunResponse["status"] {
  return value === "starting" || value === "running" || value === "completed" || value === "error";
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) =>
    typeof item === "string" && item.trim().length > 0 ? [item.trim()] : [],
  );
}

function normalizeFileCheck(value: unknown): OrwellFileCheck | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const path = parseString(record.path);
  const absolutePath = parseString(record.absolutePath);
  const preview = typeof record.preview === "string" ? record.preview : "";
  const exists = typeof record.exists === "boolean" ? record.exists : false;
  const containsExpectedText =
    record.containsExpectedText === true || record.containsExpectedText === false
      ? record.containsExpectedText
      : record.containsExpectedText === null
        ? null
        : null;

  if (!path || !absolutePath) {
    return null;
  }

  return {
    path,
    absolutePath,
    exists,
    containsExpectedText,
    preview,
  };
}

function normalizeRunLike(value: unknown): OrwellRunResponse {
  const record = isRunRecord(value) ? value : null;
  const now = new Date().toISOString();

  if (!record) {
    throw new Error("Invalid run record.");
  }

  const createdAt = parseString(record.createdAt) ?? now;
  const updatedAt = parseString(record.updatedAt) ?? createdAt;
  return {
    id: record.id.trim(),
    status: isRunStatus(record.status) ? record.status : "starting",
    createdAt,
    updatedAt,
    directory: parseString(record.directory) ?? "",
    title: parseString(record.title) ?? "Discovered run",
    prompt: parseString(record.prompt) ?? "",
    sessionId: parseString(record.sessionId) ?? null,
    serverUrl: parseString(record.serverUrl) ?? null,
    error: parseString(record.error) ?? null,
    expectedFilePath: parseString(record.expectedFilePath) ?? null,
    expectedText: parseString(record.expectedText) ?? null,
    events: Array.isArray(record.events) ? (record.events as ReadonlyArray<OrwellEvent>) : [],
    fileCheck: normalizeFileCheck(record.fileCheck),
    parentRunId: parseString(record.parentRunId) ?? null,
    childRunIds: parseStringArray(record.childRunIds),
  };
}

function isRunRecord(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    return false;
  }

  return (
    "status" in record ||
    "directory" in record ||
    "prompt" in record ||
    "sessionId" in record ||
    "events" in record ||
    "fileCheck" in record ||
    "parentRunId" in record ||
    "childRunIds" in record
  );
}

function discoverRunsFromPayload(payload: unknown): OrwellRunResponse[] {
  const discovered = new Map<string, OrwellRunResponse>();
  const seen = new WeakSet<object>();

  const visit = (value: unknown) => {
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          // Ignore strings that only look like JSON.
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (isRunRecord(value)) {
      try {
        const run = normalizeRunLike(value);
        discovered.set(run.id, run);
      } catch {
        // Ignore objects that are not actually run records.
      }
    }

    for (const item of Object.values(value)) {
      visit(item);
    }
  };

  visit(payload);
  return [...discovered.values()];
}

function uniqueStrings(values: ReadonlyArray<string>) {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function upsertRun(
  setter: Dispatch<SetStateAction<Record<string, OrwellRunResponse>>>,
  nextRun: OrwellRunResponse,
) {
  setter((previous) => {
    const current = previous[nextRun.id];
    const merged: OrwellRunResponse = current
      ? {
          ...current,
          ...nextRun,
          events: nextRun.events.length > 0 ? nextRun.events : current.events,
          fileCheck: nextRun.fileCheck ?? current.fileCheck,
          childRunIds: uniqueStrings([
            ...(current.childRunIds ?? []),
            ...(nextRun.childRunIds ?? []),
          ]),
          parentRunId: nextRun.parentRunId ?? current.parentRunId ?? null,
        }
      : nextRun;

    const nextRuns = {
      ...previous,
      [merged.id]: merged,
    };

    for (const discoveredRun of discoverRunsFromPayload(merged)) {
      const existing = nextRuns[discoveredRun.id];
      nextRuns[discoveredRun.id] = existing
        ? {
            ...existing,
            ...discoveredRun,
            events: discoveredRun.events.length > 0 ? discoveredRun.events : existing.events,
            fileCheck: discoveredRun.fileCheck ?? existing.fileCheck,
            childRunIds: uniqueStrings([
              ...(existing.childRunIds ?? []),
              ...(discoveredRun.childRunIds ?? []),
            ]),
            parentRunId: discoveredRun.parentRunId ?? existing.parentRunId ?? null,
          }
        : discoveredRun;
    }

    return nextRuns;
  });
}

async function parseApiBody<T>(response: Response): Promise<T | OrwellApiError> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return {
      error: text,
    };
  }
}
