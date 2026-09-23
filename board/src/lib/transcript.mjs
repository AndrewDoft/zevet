/**
 * Agent JSONL -> assistant-ui messages.
 *
 * All three CLIs emit structured events. `agent-console.js` delivers them
 * intact. Until now `classifyAgentPayloadLine` flattened each one to a
 * `[kind, string]` pair and `ConsoleEntry.lines` was the only thing the UI ever
 * saw, so a tool call, its arguments, its result and a block of reasoning all
 * arrived as grey text that nothing downstream could tell apart. Structure
 * cannot be recovered once it has been stringified.
 *
 * This keeps it. The output is `ThreadMessageLike[]` — what
 * `useExternalStoreRuntime` consumes — with `tool-call` parts that carry their
 * own arguments and results, and `reasoning` parts kept separate from prose.
 *
 * WHY .mjs AND NOT .ts: the gate runs `node --test` straight against the source
 * tree and cannot import TypeScript. `roster.mjs`, `update.mjs`, `prose.mjs`
 * and `connect.mjs` are all here for the same reason, each with a `.d.mts`
 * beside it. Board logic that needs test coverage lives in .mjs; the React that
 * renders it is .tsx.
 *
 * COPY ON WRITE, deliberately. assistant-ui memoises per message by reference,
 * so mutating a message in place shows a stale render. Every append returns a
 * new state, sharing every message it did not touch.
 */

import { readEnvelope } from "./envelope.mjs";
import { mdSafe } from "./prose.mjs";
import { describeModel } from "./models.mjs";

/** @typedef {import("./transcript.d.mts").TranscriptState} TranscriptState */

let seq = 0;
const nextId = () => `zv-${++seq}`;

/** Injectable so a test can pin a clock. */
let clock = () => Date.now();
const now = () => clock();

/** Tests only. */
export function _setClock(fn) {
  clock = fn || (() => Date.now());
}

/** Reset the id counter. Tests only — ids are otherwise process-lifetime. */
export function _resetIds() {
  seq = 0;
}

/** @returns {TranscriptState} */
export function emptyTranscript() {
  return { messages: [], openIndex: -1, toolIndex: {}, byPartId: {}, running: false };
}

/* ---------------------------------------------------------------------------
 * Small helpers over the message list. Each returns a new list.
 * ------------------------------------------------------------------------- */

function withMessage(state, index, update) {
  const messages = state.messages.slice();
  const current = messages[index];
  messages[index] = { ...current, content: update(current.content.slice()) };
  return { ...state, messages };
}

function pushMessage(state, message) {
  return { ...state, messages: state.messages.concat(message) };
}

/** The assistant message currently being streamed into, opening one if the
 *  last thing that happened was a user prompt or a finished turn. */
function openAssistant(state) {
  if (state.openIndex >= 0) return state;
  const next = pushMessage(state, {
    id: nextId(),
    role: "assistant",
    content: [],
    status: { type: "running" },
  });
  return { ...next, openIndex: next.messages.length - 1 };
}

/** Append text to the trailing part of `kind`, or start a new one. Streaming
 *  deltas arrive as many events and must read as one paragraph. */
