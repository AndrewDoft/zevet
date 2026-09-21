/**
 * Saved prompts, on request.
 *
 * The library itself is `promptlib.tsx`. This is only the collapsed row that
 * holds it, so it follows the same rule as the meters and the turn detail:
 * closed by default, because the conversation is what the column is for.
 *
 * It is here rather than in the launcher because a prompt you reach for is one
 * you want while you are writing, not while you are choosing a model.
 */
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { PromptLibraryPanel } from "./promptlib";
import { selectActiveConsole, useBoard } from "../lib/board";

export function PromptShelf() {
  const active = useBoard(selectActiveConsole);
  const [open, setOpen] = useState(false);

  // Inserting a prompt writes into a console's draft, so without one there is
  // nothing for the library to do.
  if (!active) return null;

  return (
    <div className="prompt-shelf">
      <button
        type="button"
        className="run-meters-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon className="chev size-3.5 shrink-0 opacity-60" />
        <span>Prompts</span>
        <span className="spacer" />
      </button>
      {open ? (
        <div className="prompt-shelf-body">
          <PromptLibraryPanel />
        </div>
      ) : null}
    </div>
  );
}
