import { TerminalIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { CrucibleRunEvent } from "./types";

interface SessionChatViewProps {
  events: CrucibleRunEvent[];
}

interface MessagePartPayload {
  type?: string;
  text?: string;
  toolName?: string;
  tool?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
}

function asPartPayload(payload: unknown): MessagePartPayload {
  if (!payload || typeof payload !== "object") return {};
  return payload as MessagePartPayload;
}

function extractCommand(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    if (typeof rec.command === "string") return rec.command;
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }
  return String(input ?? "");
}

function truncate(value: unknown, limit = 800): string {
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else {
    try {
      str = JSON.stringify(value, null, 2) ?? "";
    } catch {
      str = String(value ?? "");
    }
  }
  return str.length > limit ? `${str.slice(0, limit)}\n…[${str.length - limit} more chars]` : str;
}

export function SessionChatView({ events }: SessionChatViewProps) {
  const messageEvents = events.filter((e) => e.type === "message.part.updated");

  if (messageEvents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
        No chat messages yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {messageEvents.map((event) => {
        const payload = asPartPayload(event.payload);
        const partType = payload.type ?? "unknown";

        if (partType === "text") {
          const text = payload.text ?? event.summary;
          return (
            <div key={event.id} className="rounded-lg bg-muted/30 p-3 text-sm">
              <div className="max-w-none leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-background [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[.85em] [&_p]:my-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-background [&_pre]:p-2 [&_pre]:text-xs">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
              </div>
            </div>
          );
        }

        if (partType === "tool-invocation" || partType === "tool-call") {
          const toolName = payload.toolName ?? payload.tool ?? payload.name ?? "tool";
          return (
            <div key={event.id} className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TerminalIcon className="h-3 w-3" />
                <span className="font-mono">{toolName}</span>
              </div>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                {extractCommand(payload.input)}
              </pre>
            </div>
          );
        }

        if (partType === "tool-result") {
          const output = payload.output ?? payload.result;
          return (
            <div key={event.id} className="ml-4 rounded-lg border bg-background/50 p-2">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                tool result
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">
                {truncate(output)}
              </pre>
            </div>
          );
        }

        if (partType === "reasoning") {
          const text = payload.text ?? event.summary;
          return (
            <details key={event.id} className="rounded-lg bg-muted/20 p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">Reasoning</summary>
              <p className="mt-2 text-sm whitespace-pre-wrap">{text}</p>
            </details>
          );
        }

        return null;
      })}
    </div>
  );
}
