/**
 * What the process itself said, as opposed to what the agent said.
 *
 * ⚠️ WHY THIS EXISTS. `ConsoleEntry.lines` has been recorded since the console
 * did, and its comment claimed it was "still rendered by the raw terminal
 * block" — a view that was replaced by the registry Thread several releases
 * ago. So nothing showed it, and stderr reached the screen only because
 * board.ts appended it to the OPEN ASSISTANT MESSAGE. Running a real codex
 * turn through the board made that unmissable: the agent's first answer was
 *
 *     2026-09-21T03:31:18Z ERROR rmcp::transport::worker: worker quit with
 *     fatal: Transport channel closed, when AuthRequired(…)
 *
 * — a GitHub MCP server, belonging to codex's own configuration, failing to
 * authenticate, presented as the model's reply to a question about test
 * flakiness.
 *
 * So: stderr goes here, labelled, and the transcript above carries only what
 * the agent actually produced. Nothing is dropped; the noise is just no longer
 * wearing the agent's voice.
 */
import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { TerminalBlock } from "./assistant-ui/elements/terminal-block";
import { selectActiveConsole, useBoard } from "../lib/board";

/** The kinds worth showing here. `out` and `tool` are the agent's own stream
 *  and are already rendered properly by the Thread; showing them again would
 *  be the duplicate this panel exists to avoid. */
const NOISE = new Set(["err", "meta"]);

export function RawOutput() {
  const active = useBoard(selectActiveConsole);
  const [open, setOpen] = useState(false);

  const lines = (active?.lines ?? []).filter((l) => NOISE.has(l.kind) && l.text.trim());
  // A clean run has none of this, and that is the normal case.
  if (!active || !lines.length) return null;

  const errors = lines.filter((l) => l.kind === "err").length;
  const shown = lines.slice(-200).map((l) => l.text);

  return (
    <div className="raw-output">
      <button
        type="button"
        className="run-meters-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon className="chev size-3.5 shrink-0 opacity-60" />
        <span>Process output</span>
        <span className="spacer" />
        {/* Errors are the reason anybody opens this, so they are the count on
            the closed row rather than the total line count. */}
        <span className="tabular-nums">
          {errors ? `${errors} on stderr` : `${lines.length} ${lines.length === 1 ? "line" : "lines"}`}
        </span>
      </button>

      {open ? (
        <div className="raw-output-body">
          <TerminalBlock
            className="max-w-none"
            command={`${active.agent} — stderr and process notes`}
            lines={shown}
            visibleCount={shown.length}
            // `done` is about the PROCESS, not about a command — there is no
            // command here, only the tail of whatever the CLI wrote while it
            // ran. A live console is not done.
            done={!active.running}
          />
        </div>
      ) : null}
    </div>
  );
}
