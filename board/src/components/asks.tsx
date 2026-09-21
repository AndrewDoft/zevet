/**
 * Multiple-choice questions: an agent asks instead of expecting a typed
 * answer in the composer, and BLOCKS until one arrives — the loopback gate
 * holds its call open the same way it does for a computer-use permit.
 *
 * Copied from permits.tsx's PermitPrompt/PermitQueue shape: `s.asks` is
 * pushed to by board.ts's `onAskRequest` subscription and drained by
 * `answerAsk`, oldest first, one card shown at a time with the rest counted.
 * The one real difference is that a multi-select question needs several
 * clicks built up before it can answer, where permits.tsx's Allow/Deny
 * always answers on the first click.
 */
"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { field, inkButton, mono, paper } from "./assistant-ui/elements/surfaces";
import { answerAsk, selectActiveConsole, useBoard } from "../lib/board";

/** True while the keydown target is somewhere text is being typed, so the
 *  1-9/Enter shortcuts below don't steal a keystroke from the composer or
 *  any other field that happens to be focused while a question arrives. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function AskPrompt() {
  const ask = useBoard((s) => s.asks[0]);
  const agent = useBoard((s) => selectActiveConsole(s)?.agent);
  const [picked, setPicked] = useState<string[]>([]);

  // A newly-arrived question starts with nothing chosen. Keyed on the id
  // rather than run once, so the SAME card re-mounting for the next question
  // in the queue also clears whatever the previous question had picked.
  useEffect(() => {
    setPicked([]);
  }, [ask?.id]);

  useEffect(() => {
    if (!ask) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= ask.options.length) {
        e.preventDefault();
        const label = ask.options[n - 1].label;
        if (ask.multi) {
          setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
        } else {
          void answerAsk(ask.id, [label]);
        }
        return;
      }
      if (e.key === "Enter" && ask.multi && picked.length) {
        e.preventDefault();
        void answerAsk(ask.id, picked);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ask, picked]);

  if (!ask) return null;

  const choose = (label: string) => {
    if (!ask.multi) {
      // Single-select answers immediately — there is nothing to confirm.
      void answerAsk(ask.id, [label]);
      return;
    }
    setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  };

  return (
    <div
      data-slot="ask-prompt"
      className={cn(paper, "flex w-full max-w-sm flex-col gap-3 rounded-[20px] p-4")}
    >
      {/* ⚠️ THIS LINE IS THE WHOLE POINT OF THE CARD. Same reasoning as
          permits.tsx's PermitPrompt: the run does not continue until this is
          answered, and the ask-server denies on timeout — so leaving this
          card unlabeled would read as an ordinary chat prompt instead of the
          thing actually stopping the agent. */}
      <div className="flex items-center gap-2">
        <span className={cn(field, mono, "text-foreground/55 w-fit rounded-full px-2.5 py-1")}>
          {agent || "the agent"} is asking — blocked until answered
        </span>
      </div>

      {ask.header ? (
        <span className={cn(field, mono, "text-foreground/45 w-fit rounded-full px-2.5 py-1")}>
          {ask.header}
        </span>
      ) : null}

      <p className="text-foreground text-[13.5px] font-medium">{ask.question}</p>

      <div className="flex flex-col gap-1">
        {ask.options.map((opt, i) => {
          const active = ask.multi && picked.includes(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              aria-pressed={ask.multi ? active : undefined}
              onClick={() => choose(opt.label)}
              className={cn(
                "flex flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                active ? "bg-foreground/[0.09]" : "hover:bg-foreground/[0.06]",
              )}
            >
              <span className="flex items-baseline gap-2 text-[13px]">
                <span className={cn(mono, "text-foreground/30")}>{i + 1}</span>
                {opt.label}
              </span>
              {opt.description ? (
                <span className="text-foreground/45 text-xs">{opt.description}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {ask.multi ? (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!picked.length}
            onClick={() => void answerAsk(ask.id, picked)}
            className={cn(
              inkButton,
              "rounded-full px-3 py-1.5 text-xs font-medium disabled:pointer-events-none disabled:opacity-40",
            )}
          >
            Confirm{picked.length ? ` (${picked.length})` : ""}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* Counts the rest of the queue, same job PermitQueue does for permits. */
export function AskQueue() {
  const waiting = useBoard((s) => s.asks.length);
  if (waiting < 2) return null;

  return (
    <span className={cn(field, mono, "text-foreground/45 w-fit rounded-full px-2.5 py-1")}>
      +{waiting - 1} more waiting
    </span>
  );
}
