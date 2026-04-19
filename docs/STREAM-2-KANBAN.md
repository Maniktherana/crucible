# Stream 2: Frontend — Kanban Board & Layout

## Goal

Replace the root route with a Crucible kanban board. Build the top bar (branding + repo selector), three-column kanban (Todo / In Progress / Done), and issue cards. Clicking a card sets state that Stream 3's detail panel reads.

Read `docs/OVERVIEW.md` first for full project context, shared data types, and the API contract.

## MaaS Parameters Owned

- **Management UI (1x):** L3 — "Functional UI, a PM could operate with docs." The kanban board with repo selector, start button, and status indicators is the management surface.

## File Ownership

### Files this stream CREATES

| File                                                   | Action                                    |
| ------------------------------------------------------ | ----------------------------------------- |
| `apps/web/src/components/crucible/types.ts`            | NEW — shared data model (see OVERVIEW.md) |
| `apps/web/src/components/crucible/useCrucibleStore.ts` | NEW — zustand store                       |
| `apps/web/src/components/crucible/CrucibleLayout.tsx`  | NEW — top bar + content area              |
| `apps/web/src/components/crucible/TopBar.tsx`          | NEW — branding + repo selector            |
| `apps/web/src/components/crucible/KanbanBoard.tsx`     | NEW — 3-column board                      |
| `apps/web/src/components/crucible/KanbanColumn.tsx`    | NEW — single column                       |
| `apps/web/src/components/crucible/IssueCard.tsx`       | NEW — card in the board                   |
| `apps/web/src/components/crucible/RepoSelector.tsx`    | NEW — dropdown + clone dialog             |
| `apps/web/src/components/crucible/CardDetailPanel.tsx` | NEW — **stub only** (Stream 3 overwrites) |

### Files this stream MODIFIES

| File                                  | Change                                                |
| ------------------------------------- | ----------------------------------------------------- |
| `apps/web/src/routes/__root.tsx`      | Replace `AppSidebarLayout` with `CrucibleLayout`      |
| `apps/web/src/routes/_chat.index.tsx` | Render `KanbanBoard` instead of `NoActiveThreadState` |

### Files this stream DOES NOT TOUCH

- `apps/server/` — consumes API only
- `apps/web/src/components/crucible/RunTreeView.tsx` (Stream 3)
- `apps/web/src/components/crucible/EventStreamView.tsx` (Stream 3)
- `apps/web/src/components/crucible/SessionChatView.tsx` (Stream 3)
- `apps/web/src/components/crucible/AgentBrowserPreview.tsx` (Stream 3)
- `apps/web/src/components/crucible/RunStatusBadge.tsx` (Stream 3)
- Existing `_chat.$environmentId.$threadId.tsx`
- `packages/`

## Existing Code Reference

### Current `__root.tsx` layout (authenticated block, lines 92-110)

```tsx
<ToastProvider>
  <AnchoredToastProvider>
    <AuthenticatedTracingBootstrap />
    <ServerStateBootstrap />
    <EnvironmentConnectionManagerBootstrap />
    <EventRouter />
    <WebSocketConnectionCoordinator />
    <SlowRpcAckToastCoordinator />
    <WebSocketConnectionSurface>
      <CommandPalette>
        <AppSidebarLayout>
          {" "}
          ← REPLACE THIS
          <Outlet />
        </AppSidebarLayout>
      </CommandPalette>
    </WebSocketConnectionSurface>
  </AnchoredToastProvider>
</ToastProvider>
```

Replace `<AppSidebarLayout>` with `<CrucibleLayout>`. Keep everything else (auth, WS, toasts, tracing, command palette).

### Current `_chat.index.tsx` (entire file)

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { NoActiveThreadState } from "../components/NoActiveThreadState";

