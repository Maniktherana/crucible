import { useState } from "react";

import { APP_BASE_NAME, APP_STAGE_LABEL } from "~/branding";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";

import { ManageRunsDialog } from "./ManageRunsDialog";
import { RepoSelector } from "./RepoSelector";

export function TopBar() {
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-border bg-card px-4">
      {/* Left: branding */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold tracking-tight">{APP_BASE_NAME}</span>
        <Badge variant="secondary" className="text-[10px]">
          {APP_STAGE_LABEL}
        </Badge>
      </div>

      {/* Center: repo selector */}
      <div className="mx-auto">
        <RepoSelector />
      </div>

      {/* Right: manage + status */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setManageOpen(true)}>
          Manage
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span>Connected</span>
        </div>
      </div>

      <ManageRunsDialog open={manageOpen} onOpenChange={setManageOpen} />
    </header>
  );
}
