import { useCallback, useEffect, useState } from "react";

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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";

import type { CrucibleIssue, CrucibleRepo } from "./types";
import { useCrucibleStore } from "./useCrucibleStore";

const MOCK_REPOS: CrucibleRepo[] = [
  {
    name: "Maniktherana/manikrana.dev",
    path: "/tmp/crucible/Maniktherana/manikrana.dev",
    hasGit: true,
  },
];

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

async function fetchRepos(): Promise<CrucibleRepo[]> {
  try {
    const res = await fetch("/api/crucible/repos");
    if (!res.ok) throw new Error("fetch failed");
    const data = (await res.json()) as { repos: CrucibleRepo[] };
    return data.repos;
  } catch {
    return MOCK_REPOS;
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
    return MOCK_ISSUES;
  }
}

async function cloneRepo(url: string): Promise<CrucibleRepo> {
  const res = await fetch("/api/crucible/repos/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error("clone failed");
  return (await res.json()) as CrucibleRepo;
}

export function RepoSelector() {
  const { selectedRepo, repos, setSelectedRepo, setRepos, setIssues } = useCrucibleStore();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);

  // Load repos on mount
  useEffect(() => {
    void fetchRepos().then((fetched) => {
      setRepos(fetched);
      if (!useCrucibleStore.getState().selectedRepo && fetched.length > 0) {
        const first = fetched[0]!;
        setSelectedRepo(first.name);
      }
    });
  }, [setRepos, setSelectedRepo]);

  // Fetch issues when selectedRepo changes
  useEffect(() => {
    if (!selectedRepo) return;
    void fetchIssues(selectedRepo).then(setIssues);
  }, [selectedRepo, setIssues]);

  const handleRepoChange = useCallback(
    (value: string | null) => {
      if (value === "__clone__") {
        setCloneOpen(true);
        return;
      }
      setSelectedRepo(value);
    },
    [setSelectedRepo],
  );

  const handleClone = useCallback(async () => {
    if (!cloneUrl.trim()) return;
    setCloning(true);
    try {
      const repo = await cloneRepo(cloneUrl.trim());
      const refreshed = await fetchRepos();
      setRepos(refreshed);
      setSelectedRepo(repo.name);
      setCloneUrl("");
      setCloneOpen(false);
    } catch {
      // Clone failed — stay on dialog so user can retry
    } finally {
      setCloning(false);
    }
  }, [cloneUrl, setRepos, setSelectedRepo]);

  return (
    <>
      <Select value={selectedRepo ?? ""} onValueChange={handleRepoChange}>
        <SelectTrigger size="sm" variant="ghost" className="min-w-48 max-w-64">
          <SelectValue placeholder="Select a repository" />
        </SelectTrigger>
        <SelectPopup>
          {repos.map((repo) => (
            <SelectItem key={repo.name} value={repo.name}>
              {repo.name}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value="__clone__">Clone a repository...</SelectItem>
        </SelectPopup>
      </Select>

      <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
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
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button disabled={cloning || !cloneUrl.trim()} onClick={() => void handleClone()}>
              {cloning ? <Spinner /> : "Clone"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
