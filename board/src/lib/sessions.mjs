/**
 * A session file on disk -> the same transcript a live console renders.
 *
 * WHY THERE IS SO LITTLE RENDERING HERE. Both CLIs write their session files
 * in a dialect of the stream they already emit live, and transcript.mjs has
 * consumed those streams since zevet's console existed. So reading a session
 * that was typed into a terminal — or into one of the desktop apps — is not a
 * second renderer. It is a translation onto the event list
 * `assembleTranscript` already takes, and every tool UI, reasoning panel and
 * markdown block comes along for free.
 *
 * claude needs almost none. `~/.claude/projects/<slug>/<id>.jsonl` records
 * `user` and `assistant` in the SAME shape `--output-format stream-json`
 * emits. The one thing the file adds is that a `user` record is TWO different
 * things: with a string `content` it is a person typing, with an array
 * `content` it is usually the transcript's own record of what a tool
 * returned — which must attach to the call that made it and must never render
 * as a prompt. transcript.mjs already draws that line (`fromClaude`, the
 * `user` branch); this hands it each half the way it expects.
 *
 * codex needs a table. Its rollout file wraps everything as
 * `{type, payload}`, and inside `event_msg`/`item_completed` the items are
 * PascalCase (`CommandExecution`) where the live `codex exec --json` stream
 * uses snake_case (`command_execution`). `codexItem` below is that table, and
 * it deliberately translates INTO the live vocabulary rather than teaching
 * transcript.mjs a second one — `fromCodex` is tested, and two spellings of
 * the same event in one reducer is how they drift apart.
 *
 * WHY .mjs: the gate runs `node --test` straight against the source tree and
 * cannot import TypeScript — the same reason transcript.mjs, roster.mjs and
 * update.mjs are .mjs with a .d.mts beside them.
 */

import { assembleTranscript } from "./transcript.mjs";

/** @typedef {import("./sessions.d.mts").SessionRecord} SessionRecord */
/** @typedef {import("./transcript.d.mts").TranscriptEvent} TranscriptEvent */

const text = (v) => (typeof v === "string" ? v : "");

/** Content parts, for every spelling the two CLIs use. claude writes
 *  `{type:"text"}`, codex writes `{type:"Text"}` in an AgentMessage and
 *  `{type:"text"}` in a UserMessage. Only `text` is read, so the tag does not
 *  have to be guessed. */
function partsText(parts) {
  if (!Array.isArray(parts)) return "";
  const out = [];
  for (const p of parts) {
    if (p && typeof p.text === "string") out.push(p.text);
  }
  return out.join("\n");
}

/* ---------------------------------------------------------------------------
 * codex — a rollout item, as the live stream would have said it
 * ------------------------------------------------------------------------- */

/**
 * One `item_completed` item -> a `codex exec --json` event, or null to drop it.
 *
 * Every branch is a shape MEASURED in `~/.codex/sessions` on 2026-09-21, not
 * one taken from documentation. An item type not listed here returns null and
 * is dropped rather than rendered as a mystery: unlike a live stream, a
 * session file is complete, so a gap is visible next to what surrounds it.
 *
 * @returns {TranscriptEvent | null}
 */
