import { ImageIcon, TerminalIcon } from "lucide-react";

import type { CrucibleRunEvent } from "./types";

interface AgentBrowserPreviewProps {
  event: CrucibleRunEvent;
}

const SCREENSHOT_RE = /agent-browser\s+screenshot\s+(?:--\S+\s+)*([^\s"'`]+\.(?:png|jpe?g|webp))/i;

/** Join summary + stringified payload for regex-based detection. */
function eventText(event: CrucibleRunEvent): string {
  let payloadStr = "";
  try {
    payloadStr = JSON.stringify(event.payload ?? "");
  } catch {
    payloadStr = String(event.payload ?? "");
  }
  return `${event.summary} ${payloadStr}`;
}

export function extractScreenshotPath(event: CrucibleRunEvent): string | null {
  const match = eventText(event).match(SCREENSHOT_RE);
  return match?.[1] ?? null;
}

export function extractSnapshotOutput(event: CrucibleRunEvent): string | null {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") return null;
  const candidate = (payload.output ?? payload.result ?? payload.stdout) as unknown;
  if (typeof candidate !== "string") return null;
  // Heuristic: agent-browser snapshot output contains [ref=...] tokens
  if (candidate.includes("[ref=") || candidate.includes("agent-browser snapshot")) {
    return candidate;
  }
  return null;
}

/** True when this event looks like an agent-browser interaction. */
export function detectAgentBrowserScreenshot(event: CrucibleRunEvent): boolean {
  const text = eventText(event);
  if (!text.includes("agent-browser")) return false;
  return text.includes("screenshot") || text.includes("snapshot") || text.includes("[ref=");
}

export function AgentBrowserPreview({ event }: AgentBrowserPreviewProps) {
  const screenshotPath = extractScreenshotPath(event);
  const snapshotOutput = extractSnapshotOutput(event);

  if (screenshotPath) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border">
        <div className="flex items-center gap-1 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
          <ImageIcon className="h-3 w-3" />
          <span>agent-browser screenshot</span>
          <span className="ml-auto truncate font-mono text-[10px] opacity-60">
            {screenshotPath}
          </span>
        </div>
        <img
          src={`/api/crucible/files?path=${encodeURIComponent(screenshotPath)}`}
          alt="Agent browser screenshot"
          className="max-h-72 w-full bg-background object-contain"
          onError={(e) => {
            // Hide broken images rather than showing the broken-image icon.
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
    );
  }

  if (snapshotOutput) {
    return (
      <div className="mt-2 overflow-hidden rounded-lg border">
        <div className="flex items-center gap-1 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
          <TerminalIcon className="h-3 w-3" />
          <span>agent-browser snapshot</span>
        </div>
        <pre className="max-h-48 overflow-auto bg-background p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {snapshotOutput}
        </pre>
      </div>
    );
  }

  return null;
}