function ChatIndexRouteView() {
  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
```

Replace `<NoActiveThreadState />` with `<KanbanBoard />`.

### UI primitives available in `apps/web/src/components/ui/`

You have a full shadcn-style component library already. Use these — do NOT install new UI packages:

- `button.tsx` — `<Button>`, `<Button variant="outline">`, etc.
- `badge.tsx` — `<Badge>`, `<Badge variant="secondary">`
- `card.tsx` — `<Card>`, `<CardHeader>`, `<CardTitle>`, `<CardDescription>`, `<CardContent>`
- `input.tsx` — `<Input>`
- `select.tsx` — select components
- `combobox.tsx` — searchable dropdown
- `dialog.tsx` — modal dialogs
- `sheet.tsx` — side panels (`<Sheet>`, `<SheetPopup side="right">`)
- `scroll-area.tsx` — `<ScrollArea>`
- `spinner.tsx` — loading indicator
- `tooltip.tsx` — tooltips
- `separator.tsx` — visual divider
- `switch.tsx` — toggle switch
- `menu.tsx` — dropdown menus

Import pattern: `import { Button } from "~/components/ui/button"` (the `~` alias maps to `apps/web/src/`).

### Utility

`import { cn } from "~/lib/utils"` — Tailwind class merging utility (clsx + twMerge).

## Detailed Requirements

### 1. `types.ts` — Shared Data Model

Create `apps/web/src/components/crucible/types.ts` with all shared types from `docs/OVERVIEW.md` (CrucibleIssue, CrucibleRun, CrucibleRunEvent, KanbanCard, CrucibleRepo, etc.).

This file is imported by both Stream 2 and Stream 3 components. Create it first.

### 2. `useCrucibleStore.ts` — Zustand Store

```typescript
import { create } from "zustand";
import type { CrucibleIssue, CrucibleRun, CrucibleRepo, KanbanCard } from "./types";

interface CrucibleState {
  // Data
  selectedRepo: string | null; // "owner/name"
  repos: CrucibleRepo[];
  issues: CrucibleIssue[];
  runs: CrucibleRun[];
  selectedCard: KanbanCard | null;

  // Derived (computed in selectors, not stored)
  // kanbanCards derived from issues + runs

  // Actions
  setSelectedRepo: (repo: string | null) => void;
  setRepos: (repos: CrucibleRepo[]) => void;
  setIssues: (issues: CrucibleIssue[]) => void;
  setRuns: (runs: CrucibleRun[]) => void;
  upsertRuns: (runs: CrucibleRun[]) => void;
  setSelectedCard: (card: KanbanCard | null) => void;
}
```

Add a derived selector function (outside the store):

```typescript
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

    return { issue, column, managerRun, taskRuns };
  });
}
```

### 3. `CrucibleLayout.tsx`

Full-width layout. No left sidebar. Replaces `AppSidebarLayout`.

```tsx
// Structure:
// <div className="flex h-screen flex-col bg-background text-foreground">
//   <TopBar />
//   <main className="flex-1 overflow-hidden">
//     {children}
//   </main>
// </div>
```

Props: `{ children: ReactNode }`

### 4. `TopBar.tsx`

48px height top bar.

```tsx
// Structure:
// <header className="flex h-12 items-center border-b border-border bg-card px-4">
//   {/* Left: branding */}
//   <div className="flex items-center gap-2">
//     <span className="text-sm font-bold tracking-tight">Crucible</span>
//     <Badge variant="secondary" className="text-[10px]">Alpha</Badge>
//   </div>
//
//   {/* Center: repo selector */}
//   <div className="mx-auto">
//     <RepoSelector />
//   </div>
//
//   {/* Right: status */}
//   <div className="flex items-center gap-2 text-xs text-muted-foreground">
//     <div className="h-2 w-2 rounded-full bg-green-500" />
//     <span>Connected</span>
//   </div>
// </header>
```

### 5. `RepoSelector.tsx`

Dropdown that lists repos and allows cloning new ones.

**Behavior:**

1. On mount, fetch `GET /api/crucible/repos` and populate dropdown
2. Show currently selected repo
3. Changing selection → call `store.setSelectedRepo(name)`, then fetch issues for that repo
4. Bottom of dropdown: "Clone a repository..." action
5. Clone action opens a dialog (use `ui/dialog.tsx`) with a URL input
6. On submit: `POST /api/crucible/repos/clone`, refresh repo list, select the new repo
7. Default to first repo on load (seed with `Maniktherana/manikrana.dev`)

**API calls:**

```typescript
// Fetch repos
const res = await fetch("/api/crucible/repos");
const { repos } = await res.json();

