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
import { DictationOrb } from "./brand";
import { ListenShelf } from "./speech";
import { PostureNotice, QuoteToComposer } from "./guards";
import { QuotaNotice } from "./quota";
import { PermitPrompt, PermitQueue } from "./permits";
import { DraftRestore } from "./findviews";
import { FindShelf } from "./findshelf";
import { ThreadMap } from "./mapviews";
import { RunMeters } from "./runmeters";
import { TurnDetail } from "./turndetail";
import { PromptShelf } from "./promptshelf";

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
      {/* What this console may and may not do, said once at the top rather
          than discovered when an edit does not land. The posture is a flag
          fixed at launch, so this is a standing fact about the run, not a
          state that changes under you. */}
      <PostureNotice />
      {/* The provider's own rate-limit windows, when the agent reports them.
          It is the one number that decides whether to start another run, so it
          is at the top rather than behind a row. */}
      <QuotaNotice />
      {/* An agent is BLOCKED on this. It goes above the transcript, not behind
          a row, because the run does not continue until it is answered — and
          the ask-server denies on timeout, so ignoring it is a refusal. */}
      <PermitPrompt />
      <PermitQueue />
      <div className="chat-thread-body">
        <Thread autoFocus={false} />
        {/* A tick per message down the right edge. It is the one thing that
            makes a long run navigable without scrolling it twice, and it costs
            no height — it sits inside the viewport, against the wall. */}
        <ThreadMap />
      </div>
      {/* The mic is inside the composer, which is inside the Thread; this is
          the state of it, where there is room to see it. Renders nothing
          unless dictation is actually running. */}
      <DictationOrb />
      {/* Appears only while text is selected in the transcript. */}
      <QuoteToComposer />
      {/* A half-written prompt survives a reload now. Offered only while the
          composer is empty, so it never overwrites what you are typing. */}
      <DraftRestore />
      <Thinking />
      {/* Under the transcript, in the column that has room for it. The rail's
          strip keeps the same numbers at a glance. */}
      {/* Three collapsed rows, all closed. Everything here is derived from the
          transcript already on screen, and the conversation keeps its height —
          which is the lesson the run meters cost the first time. */}
      <TurnDetail />
      <FindShelf />
      {/* Speech out, behind a row. Speech in is the mic in the composer;
          neither is a voice session — both are the browser's own. */}
      <ListenShelf />
      <PromptShelf />
      <RunMeters />
    </div>
  );
}
