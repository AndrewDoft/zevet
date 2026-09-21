/**
 * Two subtle buttons on either side of the chat box, and the cards they open.
 *
 * WHAT THIS REPLACES. Five collapsed rows stacked under the composer — turn
 * detail, find, read-aloud, prompts, meters — each of which pushed the chat
 * box up when opened. Andrew: "all of those dropdowns pop up under the
 * chatbox, which are all superfluous. delete what it did, find, and read
 * aloud. keep prompts but include a much more subtle button 'see past
 * prompts'. and keep the context stuff as well, but make both of them subtle
 * buttons that show up on either side of the chatbox and expand into tasteful
 * cards when clicked, not dropdowns."
 *
 * ⚠️ THE CARD IS AN OVERLAY, AND THAT IS THE WHOLE POINT. "the chatbox (and
 * all of the windows and stuff for that matter) should never change positions
 * or resize autonomously." A dropdown in the flow moves everything below it;
 * this is absolutely positioned above its own button, so opening one changes
 * nothing about where anything sits. The same rule the microphone's hint now
 * follows (styles/masora.css § .voice-hint) and the same one the mic bug was.
 *
 * The buttons live in the composer's action row — the left one beside the
 * model picker, the right one beside the send button — which is what "either
 * side of the chatbox" is, and costs no height at all.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { paper } from "./assistant-ui/elements/surfaces";

/**
 * A button and the card it opens above itself.
 *
 * `align` is which edge the card lines up with, so the left button's card
 * grows rightwards and the right button's grows leftwards and neither runs
 * off the column.
 */
function CardButton({
  label,
  title,
  align,
  children,
}: {
  label: string;
  title: string;
  align: "start" | "end";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Click-away and Escape, because a card with no way out that does not move
  // the page is a card you cannot get rid of.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="composer-card-wrap" ref={wrap}>
      <button
        type="button"
        className="composer-card-btn"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open ? (
        <div className={cn(paper, "composer-card")} data-align={align} role="dialog" aria-label={title}>
          <div className="composer-card-head">
            <span>{title}</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="composer-card-body">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

export function PastPromptsButton({ children }: { children: ReactNode }) {
  return (
    <CardButton label="See past prompts" title="Past prompts" align="start">
      {children}
    </CardButton>
  );
}

export function ContextCardButton({ children }: { children: ReactNode }) {
  return (
    <CardButton label="Context" title="Context and spend" align="end">
      {children}
    </CardButton>
  );
}
