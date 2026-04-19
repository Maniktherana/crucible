import { useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";

import type { CrucibleIssue, CrucibleRepo } from "./types";
import { useCrucibleStore } from "./useCrucibleStore";

async function fetchRepos(): Promise<CrucibleRepo[]> {
  try {
    const res = await fetch("/api/crucible/repos");
    if (!res.ok) throw new Error("fetch failed");
    const data = (await res.json()) as { repos: CrucibleRepo[] };
    return data.repos;
  } catch {
    return [];
  }
}

async function fetchIssues(repoName: string): Promise<CrucibleIssue[]> {
  try {
    const [owner, name] = repoName.split("/");
    const res = await fetch(`/api/crucible/repos/${owner}/${name}/issues`);
    if (!res.ok) throw new Error("fetch failed");
    const data = (await res.json()) as { issues: CrucibleIssue[] };
    return data.issues;
  } catch {
    return [];
  }
}

async function cloneRepo(url: string): Promise<CrucibleRepo> {
  const res = await fetch("/api/crucible/repos/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Clone failed (${res.status})`);
  }
  return (await res.json()) as CrucibleRepo;
}

interface CloneRepoDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CloneRepoDialog({ open, onClose }: CloneRepoDialogProps) {
  const { setRepos, setSelectedRepo, setIssues } = useCrucibleStore();
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClone = useCallback(async () => {
    if (!cloneUrl.trim()) return;
    setCloning(true);
    setError(null);
    try {
      const repo = await cloneRepo(cloneUrl.trim());
      const refreshed = await fetchRepos();
      setRepos(refreshed);
      setSelectedRepo(repo.name);
      void fetchIssues(repo.name).then(setIssues);
      setCloneUrl("");
      setError(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setCloning(false);
    }
  }, [cloneUrl, setRepos, setSelectedRepo, setIssues, onClose]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setError(null);
        setCloneUrl("");
        onClose();
      }
    },
    [onClose],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Clone Repository</DialogTitle>
          <DialogDescription>Enter a GitHub repository URL to clone.</DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-4">
          <Input
            placeholder="https://github.com/owner/repo"
            value={cloneUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCloneUrl(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === "Enter") void handleClone();
            }}
          />
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={cloning || !cloneUrl.trim()} onClick={() => void handleClone()}>
            {cloning ? <Spinner /> : "Clone"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
