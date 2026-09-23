/**
 * Three "find" panels, in the same spirit as moreviews.tsx: read the board
 * directly, show only real matches, render nothing when there is nothing to
 * find.
 *
 *   ThreadFind    search the active console's own transcript
 *   ConsoleFind   search across every console, to find which agent said it
 *   DraftRestore  offer back an unsent prompt after a reload
 *
 * Reader helpers (`toolCalls`/`textOf`/...) are duplicated from moreviews.tsx
 * rather than imported — that file does not export them, same reasoning as
 * moreviews.tsx gives for duplicating them from agentviews.tsx.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  selectActiveConsole,
  selectMyConsoles,
  useBoard,
} from "../lib/board";
import { zStorage } from "../lib/bridge";
import {
  ConversationSearch,
  type SearchHit,
} from "./assistant-ui/elements/conversation-search";
import { DraftRestore as DraftRestoreCard } from "./assistant-ui/elements/draft-restore";
import {
  ThreadSearch,
  type SearchableThread,
} from "./assistant-ui/elements/thread-search";

/* ---------------------------------------------------------------------------
 * READERS — pull searchable text out of a ThreadMessageLike.
 * ------------------------------------------------------------------------- */

interface ToolCallLike {
  type: "tool-call";
  toolName: string;
  args?: unknown;
}

function toolCalls(content: ThreadMessageLike["content"]): ToolCallLike[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p.type === "tool-call") as unknown as ToolCallLike[];
}

