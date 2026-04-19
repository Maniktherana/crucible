import { useCallback, useEffect, useState } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import type { CrucibleIssue, CrucibleRepo } from "./types";
import { CloneRepoDialog } from "./CloneRepoDialog";
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

export function RepoSelector() {
  const { selectedRepo, repos, setSelectedRepo, setRepos, setIssues } = useCrucibleStore();
  const [cloneOpen, setCloneOpen] = useState(false);

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

      <CloneRepoDialog open={cloneOpen} onClose={() => setCloneOpen(false)} />
    </>
  );
}
