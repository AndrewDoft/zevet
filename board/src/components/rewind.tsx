/**
 * rewind.tsx — the fork capability (`forkConsole`, lib/board.ts) surfaced as
 * three assistant-ui elements: ask the same question again, ask it again
 * with different wording, and step between the answers that resulted.
 *
 * What a fork actually is, because all three components exist to say this
 * honestly: `claude --resume <id> --fork-session` and `codex exec fork <id>`
 * (both measured against the CLIs, see `ForkLaunch` in lib/board.ts) start a
 * BRAND NEW console from the END of a finished session, carrying its model
 * and posture. It is "ask again from here" — exact, and it leaves the
 * original run completely alone. It is NOT a rewind into the middle of a
 * conversation; neither CLI can do that, and nothing below may imply the
 * earlier exchange was undone or replaced.
 *
 * Reader helpers (`textOf`, `lastUserMessage`, `lastAssistantMessage`) are
 * duplicated from moreviews.tsx rather than imported — that file does not
 * export them, same reasoning moreviews.tsx itself gives for duplicating out
 * of agentviews.tsx.
 */
import { useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { forkConsole, selectActiveConsole, selectMyConsoles, useBoard } from "../lib/board";
import type { ConsoleEntry } from "../lib/types";
import { EditMessage } from "./assistant-ui/elements/edit-message";
import { MessageBranches } from "./assistant-ui/elements/message-branches";
import { mono } from "./assistant-ui/elements/surfaces";
import { RegenerateMenu, type RegenerateOption } from "./assistant-ui/elements/regenerate-menu";

function textOf(content: ThreadMessageLike["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

function lastUserMessage(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i];
  }
  return undefined;
}

function lastAssistantMessage(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i];
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * AskAgain — offer the last prompt back, to be forked verbatim or with a
 * real, honest variation appended to it.
 * ------------------------------------------------------------------------- */

/** Every option beyond "same" is a real suffix appended to the original
 *  prompt text — RegenerateMenu is not offered an option that would fork an
 *  identical run under a different name. "same" itself is not a no-op: the
 *  variation IS the fork (a second, independent attempt at the same ask),
 *  which is the whole point of a fork over a resume. */
const ASK_AGAIN_OPTIONS: readonly RegenerateOption[] = [
  { id: "same", label: "Ask again", detail: "same prompt" },
  { id: "shorter", label: "Shorter", detail: "+ brevity" },
  { id: "detailed", label: "More detail", detail: "+ depth" },
];

const ASK_AGAIN_SUFFIX: Record<string, string> = {
  same: "",
  shorter: " Answer in as few words as possible.",
  detailed: " Go into more depth and explain your reasoning.",
};

export function AskAgain() {
  const active = useBoard(selectActiveConsole);
  const [open, setOpen] = useState(false);
  const original = active ? textOf(lastUserMessage(active.transcript.messages)?.content) : "";

  // Nothing to re-ask without a session id to branch from, and forking a
  // live session would branch from a half-finished turn — the same guard
  // every fork-offering panel in this codebase applies (see forkConsole's
  // own doc comment).
  if (!active || !active.sessionId || active.running || !original) return null;

  return (
    <RegenerateMenu
      options={ASK_AGAIN_OPTIONS}
      open={open}
      // "same" stands in for "the phrasing already showing above" — nothing
      // has been picked yet, so this just names the baseline the variations
      // are relative to.
      currentId="same"
      onOpenChange={setOpen}
      onPick={(id) => {
        forkConsole(active.key, original + (ASK_AGAIN_SUFFIX[id] ?? ""));
        setOpen(false);
      }}
    />
  );
}

/* ---------------------------------------------------------------------------
 * EditAndAsk — the same, with the prompt editable first.
 * ------------------------------------------------------------------------- */

export function EditAndAsk() {
  const active = useBoard(selectActiveConsole);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const original = active ? textOf(lastUserMessage(active.transcript.messages)?.content) : "";

  if (!active || !active.sessionId || active.running || !original) return null;

  return (
    <div className="flex w-full max-w-sm flex-col items-end gap-1.5">
      {/* EditMessage's own copy just says "edit" — say what a save actually
          does, because an edit that looks like it rewrites history and does
          not is the exact lie this codebase keeps removing. */}
      <p className={`${mono} text-foreground/45`}>
        {editing ? "sends this as a new branch — the run above stays" : "branch with different wording"}
      </p>
      <EditMessage
        value={editing ? value : original}
        // A fork never replaces anything, so nothing is ever discarded by
        // sending — 0 is the honest count, not a placeholder.
        discardedReplies={0}
        editing={editing}
        onValueChange={setValue}
        onStartEdit={() => {
          setValue(original);
          setEditing(true);
        }}
        onCancel={() => setEditing(false)}
        onSave={() => {
          const text = value.trim();
          if (text) forkConsole(active.key, text);
          setEditing(false);
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Branches — step between the active console and the other consoles that
 * branch from the same original session.
 *
 * A lineage is a root console (`forkedFrom === null`) plus every console
 * whose `forkedFrom` chain reaches it. `sessionId` cannot do this grouping —
 * claude and codex both mint a brand-new session id for every forked run
 * (see the header comment above), so two branches of one question share
 * nothing the agent reports. `forkedFrom` (lib/types.ts) exists precisely
 * because that link cannot be recovered after the fact, only recorded at
 * fork time — `forkConsole` passes the source console's `key` as
 * `ForkLaunch.fromKey`, and `startAgent` writes it onto the new console as
 * `forkedFrom`.
 * ------------------------------------------------------------------------- */

/** Walks `forkedFrom` to the top of the chain and returns that key. If an
 *  ancestor has since been closed (removed from `myConsoles`), the walk
 *  stops at the last id it can still resolve — every console that branched
 *  through the same missing ancestor still resolves to that same id, so the
 *  group holds together even though the root console itself is gone. */
function rootKeyOf(byKey: Map<number, ConsoleEntry>, key: number): number {
  const seen = new Set<number>();
  let cur = key;
  while (!seen.has(cur)) {
    seen.add(cur);
    const parent = byKey.get(cur)?.forkedFrom;
    if (parent == null) return cur;
    cur = parent;
  }
  return cur;
}

export function Branches() {
  const consoles = useBoard(selectMyConsoles);
  const active = useBoard(selectActiveConsole);
  const setActiveConsole = useBoard((s) => s.setActiveConsole);

  if (!active) return null;

  const byKey = new Map(consoles.map((c) => [c.key, c] as const));
  const root = rootKeyOf(byKey, active.key);
  const group = consoles
    .filter((c) => rootKeyOf(byKey, c.key) === root)
    .sort((a, b) => a.startedAt - b.startedAt);
  // One answer is not a set of branches.
  if (group.length < 2) return null;

  const variants = group.map((c) => textOf(lastAssistantMessage(c.transcript.messages)?.content));
  const index = Math.max(0, group.findIndex((c) => c.key === active.key));

  return (
    <MessageBranches
      variants={variants}
      index={index}
      onIndexChange={(i) => {
        const target = group[i];
        if (target) setActiveConsole(target.key);
      }}
    />
  );
}
