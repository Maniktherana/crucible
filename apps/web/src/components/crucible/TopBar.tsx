import { useCallback, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";

import { RepoSelector } from "./RepoSelector";
import { useCrucibleStore } from "./useCrucibleStore";

export function TopBar() {
  const selectedRepo = useCrucibleStore((s) => s.selectedRepo);
  const setRuns = useCrucibleStore((s) => s.setRuns);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleReset = useCallback(async () => {
    if (!selectedRepo) return;
    setResetting(true);
    try {
      const response = await fetch(`/api/crucible/runs?repo=${encodeURIComponent(selectedRepo)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `Request failed with status ${response.status}`);
      }
      const data = (await response.json().catch(() => ({}))) as { deleted?: number };
      setRuns([]);
      toastManager.add({
        type: "success",
        title: "Crucible state cleared",
        description: `Removed ${data.deleted ?? 0} run(s). Run \`bun scripts/crucible-cleanup.ts --repo ${selectedRepo}\` to clean up PRs, branches, and worktrees.`,
      });
      setResetOpen(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Reset failed",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    } finally {
      setResetting(false);
    }
  }, [selectedRepo, setRuns]);

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-border bg-card px-4">
      {/* Left: branding */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold tracking-tight">Crucible</span>
        <Badge variant="secondary" className="text-[10px]">
          Alpha
        </Badge>
      </div>

      {/* Center: repo selector */}
      <div className="mx-auto">
        <RepoSelector />
      </div>

      {/* Right: reset + status */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={!selectedRepo}
          onClick={() => setResetOpen(true)}
        >
          Reset
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span>Connected</span>
        </div>
      </div>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset Crucible state for {selectedRepo ?? "this repo"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Clears in-memory run history on the server. To close PRs and remove branches and
              worktrees, run{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                bun scripts/crucible-cleanup.ts --repo {selectedRepo ?? "<owner/name>"}
              </code>{" "}
              afterward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={resetting}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={resetting || !selectedRepo}
              onClick={() => void handleReset()}
            >
              {resetting ? "Resetting..." : "Reset"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </header>
  );
}