function textOf(content: ThreadMessageLike["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

function argsText(args: unknown): string {
  if (args == null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** Text parts plus tool names/arguments, flattened to one searchable string —
 *  matching "the text parts of each message and tool names/arguments" from
 *  the brief. */
function haystackOf(m: ThreadMessageLike): string {
  const tools = toolCalls(m.content)
    .map((c) => `${c.toolName} ${argsText(c.args)}`.trim())
    .join(" ");
  return [textOf(m.content), tools].filter(Boolean).join(" ");
}

/** The exact substring around a case-insensitive match, so a shown snippet is
 *  never invented — it is sliced straight out of the real haystack. */
function findHit(
  haystack: string,
  query: string,
  radius = 42,
): { before: string; match: string; after: string } | null {
  if (!query.trim()) return null;
  const at = haystack.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return null;
  return {
    before: haystack.slice(Math.max(0, at - radius), at),
    match: haystack.slice(at, at + query.length),
    after: haystack.slice(at + query.length, at + query.length + radius),
  };
}

function countHits(haystack: string, query: string): number {
  if (!query.trim()) return 0;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const at = h.indexOf(q, from);
    if (at === -1) break;
    count++;
    from = at + q.length;
  }
  return count;
}

/* ---------------------------------------------------------------------------
 * 1. ThreadFind — search inside the active console's own transcript.
 *
 * ThreadSearch (elements/thread-search.tsx) does its OWN substring filtering
 * against `${title} ${preview}`, so every eligible message is handed over
 * unfiltered and the element narrows the list as the query changes — the
 * same contract PromptLibrary relies on.
 *
 * Its per-row fields only leave room for three honest facts, which is
 * exactly what the brief asks for: `group` carries the message role,
 * `title` the live match count, `preview` the snippet around the hit (or a
 * plain excerpt while idle).
 *
 * NOT WIRED: onSelect. thread.aui.tsx renders no id/data attribute on a
 * message root and assistant-ui exposes no "scroll to message id" API here,
 * so there is nothing honest to scroll to — the list is read-only.
 * ------------------------------------------------------------------------- */

const NO_MESSAGES: readonly ThreadMessageLike[] = [];

export function ThreadFind() {
  const active = useBoard(selectActiveConsole);
  const [query, setQuery] = useState("");
  const messages = active?.transcript.messages ?? NO_MESSAGES;

  const threads = useMemo<SearchableThread[]>(() => {
    const out: SearchableThread[] = [];
    messages.forEach((m, i) => {
      const haystack = haystackOf(m);
      if (!haystack.trim()) return;
      const count = countHits(haystack, query);
      const hit = findHit(haystack, query);
      out.push({
        id: m.id ?? `m${i}`,
        group: m.role,
        title: count > 0 ? `${count} match${count === 1 ? "" : "es"}` : haystack.slice(0, 72),
        // ⚠️ NO PREVIEW WHILE IDLE. With no query there is no hit to show
        // context around, so both lines fell back to the same excerpt and
        // every row printed its own first sentence twice, one above the
        // other in two weights. A preview is the text AROUND a match; with no
        // match there is nothing for it to be.
        preview: hit ? `${hit.before}${hit.match}${hit.after}` : "",
      });
    });
    return out;
  }, [messages, query]);

  if (!threads.length) return null;

  return (
    <ThreadSearch threads={threads} query={query} activeId="" onQueryChange={setQuery} />
  );
}

/* ---------------------------------------------------------------------------
 * 2. ConsoleFind — search across every console: "which agent said that".
 *
 * ConversationSearch (elements/conversation-search.tsx) does NOT filter for
 * itself — `hits` is exactly what it shows — so the matching happens here,
 * across `s.myConsoles`, and SearchHit's only free-text field is `before`;
 * that is where the console's identity (agent + model) goes, prefixed onto
 * the real preceding text rather than replacing it.
 *
 * The element's one real interaction is `onStep` (prev/next, like Ctrl+F);
 * there is no per-hit click. Stepping to a hit is therefore treated as
 * "selecting" it, and calls the store's real `setActiveConsole`.
 * ------------------------------------------------------------------------- */

interface ConsoleHit extends SearchHit {
  consoleKey: number;
}

export function ConsoleFind() {
  const consoles = useBoard(selectMyConsoles);
  const setActiveConsole = useBoard((s) => s.setActiveConsole);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const hits = useMemo<ConsoleHit[]>(() => {
    if (!query.trim()) return [];
    const found: ConsoleHit[] = [];
    for (const c of consoles) {
      const label = c.model ? `${c.agent} · ${c.model}` : c.agent;
      c.transcript.messages.forEach((m, i) => {
        const hit = findHit(haystackOf(m), query);
        if (!hit) return;
        found.push({
          id: `${c.key}-${m.id ?? i}`,
          before: `${label} — ${hit.before}`,
          match: hit.match,
          after: hit.after,
          position: 0,
          consoleKey: c.key,
        });
      });
    }
    return found.map((h, i, arr) => ({
      ...h,
      position: arr.length > 1 ? (i / (arr.length - 1)) * 100 : 50,
    }));
  }, [consoles, query]);

  const index = hits.length ? Math.min(Math.max(activeIndex, 0), hits.length - 1) : 0;

  const step = (delta: number) => {
    if (!hits.length) return;
    const next = (index + delta + hits.length) % hits.length;
    setActiveIndex(next);
    setActiveConsole(hits[next]!.consoleKey);
  };

  const hasTranscript = consoles.some((c) => c.transcript.messages.length > 0);
  if (!hasTranscript) return null;

  return (
    <ConversationSearch
      query={query}
      hits={hits}
      activeIndex={index}
      onQueryChange={(q) => {
        setQuery(q);
        setActiveIndex(0);
      }}
      onStep={step}
    />
  );
}

/* ---------------------------------------------------------------------------
 * 3. DraftRestore — an unsent prompt survives a reload.
 *
 * zevet has no draft persistence today. The composer's live text is read and
 * written through assistant-ui's own client (`useAui`/`useAuiState`, the
 * same `aui.composer` scope `ComposerPrimitive.Input` renders from) rather
 * than the DOM, exactly as composer.tsx and runtime.tsx do.
 *
 * Storage goes through `zStorage` (lib/bridge.ts), which already guards a
 * browser that refuses storage — the panel must not go down over it, it just
 * never gets a draft back.
 * ------------------------------------------------------------------------- */

const DRAFT_KEY = "zevet.draft.v1";

interface DraftEntry {
  text: string;
  savedAt: number;
}

function loadDrafts(): Record<string, DraftEntry> {
  try {
    const raw = zStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveDrafts(drafts: Record<string, DraftEntry>): void {
  zStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
}

export function DraftRestore() {
  const active = useBoard(selectActiveConsole);
  const aui = useAui();
  const composerText = useAuiState((s) => s.composer.text);
  const composerEmpty = useAuiState((s) => s.composer.isEmpty);
  const key = active ? String(active.key) : null;

  const [offer, setOffer] = useState<DraftEntry | null>(null);

  // A fresh key (mount, or switching consoles) may have a leftover draft from
  // before a reload — surface it once, here; the render below only shows it
  // while the composer is still actually empty.
  useEffect(() => {
    setOffer(key ? (loadDrafts()[key] ?? null) : null);
  }, [key]);

  // Mirror the live composer text into storage as the user types. `sawText`
  // guards the very first effect run per key: without it, a console that
  // mounts with an empty composer (the normal case) would immediately wipe
  // the leftover draft the effect above just found, before it's ever shown.
  const sawText = useRef(false);
  useEffect(() => {
    sawText.current = false;
  }, [key]);
  useEffect(() => {
    if (!key) return;
    if (composerText) {
      sawText.current = true;
      const drafts = loadDrafts();
      drafts[key] = { text: composerText, savedAt: Date.now() };
      saveDrafts(drafts);
    } else if (sawText.current) {
      sawText.current = false;
      const drafts = loadDrafts();
      delete drafts[key];
      saveDrafts(drafts);
    }
  }, [key, composerText]);

  if (!active || !offer || !composerEmpty) return null;

  const savedAt = new Date(offer.savedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <DraftRestoreCard
      draft={offer.text}
      savedAt={savedAt}
      onRestore={() => {
        aui.composer.setText(offer.text);
        setOffer(null);
      }}
      onDiscard={() => {
        const drafts = loadDrafts();
        delete drafts[key!];
        saveDrafts(drafts);
        setOffer(null);
      }}
    />
  );
}
