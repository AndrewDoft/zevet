/**
 * The "You" section of the rail: which agents you have running.
 *
 * This file used to be the whole console UI — head, output, composer, launcher
 * — rendered twice, once in the rail and once in the conversation column. The
 * conversation column is the assistant-ui Thread now, so the rail's job is
 * navigation: which threads exist, which is in front, and what each is doing.
 *
 * It is the registry ThreadList over `myConsoles`, with an AgentStatus pill per
 * row so "working / done / failed" reads the same here as everywhere else.
 * Starting an agent lives in the conversation column (see launcher.tsx), which
 * is where there is room to choose one.
 */
import { AgentStatus, type AgentState } from "./assistant-ui/elements/agent-status";
import { ghostButton, mono } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { MODE_LABEL } from "../lib/constants";
import { selectActiveConsole, selectLaunching, selectMyConsoles, useBoard } from "../lib/board";
import { bridge } from "../lib/bridge";
import type { ConsoleEntry } from "../lib/types";

/** A console's state in the element's vocabulary. `running` is the process, so
 *  an agent that has finished speaking but not exited still reads as working —
 *  the same rule the runtime's isRunning follows. */
function stateOf(c: ConsoleEntry): AgentState {
  if (c.error) return "failed";
  if (c.running) return "working";
  const last = c.transcript.messages[c.transcript.messages.length - 1];
  return last && last.status && last.status.type === "incomplete" ? "failed" : "done";
}

function ConsoleRow({ c }: { c: ConsoleEntry }) {
  const active = useBoard(selectActiveConsole);
  const setActiveConsole = useBoard((s) => s.setActiveConsole);
  const closeConsole = useBoard((s) => s.closeConsole);
  const isActive = active?.key === c.key;
  const state = stateOf(c);

  return (
    <div
      className="console-row"
      style={{ ["--who" as string]: `var(--who-${c.hue})` }}
      data-active={String(isActive)}
    >
      <button
        type="button"
        className="console-row-pick"
        aria-current={isActive ? "true" : undefined}
        onClick={() => setActiveConsole(c.key)}
      >
        {/* No `elapsed`: that slot renders a 23px trailing icon even when it
            is empty, which in a 180px rail left the name 38px and printed
            "clau…". The model is on the thread title and in the strip. */}
        {/* `trailing={null}` suppresses the element's default, which is a
            Pause icon while working and a Retry icon when done. zevet can stop
            a console — the button to the right of this does — but it cannot
            pause or re-run one, and an affordance that does nothing is the
            same mistake as ToolError's Retry. */}
        <AgentStatus className="console-row-status" state={state} label={c.agent} trailing={null} />
        <span className={cn(mono, "console-row-mode")} data-danger={String(c.mode === "dangerous")}>
          {MODE_LABEL[c.mode] || c.mode}
        </span>
      </button>
      <button
        type="button"
        className={cn(ghostButton, "console-row-close")}
        onClick={() => closeConsole(c.key)}
        aria-label={(c.running ? "Stop " : "Close ") + c.agent}
      >
        {c.running ? "Stop" : "Close"}
      </button>
      {c.error ? <div className="console-row-err">{c.error}</div> : null}
    </div>
  );
}

export function Consoles() {
  const consoles = useBoard(selectMyConsoles);
  const launching = useBoard(selectLaunching);
  const openLauncher = useBoard((s) => s.openLauncher);
  const localRoot = useBoard((s) => s.localRoot);

  if (!bridge.local) return null;

  return (
    <>
      {consoles.map((c) => (
        <ConsoleRow c={c} key={c.key} />
      ))}
      {localRoot ? (
        <button
          type="button"
          className="console-new"
          aria-pressed={launching}
          onClick={openLauncher}
        >
          {consoles.length ? "Start another…" : "Start an agent…"}
        </button>
      ) : null}
    </>
  );
}