// Clone repo
const res = await fetch("/api/crucible/repos/clone", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url }),
});
const repo = await res.json();

// Fetch issues for selected repo
const res = await fetch(`/api/crucible/repos/${owner}/${name}/issues`);
const { issues } = await res.json();
```

Use the `Combobox` or `Select` component from `~/components/ui/` for the dropdown.

### 6. `KanbanBoard.tsx`

Three-column kanban board.

**Data flow:**

1. Read `selectedRepo`, `issues`, `runs` from `useCrucibleStore`
2. On `selectedRepo` change: fetch issues from API, store in zustand
3. Poll `GET /api/crucible/runs?repo={selectedRepo}` every 2 seconds, upsert into store
4. Derive `KanbanCard[]` from issues + runs using `deriveKanbanCards()`
5. Split cards into 3 columns by `card.column`
6. Render 3 `<KanbanColumn>` side by side

**Layout:**

```tsx
// <div className="flex h-full gap-4 p-4 overflow-x-auto">
//   <KanbanColumn title="Todo" columnId="todo" cards={todoCards} onStartIssue={handleStart} />
//   <KanbanColumn title="In Progress" columnId="in_progress" cards={inProgressCards} />
//   <KanbanColumn title="Done" columnId="done" cards={doneCards} />
// </div>
```

**Start handler:**

```typescript
async function handleStartIssue(issue: CrucibleIssue) {
  const res = await fetch("/api/crucible/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: selectedRepo,
      issueNumber: issue.number,
      prompt: `Issue #${issue.number}: ${issue.title}\n\n${issue.body}`,
      plannerMode: true,
      type: "manager",
    }),
  });
  // The polling will pick up the new run and move the card to In Progress
}
```

**Integration with detail panel (Stream 3):**

```tsx
// At the end of KanbanBoard or in the route:
{
  selectedCard && <CardDetailPanel card={selectedCard} onClose={() => setSelectedCard(null)} />;
}
```

### 7. `KanbanColumn.tsx`

Single column.

```typescript
interface KanbanColumnProps {
  title: string;
  columnId: KanbanColumnId;
  cards: KanbanCard[];
  onStartIssue?: (issue: CrucibleIssue) => void; // only for "todo" column
}
```

**Layout:**

```tsx
// <div className="flex w-80 flex-shrink-0 flex-col rounded-lg bg-muted/30">
//   <div className="flex items-center justify-between px-3 py-2">
//     <h3 className="text-sm font-medium">{title}</h3>
//     <Badge variant="secondary">{cards.length}</Badge>
//   </div>
//   <ScrollArea className="flex-1 px-2 pb-2">
//     <div className="flex flex-col gap-2">
//       {cards.map(card => (
//         <IssueCard
//           key={card.issue.number}
//           card={card}
//           onClick={() => setSelectedCard(card)}
//           onStart={columnId === "todo" ? () => onStartIssue?.(card.issue) : undefined}
//         />
//       ))}
//     </div>
//   </ScrollArea>
// </div>
```

### 8. `IssueCard.tsx`

Individual card.

```typescript
interface IssueCardProps {
  card: KanbanCard;
  onClick: () => void;
  onStart?: () => void; // only for todo cards
}
```

**Layout:**

```tsx
// <Card
//   className={cn(
//     "cursor-pointer transition-colors hover:bg-accent/50",
//     "border-l-4",
//     card.column === "todo" && "border-l-muted-foreground/30",
//     card.column === "in_progress" && "border-l-blue-500",
//     card.column === "done" && "border-l-green-500",
//   )}
//   onClick={onClick}
// >
//   <CardHeader className="p-3 pb-1">
//     <div className="flex items-center justify-between">
//       <span className="text-xs text-muted-foreground">#{card.issue.number}</span>
//       {card.managerRun && <RunStatusDot status={card.managerRun.status} />}
//     </div>
//     <CardTitle className="text-sm font-medium leading-snug">
//       {card.issue.title}
//     </CardTitle>
//   </CardHeader>
//   <CardContent className="p-3 pt-1">
//     <div className="flex items-center gap-2">
//       {card.issue.labels.map(l => (
//         <Badge key={l.name} variant="secondary" className="text-[10px]">{l.name}</Badge>
//       ))}
//     </div>
//     {card.taskRuns.length > 0 && (
//       <span className="mt-1 block text-xs text-muted-foreground">
//         {card.taskRuns.length} subtask{card.taskRuns.length !== 1 ? "s" : ""}
//       </span>
//     )}
//     {onStart && (
//       <Button
//         size="sm"
//         className="mt-2 w-full"
//         onClick={(e) => { e.stopPropagation(); onStart(); }}
//       >
//         Start
//       </Button>
//     )}
//   </CardContent>
// </Card>
```

`RunStatusDot` is a simple inline component:

```tsx
function RunStatusDot({ status }: { status: CrucibleRunStatus }) {
  return (
    <div
      className={cn(
        "h-2 w-2 rounded-full",
        status === "starting" && "bg-yellow-500",
        status === "running" && "bg-blue-500 animate-pulse",
        status === "completed" && "bg-green-500",
        status === "error" && "bg-red-500",
      )}
    />
  );
}
```

### 9. `CardDetailPanel.tsx` — STUB

Create a minimal stub that Stream 3 will replace:

```tsx
import type { KanbanCard } from "./types";
import { Sheet, SheetPopup } from "~/components/ui/sheet";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { XIcon } from "lucide-react";

