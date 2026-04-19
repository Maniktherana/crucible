import { createFileRoute } from "@tanstack/react-router";

import { KanbanBoard } from "../components/crucible/KanbanBoard";

function ChatIndexRouteView() {
  return <KanbanBoard />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
