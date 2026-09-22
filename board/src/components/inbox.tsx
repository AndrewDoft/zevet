/**
 * What happened while you were looking at something else.
 *
 * A run only belongs here once: the moment it stops being watched AND stops
 * running/erroring, then again never — clicking it (onCollect) moves you onto
 * it, which is itself "watching it", so it drops out on the next render via
 * the same activeConsole check every other row uses.
 */
import { useEffect, useRef, useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  BackgroundInbox as BackgroundInboxElement,
  type BackgroundRun,
  type BackgroundState,
} from "./assistant-ui/elements/background-inbox";
import { selectActiveConsole, selectMyConsoles, serverNow, useBoard } from "../lib/board";
import { agoText } from "../lib/text";
import { consoleBlurb } from "./people";
import type { ConsoleEntry } from "../lib/types";

function stateOf(c: ConsoleEntry): BackgroundState {
  if (c.running) return "running";
  const last = c.transcript.messages[c.transcript.messages.length - 1];
  return c.error || (last && last.status && last.status.type === "incomplete") ? "failed" : "ready";
}

/** The last thing the agent said, one line. `content` is a bare string for a
 *  plain message but an array of parts for one with tool calls mixed in —
 *  guard both, per the type error this already caused elsewhere (runmeters). */
function lastAssistantText(messages: ThreadMessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("");
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat) return flat.length > 100 ? flat.slice(0, 99).trimEnd() + "…" : flat;
  }
  return undefined;
}

export function BackgroundInbox() {
  const consoles = useBoard(selectMyConsoles);
  const active = useBoard(selectActiveConsole);
  const seenConsole = useBoard((s) => s.seenConsole);
  const setActiveConsole = useBoard((s) => s.setActiveConsole);
  const [now, setNow] = useState(() => serverNow());

  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);

  // board.ts timestamps when a console was last IN FRONT (seenConsole), never
  // when it finished — that fact is thrown away the instant `running` flips.
  // So this remembers, once per key, the first moment this component itself
  // saw a console go quiet; compared against seenConsole[key] that is an
  // honest "finished since you last looked", even though it is really
  // "since zevet's UI last looked" rather than the exact process-exit tick.
  const finishedAtRef = useRef<Map<number, number>>(new Map());
  for (const c of consoles) {
    /* ⚠️ FORGET THE STAMP WHILE IT RUNS, or a console is only ever reported
       ONCE. A console is not finished for good: asking it a follow-up flips
       `running` back on (board.ts § sendPrompt, the resume branch). The stamp
       used to be written only if the key was absent, so the second and every
       later completion kept the FIRST finish time — which by then is older
       than `seenConsole[key]`, because you have viewed the console since. The
       comparison below fails and the run is silently dropped from "what
       happened while you were looking at something else", which is the one
       thing this panel exists to say. */
    if (c.running) finishedAtRef.current.delete(c.key);
    else if (!finishedAtRef.current.has(c.key)) {
      finishedAtRef.current.set(c.key, Date.now());
    }
  }

  const activeKey = active?.key;
  const runs: BackgroundRun[] = consoles
    .filter((c) => {
      if (c.running || c.key === activeKey) return false;
      const finishedAt = finishedAtRef.current.get(c.key) ?? 0;
      return finishedAt > (seenConsole[c.key] ?? 0);
    })
    .map((c) => ({
      id: String(c.key),
      title: consoleBlurb(c),
      state: stateOf(c),
      elapsed: agoText(now, finishedAtRef.current.get(c.key) ?? now),
      summary: lastAssistantText(c.transcript.messages),
    }));

  if (!runs.length) return null;

  return (
    /* ⚠️ ITS OWN BOUNDED BOX. Unbounded, a long list of finished runs took
       the rail's height from the agent list and sat where its rows were;
       `.rail-inbox` caps it and scrolls it instead. */
    <BackgroundInboxElement
      className="rail-inbox"
      runs={runs}
      onCollect={(id) => setActiveConsole(Number(id))}
    />
  );
}
