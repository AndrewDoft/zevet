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
import { selectActiveConsole, useBoard } from "../lib/board";
import { bridge } from "../lib/bridge";
import { Launcher } from "./launcher";
import { VoiceHint } from "./voicedialog";
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
import { SessionBanner } from "./sessions";

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
  const active = useBoard(selectActiveConsole);
  const localRoot = useBoard((s) => s.localRoot);
  /** A session read off disk is in front of the live console. Everything that
   *  belongs to a RUN is hidden while it is: a posture notice, a quota window
   *  and a permit prompt all describe a process, and this conversation does
   *  not have one. */
  const reading = Boolean(useBoard((s) => s.sessions.open));

  if (!local) {
    return (
      <Blank
        title="Nothing running here."
        note="Start an agent from the desktop app to watch it work."
      />
    );
  }

  /* ⚠️ NO SEPARATE "PICK AN AGENT" SCREEN.
   *
   * This used to swap the whole column for a blank sentence plus the launcher
   * whenever no console was active. Andrew's words: "there is no way to start
   * right now" — because the sentence said to pick an agent and a posture, the
   * launcher under it rendered NOTHING when no folder was open, and the
   * composer was not on screen at all.
   *
   * The column is the chat now, always. The thread is there (empty, which is
   * what an empty conversation looks like), the composer is live, and pressing
   * Send starts the agent the picker names and asks it — see `onNew` in
   * lib/runtime.tsx. The pickers themselves went into the composer's action
   * row rather than a strip above it; see the note on that below. */
  return (
    <div className="chat-thread">
      {/* ⚠️ THE PICKERS ARE IN THE COMPOSER NOW, not in a strip above the
          transcript. Andrew's words about that strip: "not above in that weird
          way" — it read as a settings screen the conversation happened to sit
          under. components/composercontrols.tsx puts the model, the posture
          and the run's context in the composer's own action row, which is
          where you are already looking when you decide any of them.

          What is left here is the one thing that cannot go in a composer: with
          no folder open there is nowhere for an agent to run at all, and the
          answer to that is a folder picker, not a control. */}
      <SessionBanner />
      {!reading && !active && !localRoot ? (
        <div className="chat-setup">
          <Launcher />
        </div>
      ) : null}
      {/* What this console may and may not do, said once at the top rather
          than discovered when an edit does not land. The posture is a flag
          fixed at launch, so this is a standing fact about the run, not a
          state that changes under you. */}
      {reading ? null : <PostureNotice />}
      {/* The provider's own rate-limit windows, when the agent reports them.
          It is the one number that decides whether to start another run, so it
          is at the top rather than behind a row. */}
      {reading ? null : <QuotaNotice />}
      {/* An agent is BLOCKED on this. It goes above the transcript, not behind
          a row, because the run does not continue until it is answered — and
          the ask-server denies on timeout, so ignoring it is a refusal. */}
      {reading ? null : <PermitPrompt />}
      {reading ? null : <PermitQueue />}
      <div className="chat-thread-body">
        <Thread autoFocus={false} />
        {/* A tick per message down the right edge. It is the one thing that
            makes a long run navigable without scrolling it twice, and it costs
            no height — it sits inside the viewport, against the wall. */}
        <ThreadMap />
      </div>
      {/* ⚠️ THE DICTATION ORB IS GONE. It rendered an unstyled white
          rectangle at the bottom of this column the moment the mic was
          pressed — Andrew: "something goes up and it looks weird" — and it
          was driven by a Web Speech session that never worked in Electron
          anyway. Nothing replaces it as an indicator, because there is
          nothing in zevet to indicate: Masora Voice draws its own flow bar,
          in its own process, over every window. What IS left is one line
          saying which key to hold, because the mic starts the app and cannot
          start the recording. */}
      {reading ? null : <VoiceHint />}
      {/* Appears only while text is selected in the transcript. */}
      <QuoteToComposer />
      {/* A half-written prompt survives a reload now. Offered only while the
          composer is empty, so it never overwrites what you are typing. */}
      <DraftRestore />
      {reading ? null : <Thinking />}
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
