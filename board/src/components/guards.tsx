/**
 * Guards: real constraints and one real transcript capability, read straight
 * off the active console, in the same spirit as moreviews.tsx — each
 * component reads `useBoard` (and, for the selection, the DOM) itself and
 * renders nothing when it has nothing honest to show.
 */
"use client";

import { useEffect, useState } from "react";
import { unstable_useComposerInput } from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { GuardrailNotice } from "./assistant-ui/elements/guardrail-notice";
import { QuoteReply, type QuoteAction } from "./assistant-ui/elements/quote-reply";
import { selectActiveConsole, useBoard } from "../lib/board";
import { MODE_LABEL } from "../lib/constants";
import type { LaunchMode } from "../lib/types";

/* ---------------------------------------------------------------------------
 * PostureNotice — elements/guardrail-notice.tsx over the ACTIVE console's
 * `mode`. Real constraint: the posture is passed to the CLI as a launch flag
 * (desktop/agent-console.js's MODES table) and holds for that console's
 * whole life — there is no way to change it mid-run, so there is nothing
 * honest to offer as a "try instead" either.
 * ------------------------------------------------------------------------- */

/** Duplicated from launcher.tsx's MODE_NOTE, which is not exported — the same
 *  reasoning moreviews.tsx gives for its own duplicated readers. */
const MODE_NOTE: Record<LaunchMode, string> = {
  plan: "Reads and plans. Changes nothing.",
  ask: "Asks before each command or edit.",
  auto: "Edits files. Asks before commands.",
  dangerous: "Runs commands and edits files without asking.",
};

export function PostureNotice() {
  const mode = useBoard((s) => selectActiveConsole(s)?.mode);

  // `auto` is the one posture skipped: it still asks before every command —
  // the same gate `ask` uses for everything — and only auto-approves edits,
  // which is the ordinary behaviour anyone starting a coding agent already
  // expects. The other three are real departures from that baseline for the
  // console's whole life — plan freezes everything, ask gates everything,
  // dangerous removes every gate — so each earns a standing notice, and
  // dangerous (no asking at all) gets the loudest treatment below.
  if (!mode || mode === "auto") return null;

  return (
    <GuardrailNotice
      title={MODE_LABEL[mode] ?? mode}
      explanation={MODE_NOTE[mode]}
      policy={mode}
      alternatives={[]}
      className={cn(mode === "dangerous" && "border-destructive/50")}
    />
  );
}

/* ---------------------------------------------------------------------------
 * QuotaNotice — elements/quota-banner.tsx.
 *
 * NOT BUILT. See the report for why: QuotaBanner's `used`, `limit`, `unit`
 * and `resetsIn` are all REQUIRED props, and nothing zevet has ever reports
 * them for Anthropic's actual 5h/7d usage limits.
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * QuoteToComposer — elements/quote-reply.tsx. Real capability: the person
 * selects text in the transcript and quotes it into the next prompt.
 * ------------------------------------------------------------------------- */

/** QuoteReply's own icon set includes "explain" and "rewrite", but zevet has
 *  no explain/rewrite capability to wire to either — only quoting into the
 *  composer is real, so only that one action ships. */
const QUOTE_ACTIONS: readonly QuoteAction[] = [{ key: "quote", label: "Quote", icon: "quote" }];

/** How much real transcript text to show around the selection as `before`/
 *  `after` context — cosmetic only, never sent anywhere. */
const CONTEXT_CHARS = 80;

interface Selected {
  before: string;
  selection: string;
  after: string;
}

/** The live browser selection, scoped to the real transcript so a selection
 *  in the rail (or anywhere else on the page) does not count.
 *  `data-slot="aui_thread-viewport"` is thread.aui.tsx's own marker for that
 *  element. The composer's own draft lives in a `<textarea>`
 *  (ComposerPrimitive.Input), whose selection `window.getSelection()` never
 *  sees, so a selection made while typing the next prompt is excluded for
 *  free rather than needing its own check. */
function readSelection(): Selected | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (!text) return null;

  const viewport = document.querySelector('[data-slot="aui_thread-viewport"]');
  const anchor = sel.anchorNode;
  if (!viewport || !anchor || !viewport.contains(anchor)) return null;

  // before/after are real substrings of the message the selection came
  // from, read off its own text, not invented.
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const container = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const full = container?.textContent ?? text;
  const idx = full.indexOf(text);
  if (idx < 0) return { before: "", selection: text, after: "" };

  return {
    before: full.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
    selection: text,
    after: full.slice(idx + text.length, idx + text.length + CONTEXT_CHARS),
  };
}

export function QuoteToComposer() {
  const [selected, setSelected] = useState<Selected | null>(null);
  // The headless bridge to the active thread's own composer — see
  // composer.tsx/runtime.tsx: the real composer is ComposerPrimitive.Input
  // inside thread.aui.tsx, and this reads/writes the same underlying
  // ComposerRuntime rather than a second, disconnected input.
  const composer = unstable_useComposerInput();

  useEffect(() => {
    const onChange = () => setSelected(readSelection());
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  if (!selected) return null;

  return (
    <QuoteReply
      before={selected.before}
      selection={selected.selection}
      after={selected.after}
      actions={QUOTE_ACTIONS}
      toolbarVisible
      onAction={(key) => {
        if (key !== "quote") return;
        const block = selected.selection
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        composer.setText(`${block}\n\n${composer.value}`);
      }}
    />
  );
}