export function codexItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = text(item.id) || undefined;

  switch (item.type) {
    case "UserMessage": {
      const t = partsText(item.content).trim();
      return t ? { type: "you", text: t } : null;
    }
    case "AgentMessage": {
      const t = partsText(item.content);
      return t ? agent({ type: "item.completed", item: { type: "agent_message", text: t } }) : null;
    }
    case "Reasoning": {
      // `summary_text` is an array of strings — codex's own summary of the
      // reasoning. `raw_content` is normally empty and is not relied on.
      const t = (Array.isArray(item.summary_text) ? item.summary_text : [])
        .map((s) => text(s))
        .filter(Boolean)
        .join("\n\n");
      return t ? agent({ type: "item.completed", item: { type: "reasoning", text: t } }) : null;
    }
    case "CommandExecution": {
      // The command is an ARGV ARRAY here, and the card wants a command line.
      const command = Array.isArray(item.command)
        ? item.command.join(" ")
        : text(item.command);
      return agent({
        type: "item.completed",
        item: {
          type: "command_execution",
          id,
          command,
          aggregated_output: item.aggregated_output ?? item.formatted_output ?? item.stdout ?? "",
          status: item.status,
        },
      });
    }
    case "FileChange": {
      /* ⚠️ `changes` IS AN OBJECT KEYED BY PATH in a rollout file, and an
         ARRAY of {path, kind} in the live stream — which is the shape
         `fromCodex` reads. Handing the object straight over leaves the Edit
         card with no path in its title and no diff under it. */
      const raw = item.changes && typeof item.changes === "object" ? item.changes : {};
      const changes = Object.entries(raw).map(([p, v]) => ({
        path: p,
        kind: (v && v.type) || "update",
        unified_diff: (v && v.unified_diff) || "",
      }));
      if (!changes.length) return null;
      return agent({
        type: "item.completed",
        item: { type: "file_change", id, changes, status: item.status },
      });
    }
    case "McpToolCall": {
      const server = text(item.server);
      const tool = text(item.tool) || "tool";
      return agent({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id,
          tool: server ? `${server}.${tool}` : tool,
          arguments: item.arguments || {},
          output: item.result ?? "",
          status: item.status,
        },
      });
    }
    case "WebSearch": {
      // No live equivalent, and a search is a tool call in every way that
      // matters to a reader. The action carries the url for an open_page.
      const action = item.action && typeof item.action === "object" ? item.action : {};
      return agent({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          id,
          tool: "web_search",
          arguments: { query: text(item.query), ...(action.url ? { url: action.url } : {}) },
          output: "",
          status: "completed",
        },
      });
    }
    case "ContextCompaction":
      return { type: "stdout-line", line: "codex: context compacted" };
    /* SubAgentActivity is a start/finish marker with no content of its own —
       the subagent's work is in its own thread. Dropped rather than rendered
       as an empty card. */
    default:
      return null;
  }
}

/** @returns {TranscriptEvent} */
function agent(payload) {
  return { type: "agent", payload };
}

/* ---------------------------------------------------------------------------
 * claude
 * ------------------------------------------------------------------------- */

/** @param {any} r @param {TranscriptEvent[]} out */
function claudeRecord(r, out) {
  const content = r.message && r.message.content;

  if (r.type === "assistant") {
    // Handed over whole: transcript.mjs reads `p.message.content` itself and
    // knows text from thinking from tool_use.
    if (content) out.push({ type: "agent", payload: r });
    return;
  }
  if (r.type !== "user") return;

  if (typeof content === "string") {
    const t = content.trim();
    if (t) out.push({ type: "you", text: t });
    return;
  }
  if (!Array.isArray(content)) return;

  /* ⚠️ ORDER WITHIN THE RECORD MATTERS, and the two kinds of part cannot be
   * sent together. A tool_result has to reach `fromClaude` as a `user`
   * payload so it lands on the call it belongs to; typed text has to reach
   * `appendUserText`, which OPENS A NEW TURN. Splitting them into two events
   * is the whole trick — but a record carrying both must keep the order it
   * had, or the prompt closes the turn the result was about to attach to. */
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({ type: "agent", payload: { type: "user", message: { content: pending } } });
    pending = [];
  };
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool_result") {
      pending.push(part);
      continue;
    }
    if (part.type === "text") {
      const t = text(part.text).trim();
      if (!t) continue;
      flush();
      out.push({ type: "you", text: t });
    }
    // An image or a document in a prompt has no representation in a CLI
    // transcript and is not invented here.
  }
  flush();
}

/* ---------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------- */

/**
 * Records -> transcript events, in order. Mixed sources are fine; each record
 * says which it is.
 *
 * @param {readonly SessionRecord[] | null | undefined} records
 * @returns {TranscriptEvent[]}
 */
export function sessionEvents(records) {
  /** @type {TranscriptEvent[]} */
  const out = [];
  for (const r of records ?? []) {
    if (!r || typeof r !== "object") continue;
    if (r.source === "codex") {
      const ev = codexItem(r.item);
      if (ev) out.push(ev);
      continue;
    }
    claudeRecord(r, out);
  }
  return out;
}

/**
 * A whole session, as a TranscriptState the Thread can render.
 *
 * `cwd` trims absolute paths out of tool-call headers exactly as `localRoot`
 * does for a live console — for a session the repo is the session's OWN
 * directory, not whatever folder happens to be open in zevet.
 *
 * @param {readonly SessionRecord[] | null | undefined} records
 * @param {{ cwd?: string | null; source?: string }} [opts]
 */
