import { SendHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import type { CrucibleRun } from "./types";

interface CardChatComposerProps {
  run: CrucibleRun;
}

const DRAFT_STORAGE_KEY = (runId: string) => `crucible.composer.draft.${runId}`;

/**
 * Lightweight chat composer for sending mid-run messages to a running agent.
 * Posts to `POST /api/crucible/runs/:runId/message`; the server relays to the
 * OpenCode session and synthesizes a `user-message` event so the bubble
 * appears in the chat immediately.
 */
export function CardChatComposer({ run }: CardChatComposerProps) {
  const [draft, setDraft] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(DRAFT_STORAGE_KEY(run.id)) ?? "";
    } catch {
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Persist the draft per run id so switching tabs doesn't eat it.
  useEffect(() => {
    try {
      if (draft) window.localStorage.setItem(DRAFT_STORAGE_KEY(run.id), draft);
      else window.localStorage.removeItem(DRAFT_STORAGE_KEY(run.id));
    } catch {
      // Best-effort; no-op if storage is unavailable.
    }
  }, [draft, run.id]);

  // Auto-resize the textarea to fit its content (up to a reasonable cap).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 180);
    el.style.height = `${next}px`;
  }, [draft]);

  const runIsLive = run.status === "running" || run.status === "starting";

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !runIsLive) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/crucible/runs/${encodeURIComponent(run.id)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(body || `Send failed (${res.status})`);
      }
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }, [draft, run.id, runIsLive, sending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== "Enter") return;
      // Shift+Enter → newline (default). Enter or Cmd/Ctrl+Enter → send.
      if (e.shiftKey) return;
      e.preventDefault();
      void send();
    },
    [send],
  );

  const placeholder = runIsLive
    ? "Send the agent a note (Enter to send, Shift+Enter for newline)…"
    : `Run is ${run.status}; cannot send new messages.`;

  return (
    <div className="shrink-0 border-t bg-background/60 px-3 py-2">
      <div
        className={cn(
          "flex items-end gap-2 rounded-lg border border-border bg-background px-2 py-1.5",
          "focus-within:border-primary/50",
          !runIsLive && "opacity-60",
        )}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={!runIsLive || sending}
          rows={1}
          className="min-h-[28px] flex-1 resize-none bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
        />
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={!runIsLive || sending || !draft.trim()}
          className="h-7 shrink-0 px-2"
          title="Send (Enter). Shift+Enter for newline."
        >
          {sending ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <SendHorizontalIcon className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {error && <p className="mt-1 px-1 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
