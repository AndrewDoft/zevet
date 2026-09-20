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
import { type PropsWithChildren, useMemo } from "react";
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { selectActiveConsole, selectMyConsoles, useBoard } from "./board";
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

/** The text of a message the composer just produced. Attachments arrive as
 *  their own parts and are not prompt text. */
function textOf(message: AppendMessage): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

export function ConsoleRuntimeProvider({ children }: PropsWithChildren) {
  const consoles = useBoard(selectMyConsoles);
  const active = useBoard(selectActiveConsole);
  const sendPrompt = useBoard((s) => s.sendPrompt);
  const stopConsole = useBoard((s) => s.stopConsole);
  const setActiveConsole = useBoard((s) => s.setActiveConsole);

  const threads = useMemo<readonly ExternalStoreThreadData<"regular">[]>(
    () =>
      consoles.map((c) => ({
        status: "regular" as const,
        id: threadIdOf(c),
        title: titleOf(c),
      })),
    [consoles],
  );

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: active?.transcript.messages ?? NO_MESSAGES,
    // transcript.mjs already emits ThreadMessageLike, so the converter is
    // identity. It has to be present all the same: the adapter's type only
    // omits it when the messages are full ThreadMessages.
    convertMessage: (m) => m,

    // `isRunning` is the process, not the last message's status. An agent that
    // has printed its answer but not exited is still running, and the composer
    // and stop button must agree with the process rather than with the prose.
    isRunning: Boolean(active?.running),

    // codex and opencode take one prompt per run and close their stdin (see
    // agent-console.js § send, facts 4 and 5). Typing into a console that
    // cannot receive it would be a lie, so the composer is disabled rather
    // than silently dropping the text.
    isDisabled: !active,
    isSendDisabled: !active?.running,

    onNew: async (message) => {
      if (!active) return;
      const text = textOf(message);
      if (text) sendPrompt(active.key, text);
    },

    onCancel: async () => {
      if (active) stopConsole(active.key);
    },

    adapters: {
      threadList: {
        threadId: active ? threadIdOf(active) : undefined,
        threads,
        onSwitchToThread: (id) => setActiveConsole(keyOfThreadId(id)),
        // "New thread" means "start another agent", which needs a choice of
        // which one — so it clears the selection and lets the launcher show.
        onSwitchToNewThread: () => setActiveConsole(null),
      },
    },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
