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

import { readEnvelope } from "./envelope.mjs";
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
 * The same session in one line, for a tree row rather than a list.
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
 */
// Recorded identifiers are metadata, never a conversation title.
function sessionTitle(s) {
  const title = unwrapEnvelope(text(s.title)).trim();
  return title === text(s.id) || /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{7,40})$/i.test(title) ? "" : title;
}

function sessionFallback(s) {
  if (!s.cwd && !s.repo && (s.source === "claude" || s.source === "codex")) {
    return `${s.source === "claude" ? "Claude" : "Codex"} session`;
  }
  if (!s.cwd && !s.repo) return "Session";
  const repo = String(s.repo || s.cwd || "").split(/[\\/]/).filter(Boolean).pop() || "repo";
  const date = new Date(Number(s.updated ?? s.started ?? 0));
  const time = Number.isNaN(date.getTime()) ? "00:00" : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${titleCase(repo)} ${time}`;
}

/* ⚠️ THE FIRST SENTENCE, NOT THE FIRST THREE WORDS. A three-word cut titled
   twenty agents started from "You are working in …" prompts "You are
   working…", all alike. A sentence is what tells them apart; the row's own
   ellipsis trims it to what fits, so the cap here only bounds a pasted wall. */
export function sessionBlurb(session) {
  const s = session || {};
  const one = firstSentence(unwrapEnvelope(text(sessionTitle(s))) || unwrapEnvelope(text(s.prompt)));
  return one ? (one.length > 80 ? `${one.slice(0, 79)}…` : one) : sessionFallback(s);
}

function firstSentence(said) {
  return said.trim().split(/\n|(?<=[.!?])\s+(?=[A-Z])/)[0].replace(/\s+/g, " ").trim();
}

function cleanTitle(value) {
  let cleaned = unwrapEnvelope(text(value)).trim();
  const preamble = /^(?:RULES\s*\(hard\):|#?\s*RESUME\s*[—:-])\s*/i.exec(cleaned);
  if (preamble) {
    const rest = cleaned.slice(preamble[0].length);
    const task = /(?:^|\n)\s*TASK:\s*(.+?)(?=\n|$)/i.exec(rest);
    const heading = /(?:^|\n)\s*#+\s*(?:Track\s*\d*\s*:\s*|Track\s*:\s*)?(.+?)(?=\n|$)/i.exec(rest);
    cleaned = (task && task[1]) || (heading && heading[1]) || rest;
    if (heading) cleaned = cleaned.split(/\s+[—:-]\s+/, 1)[0];
    const issue = /(?:sentry\s+)?(?:issue\s+)?([A-Z][A-Z0-9]+-[A-Z0-9-]+)/i.exec(cleaned);
    if (task && issue && /sentry/i.test(cleaned)) cleaned = `Sentry ${issue[1]}`;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^you were\s+/i, "");
  cleaned = cleaned.replace(/^TASK:\s*/i, "");
  cleaned = cleaned.replace(/^#+\s*(?:Track\s*\d*\s*:\s*|Track\s*:\s*)?/i, "");
  cleaned = cleaned.replace(/^#+\s*/, "").replace(/^>\s*/, "");
  cleaned = cleaned.replace(/\bClaude session\b|\bUntitled\b/gi, "");
  cleaned = cleaned.replace(/https?:\/\/\S+|[A-Za-z]:[\\/]\S+|\\(?:[^\\/\s]+[\\/])+\S+/g, "");
  return cleaned.replace(/\s+/g, " ").trim().replace(/[.!?…—:-]+$/, "").trim();
}

const STOPWORDS = new Set(["the", "a", "an", "for", "of", "and", "to", "in", "on", "with", "after"]);

function shortWords(value, limit = 20) {
  const words = value.split(/\s+/).filter(Boolean)
    .map((word) => word.replace(/_+/g, " "))
    .flatMap((word) => word.split(/\s+/))
    .map((word) => /[A-Z].*-[A-Z].*-/.test(word) ? word : word.replace(/-+/g, " "))
    .flatMap((word) => word.split(/\s+/));
  const useful = words;
  let out = "";
  for (const word of useful.length ? useful : words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length <= limit) out = next;
    else if (!out) return word.slice(0, limit);
    else break;
  }
  return out || "repo";
}

function titleCase(value) {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function sessionLabel(session, listed = []) {
  const s = session || {};
  const label = cleanTitle(s.label);
  const rawTitle = cleanTitle(sessionTitle(s));
  const rawPrompt = cleanTitle(s.prompt);
  const raw = label || rawTitle || rawPrompt || sessionFallback(s);
  const humanize = Boolean(s.label) || /^(?:RULES|#\s*RESUME)\b/i.test(text(s.title));
  let name = /^(?:Claude|Codex) session$/.test(raw) ? raw : (humanize ? titleCase(shortWords(raw)) : shortWords(raw));
  const collisions = listed.filter((other) => other && other !== s && (
    String(other.label || "") === String(s.label || "") && String(other.title || "") === String(s.title || "") && String(other.prompt || "") === String(s.prompt || "")
  ));
  if (collisions.length) {
    const branch = String(s.branch || "").split(/[\\/]/).filter(Boolean).pop();
    const repo = String(s.repo || s.cwd || "").split(/[\\/]/).filter(Boolean).pop();
    const diff = branch || repo || String(listed.indexOf(s) + 1).padStart(2, "0");
    const room = Math.max(1, 20 - String(diff).length - 1);
    name = `${name.slice(0, room).trim()} ${diff}`.trim();
  }
  return name;
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
 * session falls through to its provider name, a mission renders no line at all.
 *
 * @param {string} prompt
 * @returns {string} what a person typed, or "" if they typed nothing.
 */
export function unwrapEnvelope(prompt) {
  /* ⚠️ A MESSAGE THAT IS *ONLY* ENVELOPE IS NOT PEELED, IT IS READ. The peel
     below takes blocks off the front of something a person then typed; it has
     nothing to say about a record that is the command itself. A session whose
     first record is `/model` is called "/model" — which is what its own
     terminal header says — and one that is a caveat is called nothing at all.
     lib/envelope.mjs is the same classifier the conversation renders with, so
     a title and a turn cannot name the same record differently. */
  const env = readEnvelope(prompt);
  if (env) {
    if (env.kind === "command") return env.args ? `${env.name} ${env.args}` : env.name;
    if (env.kind === "bash") return `! ${env.command}`;
    return "";
  }

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

/**
 * Fold a repo tree's groups so worktrees sit under their base repo.
 *
 * `resolved` groups got their name from agent-sessions.js § repoOf, which reads
 * the worktree's `.git` and already answers the origin — those are trusted as
 * they are, so `zevet-crm` (a real repo) never lands under `zevet`. Only an
 * UNRESOLVED name (its folder is gone, or it was never read off disk) is folded
 * by name: `masora2-w125-fixb` joins `masora2` when a `masora2` group exists,
 * the longest such base winning.
 *
 * @template T
 * @param {Map<string, { rows: T[], resolved: boolean }>} bucket
 * @returns {Map<string, T[]>}
 */
export function foldRepoGroups(bucket) {
  const out = new Map();
  const names = [...bucket.keys()];
  for (const [name, g] of bucket) {
    let into = name;
    if (!g.resolved) {
      for (const base of names) {
        if (base !== name && base.length < name.length && /^[-_.]/.test(name.slice(base.length)) && name.startsWith(base) && (into === name || base.length > into.length)) into = base;
      }
    }
    out.set(into, (out.get(into) || []).concat(g.rows));
  }
  return out;
}
