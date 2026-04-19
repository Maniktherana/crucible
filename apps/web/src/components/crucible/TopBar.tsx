import { Badge } from "~/components/ui/badge";

import { RepoSelector } from "./RepoSelector";

export function TopBar() {
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

      {/* Right: status */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="h-2 w-2 rounded-full bg-green-500" />
        <span>Connected</span>
      </div>
    </header>
  );
}
