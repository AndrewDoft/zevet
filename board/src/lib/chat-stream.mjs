/**
 * Zevet Chat's thread state: transcript.mjs's reducer, plus the one thing a
 * chat needs that a console does not — token streaming.
 *
 * desktop/chat.js runs claude with --include-partial-messages, so text
 * arrives as `stream_event` deltas BEFORE the whole block lands as an
 * `assistant` payload. transcript.mjs drops stream_event on purpose (Code
 * never asks for them). Here they grow `draft`, a view-only overlay that the
 * complete block replaces, so nothing is ever counted twice.
 *
 * .mjs for the same reason as transcript.mjs: `node --test` runs it directly.
 */
import { appendAgentPayload, appendUserText, closeTranscript, emptyTranscript } from "./transcript.mjs";

/** @returns {import("./chat-stream.d.mts").ChatThread} */
export function emptyChatThread() {
  return { transcript: emptyTranscript(), draft: "", busy: false };
}

/** A saved chat ({role, text}[]) as a closed thread. */
export function fromStored(messages) {
  let t = emptyTranscript();
  for (const m of messages || []) {
    if (!m || typeof m.text !== "string") continue;
    if (m.role === "user") t = appendUserText(t, m.text);
    else {
      t = appendAgentPayload(t, { type: "assistant", message: { content: [{ type: "text", text: m.text }] } });
      t = closeTranscript(t, { code: 0 });
    }
  }
  return { transcript: t, draft: "", busy: false };
}

/** The person's words, shown the moment Send is pressed. */
export function sendUser(thread, text) {
  return { ...thread, transcript: appendUserText(thread.transcript, text), draft: "", busy: true };
}

/** One `chat:event` evt from the desktop side. */
export function chatEvent(thread, evt) {
  if (!evt || typeof evt !== "object") return thread;
  if (evt.type === "exit") {
    // Mid-turn and not stopped by the person: the process died before its
    // `result`. That lands on the thread even when nothing was said yet.
    const died = !evt.stopped && evt.code !== 0 ? evt.error || "The run stopped." : null;
    return {
      transcript: thread.busy ? closeTranscript(thread.transcript, { ...evt, error: died }) : thread.transcript,
      draft: "",
      busy: false,
    };
  }
  if (evt.type !== "agent") return thread;
  const p = evt.payload;
  if (!p || typeof p !== "object") return thread;
  if (p.type === "stream_event") {
    const d = p.event && p.event.type === "content_block_delta" ? p.event.delta : null;
    return d && d.type === "text_delta" && typeof d.text === "string"
      ? { ...thread, draft: thread.draft + d.text }
      : thread;
  }
  const transcript = appendAgentPayload(thread.transcript, p);
  if (p.type === "result") return { transcript, draft: "", busy: false };
  if (p.type === "assistant") return { ...thread, transcript, draft: "" };
  return transcript === thread.transcript ? thread : { ...thread, transcript };
}

/** A failure to even start the turn, drawn where the reply would be. */
export function failTurn(thread, error) {
  return { transcript: closeTranscript(thread.transcript, { error }), draft: "", busy: false };
}

/** What the runtime renders: the transcript with the draft laid over it. */
export function visibleMessages(thread) {
  const { messages, openIndex } = thread.transcript;
  if (!thread.draft) return messages;
  const part = { type: "text", text: thread.draft };
  if (openIndex >= 0) {
    const out = messages.slice();
    const open = out[openIndex];
    out[openIndex] = { ...open, content: [...open.content, part] };
    return out;
  }
  return messages.concat({ id: "zv-draft", role: "assistant", content: [part], status: { type: "running" } });
}
