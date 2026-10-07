/**
 * Every running agent, with the detail Andrew wants and the People pane
 * deliberately does not carry: engine, current tool, elapsed time, tokens.
 * A SEPARATE panel rather than an addition to people.tsx -- Andrew was
 * explicit that People stays lean ("there's no need in this People thing on
 * the side to show any sort of tool use, I think that just takes up too much
 * space", see components/people.tsx's own header comment). This is the place
 * for that detail instead, covering both consoles the board's own UI started
 * and ones a terminal spawned through the local control API
 * (desktop/agent-api.js) -- both land in the same `myConsoles` store, so
 * there is nothing here that distinguishes how a console was started.
 *
 * Collapsed to a small pill by default so it costs nothing when nobody is
 * watching; a running count is the only thing shown until it is opened.
 */
import { useEffect, useRef, useState } from "react";
import { selectMyConsoles, serverNow, useBoard } from "../lib/board";
import { ago, tokens } from "../lib/fmt";
import { turnInFlight } from "../lib/transcript.mjs";
import type { ConsoleEntry } from "../lib/types";

/** The last tool call in the transcript's own content parts -- the same
 *  assistant-ui shape addToolCall() in lib/transcript.mjs builds, read
 *  rather than re-derived from the raw event stream a second time. */
function currentToolOf(entry: ConsoleEntry): string | null {
  const messages = entry.transcript?.messages;
  if (!messages || !messages.length) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  const content = Array.isArray(last.content) ? last.content : [];
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as { type?: string; toolName?: string };
    if (part && part.type === "tool-call" && typeof part.toolName === "string") return part.toolName;
  }
  return null;
}

/** working = a turn is in flight; idle = the process is up waiting for a
 *  follow-up (the control API's `state`, desktop/console-log.js). */
export function agentStateOf(entry: ConsoleEntry): "working" | "idle" {
  return entry.transcript && turnInFlight(entry.transcript) ? "working" : "idle";
}

export function SubagentsPanel() {
  const consoles = useBoard(selectMyConsoles);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => serverNow());

  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Sit above the composer, not over its Context and send buttons: lift by
    // however much of the composer is on screen (it grows with the draft).
    const lift = () => {
      const c = document.querySelector<HTMLElement>("[data-slot=\"aui_composer-shell\"]");
      const top = c ? c.getBoundingClientRect().top : window.innerHeight;
      panel.current?.style.setProperty("--composer-lift", Math.max(0, window.innerHeight - top) + "px");
    };
    const t = setInterval(() => {
      setNow(serverNow());
      lift();
    }, 1000);
    lift();
    window.addEventListener("resize", lift);
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", lift);
    };
  }, []);

  const visible = consoles.filter((c) => c.running || (c as ConsoleEntry & { integration?: unknown }).integration);
  const running = visible.filter((c) => c.running);
  if (!visible.length) return null;
  const working = running.filter((c) => agentStateOf(c) === "working").length;
  const idle = running.length - working;
  const summary = running.length ? (idle ? `${working} working · ${idle} idle` : `${working} working`) : "done";

  return (
    <div className="subagents-panel" data-open={open} ref={panel}>
      <button
        type="button"
        className="subagents-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${running.length} agent${running.length === 1 ? "" : "s"} running: ${summary}`}
      >
        <span className="subagents-dot" aria-hidden="true" />
        {summary}
      </button>
      {open ? (
        <div className="subagents-list" role="list">
          {visible.map((c) => {
            const integration = (c as ConsoleEntry & { integration?: { status: string; why?: string } }).integration;
            return (
            <div className="subagents-row" role="listitem" key={c.key} data-state={agentStateOf(c)}>
              <span className="subagents-name">{c.label || c.title || c.autoTitle || c.agent}</span>
              <span className="subagents-meta">
                {[c.agent, c.engine, c.model].filter(Boolean).join(" · ")}
              </span>
              <span className="subagents-tool">{integration ? (integration.status === "failed" ? `failed: ${integration.why}` : "integrated") : agentStateOf(c) === "idle" ? "idle" : currentToolOf(c) || "—"}</span>
              <span className="subagents-elapsed">{ago(now - c.startedAt)}</span>
              <span className="subagents-tokens">{c.usage.context != null ? tokens(c.usage.context) : "—"}</span>
            </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
