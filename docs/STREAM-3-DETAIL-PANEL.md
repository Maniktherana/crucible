# Stream 3: Frontend — Card Detail Panel & Session View

## Goal

Build the right-side panel that opens when a kanban card is clicked. This panel is the **observability surface** — it shows the issue info, the manager/child run tree, per-run event streams in a chat-like format, and agent-browser screenshots inline. A mentor should be able to pull up any run and see exactly what each agent did, step by step.

Read `docs/OVERVIEW.md` first for full project context, shared data types, and the API contract.

## MaaS Parameters Owned

- **Observability (7x):** L3 — "Can pull up a specific run and see what each agent did, step by step." Push to L4: "Trace tree across agents (who called whom), token and cost per step, filter by agent or task."

The detail panel IS the observability surface. What a mentor sees here determines L3 vs L4 vs L5 on a 7x parameter (14-28 points).

## File Ownership

### Files this stream CREATES

| File                                                       | Action                           |
| ---------------------------------------------------------- | -------------------------------- |
| `apps/web/src/components/crucible/CardDetailPanel.tsx`     | NEW — overwrites Stream 2's stub |
| `apps/web/src/components/crucible/RunTreeView.tsx`         | NEW                              |
| `apps/web/src/components/crucible/RunStatusBadge.tsx`      | NEW                              |
| `apps/web/src/components/crucible/EventStreamView.tsx`     | NEW                              |
| `apps/web/src/components/crucible/SessionChatView.tsx`     | NEW                              |
| `apps/web/src/components/crucible/AgentBrowserPreview.tsx` | NEW                              |

### Files this stream READS (does not modify)

| File                                                   | Why                                            |
| ------------------------------------------------------ | ---------------------------------------------- |
| `apps/web/src/components/crucible/types.ts`            | Shared types (Stream 2 creates this)           |
| `apps/web/src/components/crucible/useCrucibleStore.ts` | Read `selectedCard`, `runs` (Stream 2 creates) |

### Files this stream DOES NOT TOUCH

- `apps/server/` — consumes API only
- Route files (`__root.tsx`, `_chat.index.tsx`, etc.) — Stream 2 owns
- `TopBar.tsx`, `KanbanBoard.tsx`, `KanbanColumn.tsx`, `IssueCard.tsx`, `RepoSelector.tsx` — Stream 2
- `CrucibleLayout.tsx` — Stream 2
- `packages/`

## Dependency on Stream 2

Stream 2 creates `types.ts` and `useCrucibleStore.ts`. This stream imports from them. If Stream 2 hasn't delivered yet, create local type stubs and swap imports later.