function appendStreamed(state, kind, text) {
  if (!text) return state;
  const s = openAssistant(state);
  return withMessage(s, s.openIndex, (content) => {
    const last = content[content.length - 1];
    /* ⚠️ mdSafe RUNS ON THE ACCUMULATED TEXT, NEVER ON THE DELTA. It escapes a
     * line that is a bare ordered-list marker with nothing after it — `51.`,
     * which markdown renders as an empty <ol start="51"> and which is a real
     * answer claude gives. Applied to a fragment it would escape the marker of
     * a list whose first item simply had not streamed in yet; applied to the
     * whole string, `51. something` stops matching and nothing is escaped.
     * Prose only: reasoning is not rendered as markdown. */
    const md = kind === "text" ? mdSafe : (v) => v;
    if (last && last.type === kind) {
      content[content.length - 1] = { ...last, text: md(last.text + text) };
    } else {
      content.push({ type: kind, text: md(text) });
    }
    return content;
  });
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * A prompt the person sent. Closes whatever turn was open.
 *
 * ⚠️ NOT EVERY `user` RECORD IS A PERSON. A terminal session writes a caveat,
 * a system reminder and a task notification as user messages, and each one
 * says in so many words that it is not input. They are dropped here rather
 * than at any of the four call sites, so a live console and a session read off
 * disk cannot disagree about it. What IS kept — a slash command, a `!` command
 * and what either printed — stays as its own message and is drawn as a chip or
 * a collapsed line by components/slashtext.tsx.
 *
 * A reminder that trails a real prompt is cut out of it instead, because the
 * words in front of it are somebody's ask.
 */
export function appendUserText(state, text) {
  if (typeof text !== "string" || !text.length) return state;
  const env = readEnvelope(text);
  if (env && env.kind === "noise") return state;
  const said = env ? text : withoutNoise(text);
  if (!said) return state;
  const closed = { ...state, openIndex: -1 };
  return pushMessage(closed, {
    id: nextId(),
    role: "user",
    content: [{ type: "text", text: said }],
  });
}

/* Only a CLOSED block, so a prompt that merely names `<system-reminder>` in
   prose — which a compaction summary does — keeps its words. */
const NOISE_BLOCK =
  /<(local-command-caveat|system-reminder|task-notification)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

function withoutNoise(text) {
  return text.includes("<") ? text.replace(NOISE_BLOCK, "").trim() : text;
}

/**
 * A COMPLETE line or notice, rather than a streaming fragment.
 *
 * ⚠️ appendStreamed DELIBERATELY ADDS NO SEPARATOR, because a token stream
 * must not gain whitespace it was never sent. Everything that arrives whole
 * went through it anyway, so two completed codex messages were run together:
 * "The fix is in place.Anything else?".
 *
 * So a unit that is already a whole line says so, and gets a newline in front
 * of it when the text it is joining does not already end in one.
 */
export function appendLine(state, text) {
  const t = String(text ?? "");
  if (!t) return state;
  const open = state.openIndex >= 0 ? state.messages[state.openIndex] : null;
  const content = open && Array.isArray(open.content) ? open.content : null;
  const last = content ? content[content.length - 1] : null;
  const joins = last && last.type === "text" && last.text && !last.text.endsWith("\n");
  return appendStreamed(state, "text", joins ? "\n" + t : t);
}

/**
 * One `{type:"agent", payload}` event.
 *
 * `agent` selects the vocabulary. ⚠️ AN UNRECOGNISED PAYLOAD IS DROPPED. It
 * used to be drawn as `[codex: <type>]` in the agent's own voice, which is CLI
 * plumbing presented as the reply. The process's own output is kept for
 * debugging in the raw-output view (`lines`, components/rawoutput.tsx); the
 * conversation shows only the conversation.
 */
export function appendAgentPayload(state, payload, opts = {}) {
  if (!payload || typeof payload !== "object") return state;
  const agent = opts.agent || "claude";
  const root = opts.localRoot || null;

  const handler =
    agent === "codex" ? fromCodex : agent === "opencode" ? fromOpencode : fromClaude;
  return handler(state, payload, root, opts.model || "");
}

/**
 * The process ended. Closes the open turn and records how it went.
 *
 * ⚠️ AN ERROR ALWAYS LANDS ON A MESSAGE. A run that fails before saying
 * anything — opencode on an OpenRouter model past its free daily limit sends
 * nothing but an `error` event — has no open turn, and returning early here
 * left the screen blank: no reply, no error, no sign it had ended. So an error
 * opens a turn to carry it. A run that ends with no output and NO error still
 * adds nothing.
 */
export function closeTranscript(state, { code = null, error = null, stopped = false } = {}) {
  let s = { ...state, running: false };
  if (s.openIndex < 0 && !error) return s;
  /* ⚠️ A FAILED RUN CLOSES TWICE. codex emits both an `error` event and a
   * `turn.failed` event for the same failure, and each one closes the
   * transcript with the same error. The first close leaves no open turn, so
   * the second opened a NEW assistant message carrying the same
   * status.error — and the conversation drew the error line twice in a row.
   * A turn that already ended keeps its ending; the first error wins. */
  if (s.openIndex < 0) {
    const last = s.messages[s.messages.length - 1];
    if (last && last.role === "assistant" && last.status && last.status.type !== "running") return s;
  }
  s = openAssistant(s);
  const index = s.openIndex;
  s = { ...s, openIndex: -1 };
  const messages = s.messages.slice();
  messages[index] = {
    ...messages[index],
    status:
      /* A run WE ended — the stop button, or a follow-up replacing the
       * process — exits non-zero (taskkill /F is code 1). That is not a
       * failure, and nothing is drawn for it. */
      error || (code !== null && code !== 0 && !stopped)
        ? { type: "incomplete", reason: "error", error: error || "The run stopped." }
        : { type: "complete", reason: "stop" },
  };
  return { ...s, messages };
}

/**
 * Whatever a CLI or provider said went wrong, as one sentence a person can read.
 *
 * The raw text is a provider payload more often than not — opencode's
 * OpenRouter 429 carries every response header and a JSON body — and it was
 * shown verbatim, in the thread and on the rail. It stays in the raw-output
 * view; this is what is shown instead. Unrecognised input gets `fallback`,
 * never the input itself.
 *
 * @param {unknown} raw
 * @param {{ model?: string | null, fallback?: string }} [opts]
 */
export function plainError(raw, opts = {}) {
  const s = String(raw ?? "");
  const name = describeModel(opts.model || "").label || "The model";
  if (/free-models-per-day/i.test(s)) return `${name} hit its free daily limit.`;
  if (/rate.?limit|\b429\b|too many requests|usage limit|quota/i.test(s)) return `${name} hit its usage limit.`;
  if (/\b401\b|unauthori[sz]ed|api.?key|not logged in|authenticat/i.test(s)) return "Not signed in.";
  const missing = /could not find (\w+) on this machine/i.exec(s);
  if (missing) return `${missing[1][0].toUpperCase()}${missing[1].slice(1)} isn't installed.`;
  return opts.fallback || "The model returned an error.";
}

/** Convenience for tests and for rebuilding a console from its stored events. */
export function assembleTranscript(events, opts = {}) {
  let state = emptyTranscript();
  for (const e of events ?? []) {
    if (!e) continue;
    if (e.type === "you") state = appendUserText(state, e.text);
    else if (e.type === "agent") state = appendAgentPayload(state, e.payload, opts);
    else if (e.type === "exit") state = closeTranscript(state, e);
  }
  return state;
}

/* ---------------------------------------------------------------------------
 * Tool calls
 * ------------------------------------------------------------------------- */

function addToolCall(state, { id, name, args }, root) {
  const s = openAssistant(state);

  /* ⚠️ A TOOL CALL ID MUST BE UNIQUE WITHIN A TRANSCRIPT, and the agent is not
   * the one guaranteeing it.
   *
   * MEASURED: sending a second prompt to a console replays a turn whose tool
   * ids repeat, and assistant-ui keys its message parts by toolCallId —
   * "Duplicate key toolCallId-t2 in useResources" threw inside AuiProvider and
   * took down the whole conversation, not just the duplicated card. One
   * repeated id from any of three CLIs, across any version, would do the same
   * to a real user mid-session.
   *
   * So the id is made unique here. A result matches by id, and a repeated id
   * could only ever match the wrong call anyway; pointing toolIndex at the
   * newest is the same rule a human would apply reading the stream in order. */
  const wanted = id || nextId();
  let callId = wanted;
  for (let n = 2; s.byPartId[callId]; n += 1) callId = `${wanted}#${n}`;
  const next = withMessage(s, s.openIndex, (content) => {
    content.push({
      type: "tool-call",
      toolCallId: callId,
      toolName: name || "tool",
      args: trimRoot(args, root) ?? {},
      argsText: JSON.stringify(trimRoot(args, root) ?? {}, null, 2),
      /* WHEN, so a turn can be drawn as a trace rather than a list.
       * Nothing else records this: the CLIs do not timestamp their events, so
       * the only honest clock is the one on the machine reading them, and the
       * only honest claim is "this is when zevet SAW it". That is exactly what
       * a waterfall of the turn needs, and it is not the agent's own timing. */
      startedAt: now(),
    });
    return content;
  });
  const at = { message: s.openIndex, part: next.messages[s.openIndex].content.length - 1 };
  return {
    ...next,
    /* The AGENT's id points at the NEWEST call with that id.
     *
     * The part's own id is made unique so React can key it, but a result
     * arrives carrying the id the agent sent — and a result that arrives after
     * a second call with the same id belongs to the second one. Repointing is
     * the rule a person reading the stream in order would apply; leaving the
     * old entry in place put the second call's output on the first card. */
    toolIndex: { ...next.toolIndex, [wanted]: at },
    byPartId: { ...s.byPartId, [callId]: true },
  };
}

function setToolResult(state, callId, result, isError) {
  const at = state.toolIndex[callId];
  if (!at) return state;
  return withMessage(state, at.message, (content) => {
    const part = content[at.part];
    if (!part || part.type !== "tool-call") return content;
    content[at.part] = { ...part, result, isError: Boolean(isError), endedAt: now() };
    return content;
  });
}

/**
 * Absolute paths under the open repo are noise in a tool-call header — every
 * one of them starts with the same 40 characters. Trimmed to repo-relative,
 * exactly as `shortInput` has always done for the line view.
 */
function trimRoot(value, root) {
  if (!root) return value;
  if (typeof value === "string") {
    return value.startsWith(root) ? value.slice(root.length).replace(/^[\\/]+/, "") : value;
  }
  if (Array.isArray(value)) return value.map((v) => trimRoot(v, root));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = trimRoot(v, root);
    return out;
  }
  return value;
}

