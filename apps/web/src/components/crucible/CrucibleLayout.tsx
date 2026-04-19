import type { ReactNode } from "react";

import { SidebarProvider } from "~/components/ui/sidebar";

import { TopBar } from "./TopBar";

/**
 * Full-width Crucible layout. We still wrap children in SidebarProvider
 * because existing chat-thread routes use SidebarInset / SidebarTrigger
 * which expect that context to be present.
 */
export function CrucibleLayout({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider>
      <div className="flex h-screen w-full flex-col bg-background text-foreground">
        <TopBar />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </SidebarProvider>
  );
}