export function sessionTranscript(records, opts = {}) {
  const state = assembleTranscript(sessionEvents(records), {
    agent: opts.source === "codex" ? "codex" : "claude",
    localRoot: opts.cwd || null,
  });
  /* A session read from disk is FINISHED as far as this view is concerned,
   * even if the CLI still has the file open. Leaving `openIndex` set renders
   * the last turn as streaming — a spinner that never resolves, on a
   * conversation that ended last Tuesday. */
  return closeOpenTurn(state);
}

function closeOpenTurn(state) {
  /* ⚠️ EVERY UNFINISHED TURN, NOT JUST THE OPEN ONE. This closed
     `state.openIndex` and stopped, which is only the LAST turn. The earlier
     ones are closed during assembly by the arrival of the next user message —
     and claude's session files carry no `result` records, so nothing ever
     gives them a terminal status and they keep the `running` they were born
     with. Measured on a six-record session: every assistant turn but the last
     came back `{"type":"running"}`, so reading a conversation that ended last
     Tuesday showed a column of spinners that never resolve. */
  let changed = state.openIndex >= 0;
  const messages = state.messages.map((m) => {
    if (!m || m.role !== "assistant") return m;
    if (m.status && m.status.type !== "running") return m;
    changed = true;
    return { ...m, status: { type: "complete", reason: "stop" } };
  });
  if (!changed) return state;
  return { ...state, messages, openIndex: -1, running: false };
}

/**
 * How a session row reads.
 *
 * The CLI's own title when it wrote one (claude's `ai-title`, codex's
 * `thread_name`), the first prompt when it did not, and the id only when
 * there is nothing else. This exists so the rule is testable and so a title
 * that is a wall of pasted text cannot break the row.
 *
 * @param {{ title?: string; prompt?: string; id?: string }} session
 */
/**
 * The same session in two or three words, for a tree row rather than a list.
 *
 * ⚠️ THE CLI ALREADY WROTE ONE. Claude Code keeps an `ai-title` record and
 * rewrites it as the session goes (desktop/agent-sessions.js § describeClaude),
 * which is the short summary its own terminal header shows — "Zevet bugs",
 * "Fix the parser". Andrew asked for exactly that: "the icon for the model type
 * next to the 1-3 word blurb like what exists in claude code in the terminal".
 * So a title is taken whole; only a fallback to the prompt gets cut, because a
 * prompt is a paragraph and a rail row is not.
 *
 * @param {{ title?: string; prompt?: string; id?: string }} session
 * @param {number} words how many to keep when falling back to the prompt
 */
export function sessionBlurb(session, words = 3) {
  const s = session || {};
  const titled = unwrapEnvelope(text(s.title)).replace(/\s+/g, " ").trim();
  if (titled) return titled.length > 34 ? `${titled.slice(0, 33)}…` : titled;
  const said = unwrapEnvelope(text(s.prompt)).replace(/\s+/g, " ").trim();
  if (!said) return text(s.id) || "session";
  const cut = said.split(" ").slice(0, Math.max(1, words)).join(" ");
  return cut.length < said.length ? `${cut}…` : cut;
}

export function sessionLabel(session) {
  const s = session || {};
  // Each candidate is peeled on its own, so a title that is ALL envelope falls
  // through to the prompt rather than taking the whole chain down with it.
  const raw =
    unwrapEnvelope(text(s.title)) ||
    unwrapEnvelope(text(s.prompt)) ||
    text(s.id) ||
    "session";
  const one = raw.replace(/\s+/g, " ").trim();
  return one.length > 72 ? `${one.slice(0, 71)}…` : one;
}

/**
 * The person's own words, with the harness's envelope taken off the front.
 *
 * ⚠️ A RECORDED PROMPT IS NOT ONLY WHAT WAS TYPED. Both CLIs prepend machine
 * blocks to the first user message — `<local-command-caveat>`, `<command-name>`,
 * `<system-reminder>`, `<pasted_content>` — and the rail was titling whole
 * sessions "<local-command-caveat>Caveat: Th…", which names the wrapper and
 * never the work. Leading, fully-closed blocks are peeled off one at a time.
 *
 * ⚠️ A PROMPT THAT IS NOTHING BUT AN ENVELOPE RETURNS "". This function first
 * kept the original in that case, on the reasoning that dropping it would be
 * inventing an absence. Seeing it in the deployed app settled it: the People
 * rail announced that somebody was working on
 * "<task-notification>\n<task-id>bkp0qq54x…", which is not a fact about their
 * work, it is our own plumbing read out loud. Nobody typed anything, so there
 * is nothing to show, and every caller already has a fallback for "" — a
 * session falls through to its id, a mission renders no line at all.
 *
 * @param {string} prompt
 * @returns {string} what a person typed, or "" if they typed nothing.
 */
