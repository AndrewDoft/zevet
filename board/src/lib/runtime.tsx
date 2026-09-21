/**
 * The board's agent consoles, as an assistant-ui runtime.
 *
 * zevet does not call a model. It spawns a CLI and reads its stdout, and the
 * transport for that — start, stream, prompt, stop — already exists and is not
 * changed by any of this. What was missing was a way to hand that stream to
 * assistant-ui, which is what `useExternalStoreRuntime` is for: the store stays
 * the source of truth and the runtime reads it.
 *
 * So the mapping is:
 *
 *     ConsoleEntry            a thread
 *     ConsoleEntry.transcript its messages
 *     myConsoles              the thread list
 *     sendPrompt              onNew
 *     stopConsole             onCancel
 *
 * The provider wraps the whole shell rather than just the chat column, because
 * the rail's agent cards and the strip's meters read thread state too.
 */
import { type PropsWithChildren, useEffect, useMemo, useRef } from "react";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  createMessageQueue,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { selectActiveConsole, selectMyConsoles, useBoard } from "./board";
import { bridge } from "./bridge";
import { MasoraVoiceDictationAdapter } from "./voice";
import { MULTI_TURN } from "./constants";
import { groupTurnTools } from "./turngroup.mjs";
import { parseLocal } from "./slash.mjs";
import { ToolUIs } from "../components/tools";
import type { ConsoleEntry } from "./types";

const NO_MESSAGES: ThreadMessageLike[] = [];

/** assistant-ui addresses threads by string id; consoles are keyed by number. */
const threadIdOf = (c: ConsoleEntry) => `console-${c.key}`;
const keyOfThreadId = (id: string) => Number(id.replace(/^console-/, ""));

/** What the thread list shows for a console. The model matters more than the
 *  agent name once two of the same agent are running. */
function titleOf(c: ConsoleEntry): string {
  const suffix = c.model ? ` · ${c.model}` : "";
  return `${c.agent}${suffix}`;
}

/**
 * The text of a message the composer just produced, INCLUDING its attachments.
 *
 * An agent CLI reads one thing: text on stdin. So an attached file is not a
 * side channel here — it has to become part of the prompt or it does not reach
 * the agent at all. SimpleTextAttachmentAdapter has already turned each one
 * into text content by the time this runs; this puts it in front of the
 * question, fenced and named, which is how a person would paste it.
 */
function textOf(message: AppendMessage): string {
  const typed = message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

  // SimpleTextAttachmentAdapter already wraps each one as
  // <attachment name="...">...</attachment>, verified against the adapter, so
  // it is passed through rather than labelled a second time.
  const attached = (message.attachments ?? []).flatMap((a) =>
    (a.content ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text),
  );

  return attached.length ? `${attached.join("\n\n")}\n\n${typed}`.trim() : typed;
}

