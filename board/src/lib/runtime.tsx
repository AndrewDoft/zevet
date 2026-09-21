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
  WebSpeechDictationAdapter,
  createMessageQueue,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { selectActiveConsole, selectMyConsoles, useBoard } from "./board";
import { bridge } from "./bridge";
import { MULTI_TURN } from "./constants";
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

  /* DICTATION.
   *
   * Built once, not per render: it holds a SpeechRecognition session, and a new
   * adapter on every render would drop the one that is listening.
   *
   * ⚠️ THIS IS NOT MASORA. Masora's dictation is a local service that types
   * into whatever field has focus, so it already works with this composer and
   * needs nothing from zevet; its HTTP surface is enrollment and key renewal,
   * not transcription. What this adds is a mic IN the composer, which works
   * without Masora installed. Pointing it at a transcription endpoint later is
   * a change to this one line. */
  const dictation = useMemo(() => new WebSpeechDictationAdapter(), []);

  const messages = active?.transcript.messages ?? NO_MESSAGES;
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
    isRunning: streaming,

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
    isDisabled: !active && !canStart,
    // `streaming` is no longer a refusal for a multi-turn agent: the queue
    // takes the prompt and sends it when the turn settles. A one-shot agent
    // keeps it, because for that one there is no later.
    isSendDisabled: active
      ? // A finished run that can be resumed is not a dead end; a running turn
        // still refuses a one-shot agent, because that process IS mid-prompt.
        (!active.running && !canContinue) ||
        (oneShot && active.running && (streaming || sent > 0))
      : !canStart,

    queue: oneShot ? undefined : queue.adapter,

    onNew: async (message) => {
      const text = textOf(message);
      if (!text) return;
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
      if (active) stopConsole(active.key);
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