Stream 2 renders `<CardDetailPanel card={selectedCard} onClose={...} />` when `selectedCard` is non-null. This stream provides the real implementation of that component (overwriting Stream 2's stub).

## UI Primitives Available

Use existing components from `apps/web/src/components/ui/`:

```typescript
import { Sheet, SheetPopup } from "~/components/ui/sheet";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
```

For markdown rendering, `react-markdown` and `remark-gfm` are already dependencies. Import pattern:

```typescript
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
```

Icons: `lucide-react` is a dependency. Import individual icons:

```typescript
import {
  XIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GitBranchIcon,
  TerminalIcon,
  ImageIcon,
  FilterIcon,
} from "lucide-react";
```

## Detailed Requirements

### 1. `CardDetailPanel.tsx`

This is the main container. It renders as a right-side sheet (50% viewport width) using the existing `Sheet` + `SheetPopup` from `~/components/ui/sheet`.

**Props:**

```typescript
interface CardDetailPanelProps {
  card: KanbanCard;
  onClose: () => void;
}
```

**Layout (top to bottom):**

```
┌─────────────────────────────────────┐
│ Header: #N Title        [Status] [X]│
├─────────────────────────────────────┤
│ Issue body (markdown rendered)      │
│ Labels as badges                    │
│ [Start] button if no run exists     │
├─────────────────────────────────────┤
│ Run Tree (if runs exist)            │
│   Manager run                       │
│     ├── Task 1 (completed)          │
│     ├── Task 2 (running)            │
│     └── Task 3 (starting)           │
├─────────────────────────────────────┤
│ Event Stream (for selected run)     │
│   [All] [Tools] [Text] [Errors]     │
│   ┌───────────────────────────┐     │
│   │ 2m ago  spawn-subtask     │     │
│   │ 1m ago  bash: npm install │     │
│   │ 30s ago text: "I've..."   │     │
│   │ 15s ago screenshot.png    │     │
│   │         [image preview]   │     │
│   └───────────────────────────┘     │
└─────────────────────────────────────┘
```

**State:**

```typescript
const [selectedRunId, setSelectedRunId] = useState<string | null>(card.managerRun?.id ?? null);
const [filterMode, setFilterMode] = useState<"all" | "tools" | "text" | "errors">("all");
```

**Data fetching:**

- Poll `GET /api/crucible/runs/{selectedRunId}` every 2 seconds for the selected run's latest events
- Also fetch children: for the manager run, iterate `childRunIds` and fetch each

**Implementation:**

```tsx
<Sheet
  open
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <SheetPopup side="right" showCloseButton={false} className="w-[50vw] p-0">
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">#{card.issue.number}</span>
          <h2 className="text-sm font-semibold">{card.issue.title}</h2>
          {card.managerRun && <RunStatusBadge status={card.managerRun.status} />}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <XIcon className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {/* Issue body */}
        <div className="border-b px-4 py-3">
          <div className="prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.issue.body}</ReactMarkdown>
          </div>
          <div className="mt-2 flex gap-1">
            {card.issue.labels.map((l) => (
              <Badge key={l.name} variant="secondary" className="text-[10px]">
                {l.name}
              </Badge>
            ))}
          </div>
        </div>

        {/* Start button if no run */}
        {!card.managerRun && (
          <div className="border-b px-4 py-3">
            <Button onClick={handleStart} className="w-full">
              Start Agent
            </Button>
          </div>
        )}

        {/* Run tree */}
        {card.managerRun && (
          <div className="border-b px-4 py-3">
            <RunTreeView
              managerRun={card.managerRun}
              taskRuns={card.taskRuns}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
            />
          </div>
        )}

        {/* Event stream for selected run */}
        {selectedRunId && selectedRun && (
          <div className="px-4 py-3">
            <EventStreamView
              run={selectedRun}
              filterMode={filterMode}
              onFilterChange={setFilterMode}
            />
          </div>
        )}
      </ScrollArea>
    </div>
  </SheetPopup>
</Sheet>
```

### 2. `RunTreeView.tsx`

Shows the agent hierarchy: manager at top, children indented below.

**Props:**

```typescript
interface RunTreeViewProps {
  managerRun: CrucibleRun;
  taskRuns: CrucibleRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
}
```

**Layout:**

```tsx
<div className="space-y-1">
  <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
    Agent Tree
  </h4>

  {/* Manager run */}
  <RunTreeNode
    run={managerRun}
    label="Manager"
    isSelected={selectedRunId === managerRun.id}
    onClick={() => onSelectRun(managerRun.id)}
    depth={0}
  />

  {/* Task runs */}
  {taskRuns.map((run, i) => (
    <RunTreeNode
      key={run.id}
      run={run}
      label={`Task ${i + 1}`}
      isSelected={selectedRunId === run.id}
      onClick={() => onSelectRun(run.id)}
      depth={1}
    />
  ))}
</div>
```

Each `RunTreeNode`:

```tsx
function RunTreeNode({
  run,
  label,
  isSelected,
  onClick,
  depth,
}: {
  run: CrucibleRun;
  label: string;
  isSelected: boolean;
  onClick: () => void;
  depth: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent/50",
        isSelected && "bg-accent",
      )}
      style={{ paddingLeft: `${8 + depth * 20}px` }}
    >
      {depth > 0 && <span className="text-muted-foreground/40">└─</span>}
      <RunStatusBadge status={run.status} />
      <span className="font-medium">{label}</span>
      <span className="truncate text-xs text-muted-foreground">{run.prompt.slice(0, 60)}...</span>
      {run.prUrl && (
        <Badge variant="secondary" className="ml-auto text-[10px]">
          PR
        </Badge>
      )}
    </button>
  );
}
```

This tree view is key for L4 observability: "Trace tree across agents (who called whom)." The parent/child structure with status at each node shows the full delegation chain.

### 3. `RunStatusBadge.tsx`

Reusable status indicator.

**Props:**

```typescript
interface RunStatusBadgeProps {
  status: CrucibleRunStatus;
  showLabel?: boolean; // default false, just show dot
}
```

**Implementation:**

```tsx
const STATUS_CONFIG: Record<CrucibleRunStatus, { color: string; label: string; pulse?: boolean }> =
  {
    starting: { color: "bg-yellow-500", label: "Starting" },
    running: { color: "bg-blue-500", label: "Running", pulse: true },
    completed: { color: "bg-green-500", label: "Completed" },
    error: { color: "bg-red-500", label: "Error" },
  };

export function RunStatusBadge({ status, showLabel = false }: RunStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", config.color, config.pulse && "animate-pulse")} />
      {showLabel && <span className="text-xs text-muted-foreground">{config.label}</span>}
    </span>
  );
}
```

### 4. `EventStreamView.tsx`

Per-run event timeline. This is the core observability component — what a mentor looks at to see "what each agent did, step by step."

**Props:**

```typescript
interface EventStreamViewProps {
  run: CrucibleRun;
  filterMode: "all" | "tools" | "text" | "errors";
  onFilterChange: (mode: "all" | "tools" | "text" | "errors") => void;
}
```

**Event categorization:**

```typescript
function categorizeEvent(event: CrucibleRunEvent): "tool" | "text" | "error" | "system" {
  if (event.type === "session.error") return "error";
  if (event.type === "message.part.updated") {
    const payload = event.payload as any;
    if (payload?.type === "tool-invocation" || payload?.type === "tool-result") return "tool";
    if (payload?.type === "text" || payload?.type === "reasoning") return "text";
  }
  return "system";
}
```

**Filter logic:**

```typescript
const filteredEvents = run.events.filter((event) => {
  if (filterMode === "all") return true;
  const category = categorizeEvent(event);
  if (filterMode === "tools") return category === "tool";
  if (filterMode === "text") return category === "text";
  if (filterMode === "errors") return category === "error";
  return true;
});
```

**Layout:**

```tsx
<div className="space-y-3">
  {/* Filter bar */}
  <div className="flex items-center gap-1">
    <span className="mr-2 text-xs text-muted-foreground">Filter:</span>
    {(["all", "tools", "text", "errors"] as const).map((mode) => (
      <Button
        key={mode}
        size="sm"
        variant={filterMode === mode ? "default" : "ghost"}
        className="h-6 text-xs"
        onClick={() => onFilterChange(mode)}
      >
        {mode.charAt(0).toUpperCase() + mode.slice(1)}
      </Button>
    ))}
    <span className="ml-auto text-xs text-muted-foreground">{filteredEvents.length} events</span>
  </div>

  {/* Event list */}
  <div className="space-y-2">
    {filteredEvents.map((event) => (
      <EventCard key={event.id} event={event} />
    ))}
  </div>
</div>
```

**EventCard component:**

```tsx
function EventCard({ event }: { event: CrucibleRunEvent }) {
  const [expanded, setExpanded] = useState(false);
  const category = categorizeEvent(event);
  const isAgentBrowserScreenshot = detectAgentBrowserScreenshot(event);

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        category === "error" && "border-red-500/30 bg-red-500/5",
        category === "tool" && "border-blue-500/20 bg-blue-500/5",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{formatRelativeTime(event.at)}</span>
        <Badge variant="secondary" className="text-[10px]">
          {event.type}
        </Badge>
        {isSpawnSubtask(event) && (
          <Badge className="bg-purple-500/20 text-purple-300 text-[10px]">spawn</Badge>
        )}
      </div>

      {/* Summary */}
      <p className="mt-1 text-sm">{event.summary}</p>

      {/* Agent browser screenshot */}
      {isAgentBrowserScreenshot && <AgentBrowserPreview event={event} />}

      {/* Tool call code block */}
      {category === "tool" && event.summary.includes("bash") && (
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-xs">
          {extractBashCommand(event)}
        </pre>
      )}

      {/* Expandable raw payload */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs text-muted-foreground hover:text-foreground"
      >
        {expanded ? "Hide" : "Show"} raw payload
      </button>
      {expanded && (
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-background p-2 text-xs">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
```

**Helper functions:**

```typescript
function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function isSpawnSubtask(event: CrucibleRunEvent): boolean {
  return event.summary.toLowerCase().includes("spawn-subtask");
}

function detectAgentBrowserScreenshot(event: CrucibleRunEvent): boolean {
  const text = event.summary + JSON.stringify(event.payload);
  return text.includes("agent-browser") && text.includes("screenshot");
}

function extractBashCommand(event: CrucibleRunEvent): string {
  // Extract command from tool_use payload
  const payload = event.payload as any;
  return payload?.input?.command ?? payload?.arguments?.command ?? event.summary;
}
```

### 5. `AgentBrowserPreview.tsx`

Renders inline previews when an agent uses agent-browser.

**Props:**

```typescript
interface AgentBrowserPreviewProps {
  event: CrucibleRunEvent;
}
```

**Detection logic:**

```typescript
function extractScreenshotPath(event: CrucibleRunEvent): string | null {
  // Look for patterns like: agent-browser screenshot /path/to/file.png
  // or: agent-browser screenshot --full /path/to/file.png
  const text = event.summary + " " + JSON.stringify(event.payload);
  const match = text.match(/agent-browser\s+screenshot\s+(?:--\w+\s+)*([^\s"]+\.(?:png|jpg|jpeg))/);
  return match?.[1] ?? null;
}

function extractSnapshotOutput(event: CrucibleRunEvent): string | null {
  // Look for agent-browser snapshot output in tool result
  const payload = event.payload as any;
  const output = payload?.output ?? payload?.result ?? "";
  if (typeof output === "string" && output.includes("[ref=")) {
    return output;
  }
  return null;
}
```

**Implementation:**

```tsx
export function AgentBrowserPreview({ event }: AgentBrowserPreviewProps) {
  const screenshotPath = extractScreenshotPath(event);
  const snapshotOutput = extractSnapshotOutput(event);

  if (screenshotPath) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border">
        <div className="flex items-center gap-1 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
          <ImageIcon className="h-3 w-3" />
          <span>agent-browser screenshot</span>
        </div>
        <img
          src={`/api/crucible/files?path=${encodeURIComponent(screenshotPath)}`}
          alt="Agent browser screenshot"
          className="max-h-64 w-full object-contain"
          onError={(e) => {
            // Hide broken images
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
    );
  }

  if (snapshotOutput) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border">
        <div className="flex items-center gap-1 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
          <TerminalIcon className="h-3 w-3" />
          <span>agent-browser snapshot</span>
        </div>
        <pre className="max-h-48 overflow-auto p-2 text-xs">{snapshotOutput}</pre>
      </div>
    );
  }

  return null;
}
```

### 6. `SessionChatView.tsx`

A lightweight chat-style renderer for run events. Not a 1:1 reuse of the existing t3code chat components (those are deeply coupled to the main app's Effect-based state management). Build fresh, reading from `CrucibleRunEvent[]`.

**Props:**

```typescript
interface SessionChatViewProps {
  events: CrucibleRunEvent[];
}
```

This component renders events as a conversation. Use it as an alternative view mode within `EventStreamView` (e.g., a toggle between "Timeline" and "Chat" views).

**Implementation:**

```tsx
export function SessionChatView({ events }: SessionChatViewProps) {
  const messageEvents = events.filter((e) => e.type === "message.part.updated");

  return (
    <div className="space-y-3">
      {messageEvents.map((event) => {
        const payload = event.payload as any;
        const partType = payload?.type ?? "unknown";

        if (partType === "text") {
          return (
            <div key={event.id} className="rounded-lg bg-muted/30 p-3">
              <div className="prose prose-sm prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {payload?.text ?? event.summary}
                </ReactMarkdown>
              </div>
            </div>
          );
        }

        if (partType === "tool-invocation") {
          return (
            <div key={event.id} className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TerminalIcon className="h-3 w-3" />
                <span>{payload?.toolName ?? "tool"}</span>
              </div>
              <pre className="mt-1 overflow-x-auto text-xs">
                {payload?.input?.command ?? JSON.stringify(payload?.input, null, 2)}
              </pre>
            </div>
          );
        }

        if (partType === "tool-result") {
          return (
            <div key={event.id} className="ml-4 rounded-lg border bg-background/50 p-2">
              <pre className="max-h-32 overflow-auto text-xs">
                {typeof payload?.output === "string"
                  ? payload.output.slice(0, 500)
                  : JSON.stringify(payload?.output, null, 2)?.slice(0, 500)}
              </pre>
            </div>
          );
        }

        if (partType === "reasoning") {
          return (
            <details key={event.id} className="rounded-lg bg-muted/20 p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">Reasoning</summary>
              <p className="mt-1 text-sm">{payload?.text ?? event.summary}</p>
            </details>
          );
        }

        return null;
      })}
    </div>
  );
}
```

## Observability Scoring Guide

To score well on the 7x observability parameter:

- **L3 (14 pts):** A mentor can pull up a specific run and see what each agent did, step by step. The event stream with filter buttons achieves this.
- **L4 (21 pts):** Trace tree across agents (who called whom), token and cost per step, filter by agent or task. The `RunTreeView` showing parent→children with status achieves the trace tree. Per-step cost requires extracting token counts from event payloads (if available).
- **L5 (28 pts):** Diff two runs side by side, alerts on failure or cost spike, search across runs. This is stretch.

Focus on making L3 rock-solid and L4 achievable.

## Verification

```bash
bun fmt && bun lint && bun typecheck
```

Visual checks:

- Click a kanban card → detail panel slides in from right
- Issue body renders as markdown
- Run tree shows manager + children with status dots
- Click a run → event stream updates
- Filter buttons work (All/Tools/Text/Errors)
- Agent-browser screenshots render inline
- Raw payload expands/collapses
- Panel closes cleanly