export function unwrapEnvelope(prompt) {
  let out = String(prompt || "").trim();
  // Bounded rather than `while (true)`: a handful of envelopes is the real
  // shape, and a pathological prompt must not spin the render.
  for (let i = 0; i < 12; i++) {
    const closed = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/.exec(out);
    if (closed) {
      out = out.slice(closed[0].length).trim();
      continue;
    }
    /* ⚠️ AN ENVELOPE IS OFTEN NOT CLOSED, BECAUSE IT WAS CUT OFF. A live
       prompt event carries a TRUNCATED `detail`, so a long block arrives with
       its opening tag and no `</…>` anywhere — which is why peeling closed
       blocks alone left "<task-notification>\n<task-id>bkp0qq54x…" on the rail
       after the first attempt at this. Peel the lone opening tag and go round
       again; the tags nested inside it are closed and fall to the branch above.
       ONLY FOR A HYPHENATED OR UNDERSCORED NAME. `task-notification`,
       `local-command-caveat`, `system-reminder`, `pasted_content` — every
       envelope any harness sends is spelled that way, and it is the same rule
       that makes a custom element a custom element. A prompt that opens with
       `<div>` or `<p>` is somebody asking about HTML, and it is left alone. */
    const opener = /^<[a-zA-Z]+[\w]*[-_][\w-]*(?:\s[^>]*)?>\s*/.exec(out);
    if (!opener) break;
    out = out.slice(opener[0].length).trim();
  }
  /* ⚠️ WHAT IS LEFT CAN STILL BE NOTHING BUT TAG SYNTAX, and truncation is
     again the reason: a `detail` cut inside the envelope's own closing tag
     peeled down to the four characters "</ta" and the rail dutifully showed
     them. This is a TEST, not another peel — the residue is thrown away only
     when removing every tag and tag fragment from it leaves no words at all,
     so a prompt that merely contains markup is returned exactly as it came. */
  const words = out.replace(/<\/?[\w-]*(?:\s[^>]*)?>?/g, "").trim();
  return words ? out : "";
}

/**
 * Where a session was typed, in one word, or "" when the file did not say.
 *
 * This is the whole of "detect from the desktop": neither CLI offers a flag,
 * each records a provenance string, and the desktop side buckets them. An
 * unrecognised value arrives as itself rather than as a guess — which is why
 * this falls back to `origin` instead of to "cli".
 *
 * @param {{ surface?: string; origin?: string }} session
 */
export function sessionWhere(session) {
  const s = session || {};
  return text(s.surface) || text(s.origin) || "";
}

/**
 * The project a session belongs to, as a person would name it.
 *
 * claude's directory name is the absolute path with every non-alphanumeric
 * character replaced by a dash, so it cannot be turned back into a path — but
 * the records carry the real `cwd` and the desktop side prefers it. Either way
 * what a list needs is the last segment.
 *
 * @param {{ cwd?: string; slug?: string }} session
 */
export function sessionProject(session) {
  const s = session || {};
  const cwd = text(s.cwd) || text(s.slug);
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] || cwd;
  // An un-slugged name still ends in the folder, just dash-joined:
  // "C--dev-GitHub-zevet" -> "zevet".
  if (parts.length === 1 && last.includes("-")) {
    const bits = last.split("-").filter(Boolean);
    return bits[bits.length - 1] || last;
  }
  return last;
}

/**
 * Does this session match what was typed in the filter box?
 *
 * Title, project, branch and surface, case-insensitively, every word having to
 * match something — so "zevet voice" finds a zevet session about voice rather
 * than every session in either, and "desktop" narrows to the desktop apps.
 *
 * @param {Record<string, unknown>} session
 * @param {string} query
 */
export function sessionMatches(session, query) {
  const q = text(query).trim().toLowerCase();
  if (!q) return true;
  const s = session || {};
  const hay = [s.title, s.prompt, s.cwd, s.slug, s.branch, s.id, s.source, s.surface, s.origin]
    .map((v) => text(v).toLowerCase())
    .join(" ");
  return q.split(/\s+/).every((word) => hay.includes(word));
}