/* ---------------------------------------------------------------------------
 * claude — `--output-format stream-json`
 *
 * MEASURED: this is the shape zevet has been consuming since the console
 * existed; `classifyAgentPayloadLine` reads the same fields.
 * ------------------------------------------------------------------------- */

function fromClaude(state, p, root, model) {
  if (p.type === "assistant" && p.message && Array.isArray(p.message.content)) {
    let s = state;
    for (const part of p.message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") s = appendStreamed(s, "text", String(part.text ?? ""));
      else if (part.type === "thinking") s = appendStreamed(s, "reasoning", String(part.thinking ?? ""));
      else if (part.type === "redacted_thinking") s = appendStreamed(s, "reasoning", "[redacted]");
      else if (part.type === "tool_use") {
        s = addToolCall(s, { id: part.id, name: part.name, args: part.input }, root);
      }
    }
    return s;
  }

  // Tool results come back as a USER message, which is a shape worth knowing:
  // it is the transcript's own record of what the tool said, not a person
  // typing. It must attach to the call, never render as a prompt.
  if (p.type === "user" && p.message && Array.isArray(p.message.content)) {
    let s = state;
    for (const part of p.message.content) {
      if (part && part.type === "tool_result") {
        s = setToolResult(s, part.tool_use_id, part.content, part.is_error);
      }
    }
    return s;
  }

  if (p.type === "result") {
    return p.is_error
      ? closeTranscript(state, { error: plainError(p.result, { model }) })
      : closeTranscript(state, { code: 0 });
  }

  // `system`/`init` carries the model and the session id. The strip already
  // reads it off the raw payload; it is not transcript content.
  if (p.type === "system") return state;

  // `/clear` typed to claude: it drops its own context and says so with this
  // line. The board's copy of the conversation has to go with it, or the
  // screen shows a history the agent no longer has.
  if (p.type === "conversation_reset") return emptyTranscript();

  /* ⚠️ `stream_event` IS NOT TRANSCRIPT CONTENT, AND RENDERING IT IS THE BUG
   * ANDREW SAW. `--include-partial-messages` makes claude wrap every raw SSE
   * event — message_start, content_block_start, content_block_delta,
   * content_block_stop, message_delta, message_stop — in one of these. None
   * of them was handled, so every single one fell through to the "unknown but
   * real" branch below and printed `[claude: stream_event]` into the
   * assistant's own message. Measured 2026-09-21 in the running app: a
   * one-sentence question produced an answer that was nothing but dozens of
   * those. Andrew: "the response looked super weird."
   *
   * They are dropped rather than rendered because the SAME CONTENT ARRIVES
   * AGAIN, complete, as an `assistant` payload per content block — handled at
   * the top of this function. Rendering both would double every sentence.
   * agent-console.js no longer asks for them at all; this stays so an older
   * desktop build, or a flag that comes back, degrades to silence instead of
   * to garbage. */
  if (p.type === "stream_event") return state;

  /* Rate limits, read off the raw payload by lib/board.ts's `limitsOf` and
   * shown as a chip on the composer row. Not transcript content either, and
   * it used to print `[claude: rate_limit_event]` for the same reason. */
  if (p.type === "rate_limit_event") return state;

  return state;
}

