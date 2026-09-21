/**
 * Searching what has already been said, on request.
 *
 * The two panels are in findviews.tsx; this is only the collapsed row that
 * holds them, following the same rule as the meters, the turn detail and the
 * prompt shelf: closed by default, because the conversation is what the column
 * is for and every one of these rows costs it height when it is open.
 *
 * Both panels live here rather than in the command palette because they are
 * reading rather than jumping — the palette runs an action and closes, and
 * these you sit with while you scroll the answer.
 */
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ConsoleFind, ThreadFind } from "./findviews";
import { selectActiveConsole, selectMyConsoles, useBoard } from "../lib/board";

export function FindShelf() {
  const active = useBoard(selectActiveConsole);
  const consoles = useBoard(selectMyConsoles);
  const [open, setOpen] = useState(false);

  /* ⚠️ COUNT THE TEXT, NOT THE MESSAGES. The first gate here was
     `messages < 2`, and against a real claude run the row never appeared:
     transcript.mjs keeps ONE assistant message open across a whole turn and
     appends parts to it, so a transcript with nine tool calls and six
     paragraphs in it is still `messages.length === 1`. What makes searching
     worth offering is that something has been said. */
  const messages = active?.transcript.messages ?? [];
  const words = messages.reduce((n, m) => {
    if (typeof m.content === "string") return n + m.content.length;
    if (!Array.isArray(m.content)) return n;
    return n + m.content.reduce((k, p) => k + (p.type === "text" ? p.text.length : 0), 0);
  }, 0);
  if (!active || words < 80) return null;

  return (
    <div className="find-shelf">
      <button
        type="button"
        className="run-meters-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon className="chev size-3.5 shrink-0 opacity-60" />
        <span>Find</span>
        <span className="spacer" />
        {/* The one number worth carrying on the closed row: how much there is
            to search, which is what makes searching worth opening. */}
        <span className="tabular-nums">
          {messages.length} {messages.length === 1 ? "message" : "messages"}
          {consoles.length > 1 ? ` · ${consoles.length} threads` : ""}
        </span>
      </button>

      {open ? (
        <div className="find-shelf-body">
          <ThreadFind />
          {/* Only worth the room when there is more than one thread to search
              across; with one console it is the panel above, twice. */}
          {consoles.length > 1 ? <ConsoleFind /> : null}
        </div>
      ) : null}
    </div>
  );
}
