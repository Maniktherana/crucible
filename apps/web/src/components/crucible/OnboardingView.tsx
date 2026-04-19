import { useState } from "react";
import { GitBranchIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

import { CloneRepoDialog } from "./CloneRepoDialog";

export function OnboardingView() {
  const [cloneOpen, setCloneOpen] = useState(false);

  return (
    <>
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia>
            <div className="flex size-16 items-center justify-center rounded-full bg-muted">
              <GitBranchIcon className="size-8 text-muted-foreground" />
            </div>
          </EmptyMedia>
          <EmptyTitle>Clone a repository to get started</EmptyTitle>
          <EmptyDescription>
            Crucible works with real GitHub repositories. Clone one to see its issues on the kanban
            board, then let AI agents work on them.
          </EmptyDescription>
        </EmptyHeader>
        <Button size="lg" onClick={() => setCloneOpen(true)}>
          Clone Repository
        </Button>
      </Empty>

      <CloneRepoDialog open={cloneOpen} onClose={() => setCloneOpen(false)} />
    </>
  );
}