/* ---------------------------------------------------------------------------
 * opencode — `run --format json`
 *
 * MEASURED 2026-09-19 (see agent-console.js § send, fact 5): one JSON object
 * per line, {type:"step_start"|"text"|"tool_use"|"step_finish"|"error"}.
 * ------------------------------------------------------------------------- */

function fromOpencode(state, p, root, model) {
  const part = p.part || {};

  if (p.type === "step_start") return state;

  if (p.type === "text" && part.type === "text") {
    return appendStreamed(state, "text", String(part.text ?? ""));
  }

  if (p.type === "reasoning") {
    return appendStreamed(state, "reasoning", String(part.text ?? p.text ?? ""));
  }

  if (p.type === "tool_use" && part.type === "tool") {
    const st = part.state || {};
    const callId = part.id || part.callID || st.id;
    // opencode reports the same tool twice: once when it starts and again with
    // output. The second must update the first, not stack a duplicate.
    if (callId && state.toolIndex[callId] && (st.output !== undefined || st.status === "completed")) {
      return setToolResult(state, callId, st.output, st.status === "error");
    }
    let s = addToolCall(state, { id: callId, name: part.tool, args: st.input }, root);
    if (st.output !== undefined) {
      s = setToolResult(s, callId || Object.keys(s.toolIndex).pop(), st.output, st.status === "error");
    }
    return s;
  }

  /* ⚠️ A STEP IS NOT A TURN. opencode ends every model call with a
     step_finish, and one that called a tool says `reason:"tool-calls"` and
     carries straight on with another step. Closing on each of those made
     every tool call its own assistant message — a run with 18 calls showed
     "1 tool call" eighteen times. Measured 2026-09-22, `opencode run --format
     json` reading three files: four steps ending "tool-calls", then one
     ending "stop". Only a step that is not handing off to a tool ends it. */
  if (p.type === "step_finish") {
    return part.reason === "tool-calls" ? state : closeTranscript(state, { code: 0 });
  }

  /* MEASURED 2026-09-22, an OpenRouter free model past its daily cap: the
     message is at `error.data.message`, beside the response headers and body.
     `error.message` does not exist. */
  if (p.type === "error") {
    const e = p.error || {};
    return closeTranscript(state, { error: plainError((e.data && e.data.message) || e.message || e.name, { model }) });
  }

  return state;
}