export function CardDetailPanel({ card, onClose }: { card: KanbanCard; onClose: () => void }) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup side="right" showCloseButton={false} className="w-[50vw] p-0">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <span className="text-xs text-muted-foreground">#{card.issue.number}</span>
              <h2 className="text-sm font-semibold">{card.issue.title}</h2>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <XIcon className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 p-4 text-sm text-muted-foreground">
            Detail panel — pending Stream 3 implementation
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
```

### 10. Modify `__root.tsx`

In the authenticated return block, replace:

```tsx
<AppSidebarLayout>
  <Outlet />
</AppSidebarLayout>
```

With:

```tsx
<CrucibleLayout>
  <Outlet />
</CrucibleLayout>
```

Add import: `import { CrucibleLayout } from "../components/crucible/CrucibleLayout";`

Remove import: `import { AppSidebarLayout } from "../components/AppSidebarLayout";`

**Keep everything else unchanged** — auth gates, bootstrap components, toast providers, WS coordinator, command palette.

### 11. Modify `_chat.index.tsx`

Replace the entire component:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { KanbanBoard } from "../components/crucible/KanbanBoard";

function ChatIndexRouteView() {
  return <KanbanBoard />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
```

## Mock Data (for development before backend is ready)

If the API isn't available yet, use mock data to develop the UI:

```typescript
const MOCK_ISSUES: CrucibleIssue[] = [
  {
    number: 1,
    title: "Add dark mode toggle",
    body: "Add a dark/light mode toggle to the site header.",
    labels: [{ name: "enhancement" }],
    assignees: [],
    state: "open",
    url: "https://github.com/Maniktherana/manikrana.dev/issues/1",
    html_url: "https://github.com/Maniktherana/manikrana.dev/issues/1",
  },
  {
    number: 2,
    title: "Fix mobile nav overflow",
    body: "Navigation menu overflows on screens < 640px.",
    labels: [{ name: "bug" }],
    assignees: [],
    state: "open",
    url: "https://github.com/Maniktherana/manikrana.dev/issues/2",
    html_url: "https://github.com/Maniktherana/manikrana.dev/issues/2",
  },
  {
    number: 3,
    title: "Add project showcase section",
    body: "Create a projects section with cards linking to GitHub repos.",
    labels: [{ name: "feature" }],
    assignees: [],
    state: "open",
    url: "https://github.com/Maniktherana/manikrana.dev/issues/3",
    html_url: "https://github.com/Maniktherana/manikrana.dev/issues/3",
  },
];
```

Wrap API calls in try/catch and fall back to mocks during development.

## Verification

```bash
bun fmt && bun lint && bun typecheck
```

Visual checks:

- Open browser at dev URL
- Top bar shows "Crucible" + repo selector
- Kanban board renders 3 columns
- Issue cards appear in Todo column
- Clicking a card opens the detail panel stub
- "Start" button on todo cards triggers run creation
- Cards move from Todo → In Progress as runs start
