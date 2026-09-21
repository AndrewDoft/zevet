/**
 * Two more views onto the active console, in the same spirit as
 * moreviews.tsx: read `useBoard(selectActiveConsole)` directly, render
 * nothing when there is nothing honest to show.
 *
 * ThreadMap wraps elements/conversation-map.tsx around the active console's
 * `transcript.messages`. ContextGauge wraps elements/context-display.tsx
 * around the active console's `usage`.
 */
import { useEffect, useState, type ComponentProps } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  ConversationMap,
  type ConversationMapEntry,
} from "./assistant-ui/elements/conversation-map";
import { ContextDisplay, type TokenUsage } from "./assistant-ui/elements/context-display";
import { selectActiveConsole, useBoard } from "../lib/board";

/** Same fallback window runmeters.tsx bars context against, for a console
 *  that hasn't reported its real one (ConsoleUsage.window, lib/types.ts) —
 *  the smallest common window rather than an invented per-model number. Not
 *  exported from runmeters.tsx, duplicated here per house style (see
 *  moreviews.tsx's reader helpers). */
const CONTEXT_LIMIT = 200_000;

/* ---------------------------------------------------------------------------
 * ThreadMap — one tick per transcript message, addressed by the
 * `data-message-id` MessagePrimitive.Root actually renders (see
 * @assistant-ui/react's MessageRoot.js), which is the one honest hook this
 * board has into "which DOM node is this message".
 * ------------------------------------------------------------------------- */

const messageSelector = (id: string) => `[data-message-id="${CSS.escape(id)}"]`;

function textOf(content: ThreadMessageLike["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

function toolNames(content: ThreadMessageLike["content"]): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is { type: "tool-call"; toolName: string } => p.type === "tool-call")
    .map((p) => p.toolName);
}

const roleLabel = (role: ThreadMessageLike["role"]) =>
  role === "user" ? "You" : role === "assistant" ? "Assistant" : "System";

const firstWords = (text: string, n: number) =>
  text.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");

/** title = role plus a few words of what's actually in the message; preview
 *  = a longer slice of the same text. An assistant turn with no text (all
 *  tool calls) titles on the tool names instead — never a made-up summary. */
function labelFor(m: ThreadMessageLike): ConversationMapEntry {
  const role = roleLabel(m.role);
  const text = textOf(m.content).trim();
  if (text) {
    return { id: m.id ?? "", title: `${role}: ${firstWords(text, 6)}`, preview: text.slice(0, 280) };
  }
  const tools = toolNames(m.content);
  if (tools.length) {
    return { id: m.id ?? "", title: `${role}: ${tools.join(", ")}` };
  }
  return { id: m.id ?? "", title: role };
}

export function ThreadMap({
  side = "right",
  className,
}: {
  side?: "left" | "right";
  className?: string | undefined;
}) {
  const active = useBoard(selectActiveConsole);
  const messages = active?.transcript.messages ?? [];

  const entries = messages
    .filter((m): m is ThreadMessageLike & { id: string } => Boolean(m.id))
    .map(labelFor);

  // The message being streamed into, if the console is running; otherwise the
  // most recent one. Both are real positions the transcript already tracks
  // (transcript.mjs's `openIndex`), not a guess at what the user is reading.
  const openIndex = active?.transcript.openIndex ?? -1;
  const activeEntry =
    openIndex >= 0 ? messages[openIndex] : messages[messages.length - 1];
  const activeId = activeEntry?.id;

  const idsKey = entries.map((e) => e.id).join(",");
  const [visibleIds, setVisibleIds] = useState<string[]>([]);

  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (!ids.length) {
      setVisibleIds([]);
      return;
    }
    const nodes = ids
      .map((id) => document.querySelector<HTMLElement>(messageSelector(id)))
      .filter((el): el is HTMLElement => el != null);
    if (!nodes.length) return;

    const root = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    const observer = new IntersectionObserver(
      (observed) => {
        setVisibleIds((prev) => {
          const set = new Set(prev);
          for (const o of observed) {
            const id = (o.target as HTMLElement).dataset["messageId"];
            if (!id) continue;
            if (o.isIntersecting) set.add(id);
            else set.delete(id);
          }
          return Array.from(set);
        });
      },
      { root, threshold: 0.4 },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [idsKey]);

  if (entries.length < 3) return null;

  return (
    <ConversationMap
      entries={entries}
      activeId={activeId}
      visibleIds={visibleIds}
      onSelect={(id) =>
        document
          .querySelector<HTMLElement>(messageSelector(id))
          ?.scrollIntoView({ behavior: "smooth", block: "center" })
      }
      side={side}
      className={className}
    />
  );
}

/* ---------------------------------------------------------------------------
 * ContextGauge — the active console's own usage, against the shared window.
 * ------------------------------------------------------------------------- */

export function ContextGauge({
  side,
  className,
}: {
  side?: ComponentProps<typeof ContextDisplay.Bar>["side"];
  className?: string | undefined;
}) {
  const active = useBoard(selectActiveConsole);
  const context = active?.usage.context;
  if (active == null || context == null) return null;

  // ConsoleUsage (src/lib/types.ts) carries `context` and `cacheHit` — the
  // numbers the strip has always shown — but not the raw input/cachedInput/
  // output counts usageOf() reads off each payload; recordUsage() in board.ts
  // does not carry them onto ConsoleUsage. So only totalTokens is real here;
  // inputTokens/cachedInputTokens/outputTokens stay unset rather than being
  // recovered from cacheHit's rounded percentage. reasoningTokens is left
  // unset too — none of the three CLIs reports it.
  const usage: TokenUsage = { totalTokens: context };

  return (
    <ContextDisplay.Bar
      usage={usage}
      modelContextWindow={active.usage.window ?? CONTEXT_LIMIT}
      resetKey={String(active.key)}
      side={side}
      className={className}
    />
  );
}