/* ---------------------------------------------------------------------------
 * codex — `exec --json`
 *
 * ✅ MEASURED 2026-09-21 against codex-cli 0.155.0-alpha.2.6, closing INSUF-005.
 * Two runs were captured: one trivial reply, and one that wrote a file and ran
 * a command. Every line below is from that capture rather than from codex's
 * documentation, which is what the previous version of this comment warned it
 * was working from.
 *
 * The whole vocabulary that appeared:
 *
 *   {"type":"thread.started","thread_id":"01a0c1e7-…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started"  ,"item":{…}}      ← a tool call BEGINNING
 *   {"type":"item.completed","item":{…}}
 *   {"type":"turn.completed","usage":{…}}
 *
 * and the item types inside those, with the fields that carry the content:
 *
 *   agent_message      {text}
 *   command_execution  {command, aggregated_output, exit_code, status}
 *   file_change        {changes:[{path, kind}], status}
 *   error              {message}
 *
 * Three things the documented guess had wrong, all now fixed here:
 *
 *   1. `error` ARRIVES AS AN ITEM, not as a top-level event, and it is not
 *      necessarily fatal — the capture's was a notice about skill descriptions
 *      being shortened, mid-turn, with the turn completing normally. The old
 *      table fell through it to `return state`, which dropped it silently:
 *      precisely the failure this file exists to prevent.
 *   2. `file_change` carries `changes[].path`, and passing the array straight
 *      through as `args` left the Edit card with no file name on it.
 *   3. usage says `cached_input_tokens`, not claude's
 *      `cache_read_input_tokens` — see `usageOf` in lib/board.ts, which read
 *      zero and reported every codex turn as a 0% cache hit.
 *
 * An event whose name is not below is dropped (see appendAgentPayload).
 * ------------------------------------------------------------------------- */