export function ConsoleRuntimeProvider({ children }: PropsWithChildren) {
  const consoles = useBoard(selectMyConsoles);
  const active = useBoard(selectActiveConsole);
  const sendPrompt = useBoard((s) => s.sendPrompt);
  const stopConsole = useBoard((s) => s.stopConsole);
  const setActiveConsole = useBoard((s) => s.setActiveConsole);
  const openLauncher = useBoard((s) => s.openLauncher);
  const startAgent = useBoard((s) => s.startAgent);
  const launchAgent = useBoard((s) => s.launchAgent);
  const localRoot = useBoard((s) => s.localRoot);
  /** Everything a first prompt needs: a CLI to run and a folder to run it in. */
  const canStart = Boolean(launchAgent && localRoot);

  const threads = useMemo<readonly ExternalStoreThreadData<"regular">[]>(
    () =>
      consoles.map((c) => ({
        status: "regular" as const,
        id: threadIdOf(c),
        title: titleOf(c),
      })),
    [consoles],
  );

  /* DICTATION — MASORA VOICE, not the browser.
   *
   * ⚠️ THIS WAS `new WebSpeechDictationAdapter()`, and in Electron that API
   * has no backend: pressing the mic logged `Dictation error: network` and
   * flashed an unstyled white rectangle at the bottom of the conversation.
   * Andrew: "when i hit the microphone there is an issue, and something goes
   * up and it looks weird", and then what it should do instead — "it turns on
   * the masora voice flow bar. if masora voice is not downloaded, you get a
   * pop up to download it."
   *
   * The comment this replaces said Masora "needs nothing from zevet" and was
   * right about the mechanism — Masora Voice types into the focused field, so
   * no transcript comes back through this adapter — but wrong about the
   * conclusion: somebody has to turn it ON, and the mic is where a person
   * reaches for that. See lib/voice.ts and desktop/masora-voice.js.
   *
   * Built once, not per render, same as before. */
  const setVoiceAsk = useBoard((s) => s.setVoiceAsk);
  const setVoiceHotkey = useBoard((s) => s.setVoiceHotkey);
  const dictation = useMemo(
    () =>
      new MasoraVoiceDictationAdapter({
        onMissing: (url) => setVoiceAsk(url),
        onSaid: (line) => setVoiceHotkey(line),
      }),
    [setVoiceAsk, setVoiceHotkey],
  );

  /* A SESSION BEING READ REPLACES THE LIVE THREAD.
   *
   * It goes through the same runtime rather than a second renderer, because
   * every tool card, reasoning panel and markdown block is registered here —
   * a parallel read-only Thread would have none of them. What the session
   * turns OFF is everything that writes: no queue, no send, no cancel. The
   * composer stays visible and disabled rather than disappearing, so the
   * column does not change shape when you open a recording. */
  const openSession = useBoard((s) => s.sessions.open);
  const sessionMessages = useBoard((s) => s.sessions.openTranscript?.messages);
  const reading = Boolean(openSession);

  const raw = reading
    ? (sessionMessages ?? NO_MESSAGES)
    : (active?.transcript.messages ?? NO_MESSAGES);

  /* ONE TOOL-CALL DROPDOWN PER TURN, not ten. assistant-ui groups ADJACENT
   * tool calls, and an agent breaks adjacency constantly — measured on a real
   * session, 2,342 calls in 32 turns made 341 separate collapsed rows. See
   * lib/turngroup.mjs for what this trades away and why it is a view
   * transform rather than a change to the transcript itself.
   *
   * Memoised on `raw` because the runtime re-renders on every token and the
   * transform must not hand assistant-ui new message objects each time: it
   * memoises by reference, and re-mounting a dropdown closes it under you. */
  const messages = useMemo(() => groupTurnTools(raw) as ThreadMessageLike[], [raw]);
  /** An assistant message is open, so the agent is mid-answer. */
  const streaming = (active?.transcript.openIndex ?? -1) >= 0;
  const oneShot = Boolean(active) && !MULTI_TURN.has(active!.agent);
  /* ⚠️ ONE-SHOT NO LONGER MEANS ONE PROMPT.
   *
   * codex and opencode close stdin after a prompt, so the composer refused
   * their second one — correct, because it would have gone to a closed pipe.
   * All three CLIs can RESUME a session by id (measured 2026-09-21), and
   * `sendPrompt` uses that: a follow-up to a finished run starts a new process
   * that picks the conversation up. So the refusal only applies while there is
   * no session to resume, or to a build whose desktop side cannot. */
  const canContinue =
    Boolean(active?.sessionId) && typeof bridge.local?.resumeAgent === "function";
  const sent = messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);

  /* QUEUING, and only where it can be honoured.
   *
   * The composer refuses to send mid-turn, which is correct but makes you sit
   * and wait with a thought you have already had. A queue takes it now and
   * sends it when the turn settles.
   *
   * ⚠️ MULTI-TURN AGENTS ONLY. codex and opencode close stdin after one prompt
   * (agent-console.js § send, facts 4 and 5), so a queued second prompt would
   * be accepted by the UI and delivered to a closed pipe — the exact class of
   * lie isSendDisabled exists to prevent. They get no queue and keep the
   * refusal. */
  const sendRef = useRef<(text: string) => void>(() => {});
  sendRef.current = (text: string) => {
    if (active) sendPrompt(active.key, text);
  };
  const stopRef = useRef<() => void>(() => {});
  stopRef.current = () => {
    if (active) stopConsole(active.key);
  };

  const queue = useMemo(
    () =>
      createMessageQueue({
        run: (message) => {
          const text = textOf(message);
          if (text) sendRef.current(text);
        },
        cancel: () => stopRef.current(),
      }),
    [],
  );

  // The queue advances on the run's edges, and nothing else tells it. A turn
  // that opened is busy; a turn that closed is idle and releases the next one.
  useEffect(() => {
    if (streaming) queue.notifyBusy();
    else queue.notifyIdle();
  }, [streaming, queue]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    // transcript.mjs already emits ThreadMessageLike, so the converter is
    // identity. It has to be present all the same: the adapter's type only
    // omits it when the messages are full ThreadMessages.
    convertMessage: (m) => m,

    // `isRunning` is a TURN in flight, not the process being alive.
    //
    // ⚠️ It used to be `active.running`, the process. That reads correctly, and
    // it made the composer useless: the vendored ComposerAction renders Send
    // only when `!isRunning` and Cancel when `isRunning`, so a console showed
    // Stop from the moment it spawned and there was no way to send it the first
    // prompt at all. Enter just inserted a newline. A one-prompt agent then sat
    // on an open stdin until it was killed.
    //
    // The transcript already knows: `openIndex >= 0` means an assistant message
    // is open and being streamed into. Stopping the PROCESS is still offered —
    // on the console row, whose button already says Stop while it runs.
    isRunning: reading ? false : streaming,

    // codex and opencode take one prompt per run and close their stdin (see
    // agent-console.js § send, facts 4 and 5). Typing into a console that
    // cannot receive it would be a lie, so the composer is disabled rather
    // than silently dropping the text. That is why `sent` is counted: for a
    // one-prompt agent the second prompt is the one that goes nowhere, and the
    // first must still be allowed through.
    /* ⚠️ THE COMPOSER IS LIVE BEFORE THERE IS A CONSOLE.
     *
     * It used to be `!active`, and Andrew hit the dead end that produces: open
     * the agent view with nothing running and you got a sentence telling you
     * to pick an agent, with no picker on screen if no repo was open yet — "no
     * way to start right now". A chat window whose composer is dead until you
     * have found a button somewhere else is not a chat window.
     *
     * So the first prompt STARTS the run. `onNew` below spawns the agent the
     * model picker names and asks it, which is the only reading of Send that
     * is true here. The one thing still required is somewhere to run: no open
     * repo means no cwd, and that is a real refusal rather than a UI one. */
    isDisabled: reading ? true : !active && !canStart,
    // `streaming` is no longer a refusal for a multi-turn agent: the queue
    // takes the prompt and sends it when the turn settles. A one-shot agent
    // keeps it, because for that one there is no later.
    isSendDisabled: reading
      ? true
      : active
      ? // A finished run that can be resumed is not a dead end; a running turn
        // still refuses a one-shot agent, because that process IS mid-prompt.
        (!active.running && !canContinue) ||
        (oneShot && active.running && (streaming || sent > 0))
      : !canStart,

    /* ⚠️ NO QUEUE WHEN NOTHING IS RUNNING. The external-store runtime
     * checks `queue` FIRST and returns:
     *
     *     if (!isEdit && this._store.queue) { ...enqueue(message); return; }
     *     ...
     *     else await this._store.onNew(message);
     *
     * (@assistant-ui/core, external-store-thread-runtime-core.js). So while a
     * queue adapter is present, `onNew` is NEVER reached - and `onNew` is the
     * only thing that starts an agent. With no console open, Send put the
     * prompt into a queue that nothing would ever drain: the composer cleared,
     * no run began, and nothing anywhere said so. Exactly the dead end the
     * composer was rebuilt to remove ("there is no way to start right now"),
     * back again by a different route, and invisible because both halves
     * looked correct on their own.
     *
     * A queue only means anything when there is a run to queue FOR. */
    queue: reading || !active || oneShot ? undefined : queue.adapter,

    onNew: async (message) => {
      // A recording cannot be typed into. isDisabled already says so; this is
      // the second half of the same rule, for anything that calls append
      // without going through the composer.
      if (reading) return;
      const text = textOf(message);
      if (!text) return;
      /* Slash commands zevet answers itself (lib/slash.mjs). Everything else
         starting with `/` is a prompt like any other: claude runs its own. */
      const local = parseLocal(text, active?.agent ?? launchAgent);
      if (local === "stop") {
        if (active) stopConsole(active.key);
        return;
      }
      if (local === "new") {
        openLauncher();
        return;
      }
      if (local === "clear") {
        // Not claude (it runs /clear itself): end this run and leave no active
        // console, so the next Send starts a fresh one through the branch below.
        if (active) stopConsole(active.key);
        setActiveConsole(null);
        return;
      }
      if (active) {
        sendPrompt(active.key, text);
        return;
      }
      // Nothing running: start what the picker names and ask it. The agent,
      // model and posture all come from the launcher state, so pressing Send
      // is the same launch the Start buttons do, with a first prompt attached.
      if (canStart) startAgent(launchAgent, { prompt: text });
    },

    onCancel: async () => {
      if (!reading && active) stopConsole(active.key);
    },

    adapters: {
      /* TEXT ONLY, deliberately. The composer will take anything, and these
       * agents take a prompt on stdin — there is nothing useful to do with an
       * image, and an attachment that silently contributes nothing is worse
       * than one the composer refuses. */
      attachments: new CompositeAttachmentAdapter([new SimpleTextAttachmentAdapter()]),

      dictation,

      threadList: {
        threadId: active ? threadIdOf(active) : undefined,
        threads,
        onSwitchToThread: (id) => setActiveConsole(keyOfThreadId(id)),
        // "New thread" means "start another agent", which needs a choice of
        // which one — so it opens the launcher rather than selecting nothing.
        onSwitchToNewThread: () => openLauncher(),
      },
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Registers a rendering per tool name. Draws nothing itself, and has to
          be inside the provider to register at all. */}
      <ToolUIs />
      {children}
    </AssistantRuntimeProvider>
  );
}
