/**
 * The "You" section of the rail: which agents you have running.
 *
 * This file used to be the whole console UI — head, output, composer, launcher
 * — rendered twice, once in the rail and once in the conversation column. The
 * conversation column is the assistant-ui Thread now, so the rail's job is
 * navigation: which threads exist, which is in front, and what each is doing.
 *
 * It is zevet's own list rather than the registry ThreadList, and the reason is
 * in the row below: a console carries a posture, a stop button and a process
 * state, none of which a generic thread row has anywhere to put. What IS the
 * registry's is the AgentStatus pill on each row, so "working / done / failed"
 * reads the same here as everywhere else.
 * Starting an agent lives in the conversation column (see launcher.tsx), which
 * is where there is room to choose one.
 */
import { AgentStatus, type AgentState } from "./assistant-ui/elements/agent-status";
import { AgentLogo } from "./brand";
import { ghostButton, mono } from "./assistant-ui/elements/surfaces";
import { cn } from "@/lib/utils";
import { MODE_LABEL } from "../lib/constants";
import { selectActiveConsole, selectMyConsoles, useBoard } from "../lib/board";
import { bridge } from "../lib/bridge";
import type { ConsoleEntry } from "../lib/types";

/**
 * What this console was asked to do, for the row's second line.
 *
 * ⚠️ WITHOUT THIS, TWO CONSOLES ARE THE SAME ROW. The row says agent, state
 * and posture, so two claude consoles on Auto read "working claude Auto"
 * twice and the only difference on screen is the 2px hue on the left edge.
 * Measured with two running 2026-09-21; the rail is how you choose a thread,
 * and it could not tell them apart.
 *
 * ThreadMessageLike allows `content` to be a bare string, which has no parts —
 * the same shape trap RunMeterCard's tool count works around.
 */
function taskOf(c: ConsoleEntry): string {
  const first = c.transcript.messages.find((m) => m.role === "user");
  if (!first) return "";
  const text =
    typeof first.content === "string"
      ? first.content
      : first.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join(" ");
  return text.replace(/\s+/g, " ").trim();
}

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
  const task = taskOf(c);

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
        {/* 12px, in the console's own colour. The row is 180px at its
            narrowest and the elapsed slot was removed for exactly that
            reason, so this is deliberately smaller than the icon that cost
            the name its last five characters. */}
        <AgentLogo agent={c.agent} model={c.model} hue={c.hue} className="console-row-logo size-3" />
        <AgentStatus className="console-row-status" state={state} label={c.agent} trailing={null} />
        <span className={cn(mono, "console-row-mode")} data-danger={String(c.mode === "dangerous")}>
          {MODE_LABEL[c.mode] || c.mode}
        </span>
        {/* `title` and not a tooltip component: the row is 180px at its
            narrowest, so the line is always truncated and the full prompt has
            to be readable somehow.

            Always rendered, empty or not: a console started from the launcher
            has no prompt yet, and letting the line appear when the first one
            arrives would grow the row under the pointer. Reserving it is the
            same trick .chat-underline uses. */}
        <span className="console-row-task" title={task || undefined}>
          {task}
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

  if (!bridge.local) return null;

  return (
    <>
      {consoles.map((c) => (
        <ConsoleRow c={c} key={c.key} />
      ))}
      {/* ⚠️ THE "Start an agent…" ROW IS GONE FROM HERE. It was a full text
          row of the rail spent on a verb, under a heading that is already
          about starting things. Andrew: "there is also no need for like the
          new agent thing, you can put a plus sign somewhere else." The plus is
          in the People header now — App.tsx § RailHead — which is one line
          higher and costs no row at all. */}
    </>
  );
}