function fromCodex(state, p, root, model) {
  if (p.type === "thread.started" || p.type === "turn.started") return state;

  if (p.type === "agent_message_delta" || p.type === "agent_message") {
    return appendStreamed(state, "text", String(p.delta ?? p.text ?? p.message ?? ""));
  }

  if (p.type === "reasoning" || p.type === "agent_reasoning" || p.type === "agent_reasoning_delta") {
    return appendStreamed(state, "reasoning", String(p.delta ?? p.text ?? ""));
  }

  if (p.type === "item.started" || p.type === "item.completed" || p.type === "item.updated") {
    const item = p.item || {};
    if (item.type === "agent_message") {
      const text = String(item.text ?? "");
      // A COMPLETED item is a whole message and needs a line of its own.
      // `started`/`updated` may still be filling in, so those keep the
      // streaming join.
      return p.type === "item.completed" ? appendLine(state, text) : appendStreamed(state, "text", text);
    }
    if (item.type === "reasoning") {
      return appendStreamed(state, "reasoning", String(item.text ?? ""));
    }
    /* A notice from codex itself, not from the model, and not fatal —
       measured 2026-09-22 it is "Skill descriptions were shortened to fit the
       skills context budget…" and the turn completes normally. Drawn, it was
       the first line of the reply (and was once the run's summary in the
       rail). Housekeeping: dropped. A real failure arrives as
       `turn.failed` or a top-level `error`, below. */
    if (item.type === "error") return state;
    if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call") {
      const callId = item.id || nextId();
      const name = item.type === "command_execution" ? "Bash" : item.type === "file_change" ? "Edit" : item.tool || "tool";
      // `changes` is an ARRAY of {path, kind}. Handing the array over as args
      // left the Edit card with nothing to put in its title; the first path is
      // what the card is about, and the rest stays for anything that wants it.
      const changed = Array.isArray(item.changes) ? item.changes : null;
      const args =
        item.command !== undefined
          ? { command: item.command }
          : changed
            ? { file_path: String(changed[0]?.path ?? ""), changes: changed }
            : item.arguments || {};
      if (state.toolIndex[callId]) {
        const done = item.status === "completed" || p.type === "item.completed";
        return done ? setToolResult(state, callId, item.aggregated_output ?? item.output ?? "", item.status === "failed") : state;
      }
      let s = addToolCall(state, { id: callId, name, args }, root);
      if (p.type === "item.completed") {
        s = setToolResult(s, callId, item.aggregated_output ?? item.output ?? "", item.status === "failed");
      }
      return s;
    }
    return state;
  }

  if (p.type === "turn.completed") return closeTranscript(state, { code: 0 });
  if (p.type === "turn.failed") {
    return closeTranscript(state, { error: plainError(p.error && p.error.message, { model }) });
  }
  if (p.type === "error") {
    return closeTranscript(state, { error: plainError((p.error && p.error.message) || p.message, { model }) });
  }

  return state;
}
