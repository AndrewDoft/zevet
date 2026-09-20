/**
 * The conversation column.
 *
 * This used to be `<Consoles agentView />`: a list of flat `.cline` divs with a
 * bare textarea under them. It is the registry Thread now, reading the
 * structured transcript through the external-store runtime — so tool calls,
 * their results, reasoning and markdown each render as themselves.
 *
 * What is NOT delegated: choosing an agent to start. assistant-ui's "new
 * thread" is one button because it assumes one model; zevet has three CLIs,
 * four permission postures and a model per CLI, and that choice is the product.
 */
import { Thread } from "./assistant-ui/elements/thread.aui";
import { ThinkingIndicator } from "./assistant-ui/elements/thinking-indicator";
import { EmptyState, EmptyStateGreeting } from "./assistant-ui/elements/empty-state";
import { useEffect, useState } from "react";
import { selectActiveConsole, selectMyConsoles, useBoard } from "../lib/board";
import { bridge } from "../lib/bridge";
import { Launcher } from "./launcher";
import { RunMeters } from "./runmeters";

function Blank({ title, note }: { title: string; note: string }) {
  return (
    <EmptyState className="mx-auto py-10">
      <EmptyStateGreeting>{title}</EmptyStateGreeting>
      <p className="text-muted-foreground -mt-4 text-center text-[13.5px]">{note}</p>
    </EmptyState>
  );
}

/**
 * The gap between sending a prompt and the first token.
 *
 * An agent CLI resolves its binary, loads its config, reads the repo and talks
 * to a provider before it emits anything. On a cold start that is several
 * seconds of a pane that has just gone quiet, which is indistinguishable from
 * a console that has hung — and zevet's whole job is telling you what an agent
 * is doing. The elapsed count is the part that makes it readable as waiting
 * rather than as broken.
 */
function Thinking() {
  const active = useBoard(selectActiveConsole);
  const messages = active?.transcript.messages ?? [];
  const last = messages[messages.length - 1];

  /* ⚠️ THE WINDOW IS BEFORE THE TURN OPENS, NOT INSIDE IT.
     The first version asked for "a turn is open and has said nothing", and it
     never rendered once — transcript.mjs opens an assistant message on the
     agent's FIRST payload, and that payload always carries something. The
     silence worth reporting is the other side of that: the prompt has gone and
     the agent has not answered yet. That is , with the last message
     still the user's, or a console that has started and said nothing at all. */
  const waiting =
    Boolean(active?.running) &&
    (active?.transcript.openIndex ?? -1) < 0 &&
    (!last || last.role === "user");
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!waiting) {
      setSince(null);
      return;
    }
    // Both, together: `now` was seeded at mount and `since` only when the
    // wait began, so the first frame rendered a NEGATIVE elapsed ("-1s")
    // until the first tick caught up.
    const started = Date.now();
    setSince((s) => s ?? started);
    setNow(started);
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [waiting]);

  if (!waiting) return null;
  const secs = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;

  return (
    <div className="thinking-row">
      <ThinkingIndicator label={`${active?.agent ?? "agent"} is working`} elapsed={`${secs}s`} />
    </div>
  );
}

export function Conversation() {
  const local = Boolean(bridge.local);
  const consoles = useBoard(selectMyConsoles);
  const active = useBoard(selectActiveConsole);

  if (!local) {
    return (
      <Blank
        title="Nothing running here."
        note="Start an agent from the desktop app to watch it work."
      />
    );
  }

  // No console selected — either none has been started, or "new thread" was
  // pressed. Either way the next thing to do is pick an agent.
  if (!active) {
    return (
      <div className="chat-launch">
        {consoles.length ? null : (
          <Blank
            title="Nothing running yet."
            note="Pick an agent and a posture. It runs on this machine, in the open repo."
          />
        )}
        <Launcher />
      </div>
    );
  }

  return (
    <div className="chat-thread">
      <div className="chat-thread-body">
        <Thread autoFocus={false} />
      </div>
      <Thinking />
      {/* Under the transcript, in the column that has room for it. The rail's
          strip keeps the same numbers at a glance. */}
      <RunMeters />
    </div>
  );
}
