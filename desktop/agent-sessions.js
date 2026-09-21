// zevet desktop — every agent session on this machine, not only the ones
// zevet started.
//
// WHY THIS EXISTS. zevet shows agents it spawned. That is a small fraction of
// the work: most sessions are typed into a terminal or into one of the desktop
// apps, and when they end the only record is a file nobody ever opens.
// Andrew: "zevet should be able to visualize and demonstrate all of my claude
// sessions, including those on terminal", and then "zevet should also detect
// from the desktop (codex and claude desktop apps)". This module is the reader
// for both.
//
// TWO STORES, MEASURED ON THIS MACHINE 2026-09-21:
//
//   claude  ~/.claude/projects/<slug>/<session-id>.jsonl
//           slug = the project's absolute path with every non-alphanumeric
//           character replaced by a dash — the same rule `local:memories` in
//           main.js already relies on. 94 top-level sessions here.
//           Each record carries `entrypoint`, which is what says WHERE the
//           session was typed: "cli", "sdk-cli", and a desktop value for
//           Claude Desktop. All three land in this one store, so the desktop
//           app needs no second reader — only the label.
//
//   codex   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
//           The first record is `session_meta`, whose payload carries `cwd`
//           and `originator`. Measured values: "codex_exec" (the CLI),
//           "Codex Desktop" and "codex_work_desktop". 33 sessions here.
//           ~/.codex/session_index.jsonl maps id -> thread_name, which is
//           codex's own title for the thread.
//
// SUBAGENT TRANSCRIPTS ARE CHILDREN, NOT ROWS. claude writes one per Agent
// call under `<slug>/<session-id>/subagents/agent-<id>.jsonl`, with an
// `agent-<id>.meta.json` beside it naming the agent type, the model and the
// description the parent gave it — 602 of the 696 files here are those. Mixed
// into the top-level list they would be 87% noise, so `list` counts them and
// `children` returns them only for the session you opened.
//
// `subagents/workflows/wf_*/` goes one level deeper still (a Workflow run's
// own agents). Not walked: one level is what a reader can follow, and the
// deeper ones are reachable from the workflow's own card.
//
// READ ONLY, and it must stay that way. These files are the CLIs' own state,
// and a session that is still open is appending to one. There is deliberately
// no writer and no delete here.
//
// SIZE IS THE DESIGN CONSTRAINT. 625 MB across the claude store alone, the
// largest file in the tens of megabytes. So `list` never reads a whole file —
// it reads the first and last 64 KB and takes the rest from stat — and `read`
// caps what it hands over IPC.
//
// CommonJS with no dependencies, same as every other desktop module.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** How much of each end of a file `list` reads for metadata. */
const ENDS = 64 * 1024;
/** Most sessions `list` returns. The UI filters; this bounds the IPC payload. */
const MAX_SESSIONS = 400;
/** Most records `read` returns, newest kept. A very long session is truncated
 *  at the FRONT, because the end is the part you came to see. */
const MAX_RECORDS = 6000;
/** Longest string kept inside a record. A tool result can be a whole file. */
const MAX_STRING = 20000;

const claudeDir = () => path.join(os.homedir(), ".claude", "projects");
const codexDir = () => path.join(os.homedir(), ".codex", "sessions");

/**
 * Containment, by construction.
 *
 * The identifiers come from a renderer, and a renderer is hostile input even
 * when it is our own (the rule local-fs.js is built on). Rather than resolve a
 * caller's path and then check where it landed, this refuses anything that is
 * not a single path-safe segment — no separators, so no `..` — and builds the
 * path itself. There is no traversal left to check for.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** codex's store is dated directories; this is the only shape accepted. */
const DATE_PATH = /^\d{4}\/\d{2}\/\d{2}$/;

function fileFor(source, slug, id, child = "") {
  if (typeof slug !== "string" || typeof id !== "string") return null;
  if (slug.includes("..") || id.includes("..") || !SEGMENT.test(id)) return null;
  if (source === "codex") {
    // codex keeps no per-subagent file; its SubAgentActivity items live in the
    // parent rollout. A child asked for here is a caller error, not a path.
    if (child) return null;
    if (!DATE_PATH.test(slug)) return null;
    return path.join(codexDir(), ...slug.split("/"), `${id}.jsonl`);
  }
  if (!SEGMENT.test(slug)) return null;
  if (child) {
    if (typeof child !== "string" || child.includes("..") || !SEGMENT.test(child)) return null;
    // The `subagents` segment is written here, never taken from the caller.
    return path.join(claudeDir(), slug, id, "subagents", `${child}.jsonl`);
  }
  return path.join(claudeDir(), slug, `${id}.jsonl`);
}

/** How many subagent transcripts a claude session has. A readdir, no reads —
 *  `list` calls this once per session and the meta files are only opened by
 *  `children`, for the one session that was actually opened. */
function countChildren(slug, id) {
  let names;
  try {
    names = fs.readdirSync(path.join(claudeDir(), slug, id, "subagents"));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) if (name.endsWith(".jsonl")) n += 1;
  return n;
}

/** The first and last `ENDS` bytes, as text. A small file is read once. */
function readEnds(file, size) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { head: "", tail: "" };
  }
  try {
    const headLen = Math.min(size, ENDS);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    if (size <= ENDS) return { head: head.toString("utf8"), tail: "" };
    const tail = Buffer.alloc(ENDS);
    fs.readSync(fd, tail, 0, ENDS, size - ENDS);
    return { head: head.toString("utf8"), tail: tail.toString("utf8") };
  } catch {
    return { head: "", tail: "" };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the handle is going away with the process anyway */
    }
  }
}

/** What whole lines a chunk contains. A chunk read from an offset starts
 *  mid-line and a chunk read from 0 may end mid-line; both partials are
 *  dropped rather than guessed at. */
function records(chunk, { fromOffset = false } = {}) {
  const lines = chunk.split("\n");
  if (fromOffset) lines.shift();
  else lines.pop();
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object") out.push(o);
    } catch {
      /* a partial, or a line written while we were reading it */
    }
  }
  return out;
}

const str = (v) => (typeof v === "string" ? v : "");
const oneLine = (v, n) => str(v).replace(/\s+/g, " ").trim().slice(0, n);

function textOfParts(parts) {
  const out = [];
  for (const p of parts) {
    if (p && typeof p.text === "string") out.push(p.text);
  }
  return out.join("\n");
}

/* ---------------------------------------------------------------------------
 * Where a session was typed.
 *
 * This is the whole of "detect from the desktop". Neither CLI offers a flag
 * saying so; each records a provenance string, and the strings are theirs, not
 * ours — so an unrecognised one is reported as itself rather than guessed into
 * a bucket. `surface` is the bucket a UI groups by; `origin` is what the file
 * actually said, kept so a value nobody has seen yet is still visible.
 * ------------------------------------------------------------------------- */

function claudeSurface(entrypoint) {
  const e = str(entrypoint).toLowerCase();
  if (!e) return "";
  if (e.includes("desktop")) return "desktop";
  if (e.includes("vscode") || e.includes("ide")) return "ide";
  if (e.startsWith("sdk")) return "sdk";
  if (e.includes("cli")) return "cli";
  return e;
}

function codexSurface(originator, source) {
  const o = str(originator).toLowerCase();
  const s = str(source).toLowerCase();
  if (o.includes("desktop")) return "desktop";
  if (s === "vscode" || o.includes("vscode")) return "ide";
  if (o.includes("exec") || o.includes("cli")) return "cli";
  return o || s || "";
}

/* ---------------------------------------------------------------------------
 * claude
 * ------------------------------------------------------------------------- */

function describeClaude(slug, id, stat) {
  const { head, tail } = readEnds(path.join(claudeDir(), slug, `${id}.jsonl`), stat.size);
  const front = records(head);
  const back = records(tail, { fromOffset: true });

  let cwd = "";
  let branch = "";
  let version = "";
  let entrypoint = "";
  let started = 0;
  let prompt = "";
  for (const r of front) {
    if (!cwd) cwd = str(r.cwd);
    if (!branch) branch = str(r.gitBranch);
    if (!version) version = str(r.version);
    if (!entrypoint) entrypoint = str(r.entrypoint);
    if (!started && r.timestamp) started = Date.parse(r.timestamp) || 0;
    if (!prompt && r.type === "user" && !r.isSidechain) {
      const c = r.message && r.message.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? textOfParts(c) : "";
      // A session that opens with a slash command or a pasted block is still
      // better named by that than by nothing.
      if (t.trim()) prompt = oneLine(t, 120);
    }
  }

  // Claude Code writes an `ai-title` record and REWRITES it as the session
  // goes on, so the current title is the last one — which is in the tail.
  let title = "";
  let updated = 0;
  for (const r of front.concat(back)) {
    if (r.type === "ai-title" && str(r.aiTitle)) title = str(r.aiTitle);
    if (r.timestamp) {
      const t = Date.parse(r.timestamp) || 0;
      if (t > updated) updated = t;
    }
  }

  return {
    source: "claude",
    id,
    slug,
    // The real path, when the file says it. Un-slugging is lossy — every
    // separator became the same dash — so it is the fallback, not the answer.
    cwd: cwd || slug,
    branch,
    version,
    origin: entrypoint,
    surface: claudeSurface(entrypoint),
    title: title || prompt || id,
    prompt,
    started: started || stat.mtimeMs,
    updated: updated || stat.mtimeMs,
    bytes: stat.size,
    children: countChildren(slug, id),
  };
}

function listClaude() {
  const base = claudeDir();
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    // No Claude Code on this machine, or it has never run. Not an error.
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SEGMENT.test(entry.name)) continue;
    let names;
    try {
      names = fs.readdirSync(path.join(base, entry.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!SEGMENT.test(id)) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(base, entry.name, name));
      } catch {
        continue;
      }
      // A zero-byte file is a session opened and abandoned before it said
      // anything. There is nothing to visualize.
      if (!stat.isFile() || stat.size === 0) continue;
      found.push({ source: "claude", slug: entry.name, id, stat });
    }
  }
  return found;
}

/* ---------------------------------------------------------------------------
 * codex
 * ------------------------------------------------------------------------- */

/** codex's own titles, `id -> thread_name`. One small file, read once per
 *  list. Absent on a machine that has never named a thread. */
function codexTitles() {
  const out = new Map();
  let text;
  try {
    text = fs.readFileSync(path.join(os.homedir(), ".codex", "session_index.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && str(o.id) && str(o.thread_name)) out.set(o.id, o.thread_name);
    } catch {
      /* skip */
    }
  }
  return out;
}

function describeCodex(slug, id, stat, titles) {
  const { head, tail } = readEnds(fileFor("codex", slug, id), stat.size);
  const front = records(head);
  const back = records(tail, { fromOffset: true });

  let meta = {};
  let started = 0;
  let prompt = "";
  let sessionId = "";
  for (const r of front) {
    if (r.type === "session_meta" && r.payload) meta = r.payload;
    if (!started && r.timestamp) started = Date.parse(r.timestamp) || 0;
    const p = r.payload || {};
    if (!prompt && r.type === "event_msg" && p.type === "item_completed" && p.item) {
      if (p.item.type === "UserMessage" && Array.isArray(p.item.content)) {
        const t = textOfParts(p.item.content);
        if (t.trim()) prompt = oneLine(t, 120);
      }
    }
  }
  sessionId = str(meta.session_id) || str(meta.id) || id;

  let updated = 0;
  for (const r of front.concat(back)) {
    if (r.timestamp) {
      const t = Date.parse(r.timestamp) || 0;
      if (t > updated) updated = t;
    }
  }

  const title = titles.get(sessionId) || "";
  // `cwd` in session_meta is a plain path; inside a CommandExecution it is a
  // file:// URL. Only the meta one is used here.
  const cwd = str(meta.cwd);

  return {
    source: "codex",
    id,
    slug,
    sessionId,
    cwd,
    branch: "",
    version: str(meta.cli_version),
    origin: str(meta.originator),
    surface: codexSurface(meta.originator, meta.source),
    title: title || prompt || sessionId,
    prompt,
    started: started || stat.mtimeMs,
    updated: updated || stat.mtimeMs,
    bytes: stat.size,
    // codex records its subagents inline, as SubAgentActivity items in this
    // same file. There is no child transcript to open.
    children: 0,
  };
}

function listCodex() {
  const base = codexDir();
  const found = [];
  // Exactly three levels of dated directories. Walking blind would wander into
  // whatever else ends up under ~/.codex.
  let years;
  try {
    years = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    let months;
    try {
      months = fs.readdirSync(path.join(base, y.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const m of months) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      let days;
      try {
        days = fs.readdirSync(path.join(base, y.name, m.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of days) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        const slug = `${y.name}/${m.name}/${d.name}`;
        let names;
        try {
          names = fs.readdirSync(path.join(base, y.name, m.name, d.name));
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".jsonl")) continue;
          const id = name.slice(0, -".jsonl".length);
          if (!SEGMENT.test(id)) continue;
          let stat;
          try {
            stat = fs.statSync(path.join(base, y.name, m.name, d.name, name));
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size === 0) continue;
          found.push({ source: "codex", slug, id, stat });
        }
      }
    }
  }
  return found;
}

/* ---------------------------------------------------------------------------
 * Public
 * ------------------------------------------------------------------------- */

/**
 * Every session on the machine, newest first, both CLIs and every surface.
 *
 * `cwd` scopes to one project when given. It is NOT a path this opens: for
 * claude it is turned into the slug Claude Code would have used and compared
 * as a string; for codex it is compared against the `cwd` the session
 * recorded. An unknown one therefore matches nothing rather than reaching the
 * filesystem.
 */
function list({ cwd = null, limit = MAX_SESSIONS } = {}) {
  const found = listClaude().concat(listCodex());

  // Sort BEFORE describing. Describing is two file reads each; doing it for
  // every session on the disk in order to show forty is reading 90 MB for
  // nothing.
  found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const cap = Math.max(1, Math.min(MAX_SESSIONS, limit || MAX_SESSIONS));

  /* ⚠️ COMPARED WITHOUT CASE, and that is not tidiness — it is correctness.
   * Claude Code builds the slug from the path IT was given, and on Windows
   * the same directory is reached under more than one spelling: this machine's
   * store holds BOTH `C--dev-GitHub-zevet` and `C--dev-Github-zevet` for one
   * repo (git resolves it as .../Github/..., the shell as .../GitHub/...).
   * A case-sensitive compare therefore showed roughly half the sessions in a
   * folder and looked exactly like a folder with half as many sessions.
   * Measured 2026-09-21: 10 matched with case, 45 without. */
  const wantSlug = cwd ? path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-").toLowerCase() : null;
  const wantCwd = cwd ? path.resolve(cwd).toLowerCase() : null;
  const titles = codexTitles();

  const sessions = [];
  for (const f of found) {
    // The claude filter is on the slug and can be applied before reading;
    // codex records its cwd inside the file, so that one is filtered after.
    if (wantSlug && f.source === "claude" && f.slug.toLowerCase() !== wantSlug) continue;
    const s =
      f.source === "codex"
        ? describeCodex(f.slug, f.id, f.stat, titles)
        : describeClaude(f.slug, f.id, f.stat);
    if (wantCwd && f.source === "codex" && path.resolve(s.cwd || "").toLowerCase() !== wantCwd) {
      continue;
    }
    sessions.push(s);
    if (sessions.length >= cap) break;
  }

  return {
    ok: true,
    dirs: { claude: claudeDir(), codex: codexDir() },
    sessions,
    total: found.length,
  };
}

/**
 * The subagents one claude session spawned, newest first.
 *
 * Each `agent-<id>.jsonl` has an `agent-<id>.meta.json` beside it carrying
 * what the parent asked for — agentType, description, model, spawnDepth — so
 * a row can say "general-purpose · sonnet · Fix IDE view" rather than an
 * opaque id. A transcript whose meta file is missing is still listed: the
 * work happened either way, and dropping it would hide an agent.
 */
function children(slug, id) {
  if (!SEGMENT.test(String(slug)) || !SEGMENT.test(String(id))) {
    return { ok: false, error: "not a session id", children: [] };
  }
  const dir = path.join(claudeDir(), slug, id, "subagents");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    // A session that spawned nothing has no directory. Not an error.
    return { ok: true, dir, children: [] };
  }

  const out = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const childId = name.slice(0, -".jsonl".length);
    if (!SEGMENT.test(childId)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;

    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, `${childId}.meta.json`), "utf8")) || {};
    } catch {
      /* no meta, or half-written while the agent was starting */
    }
    out.push({
      source: "claude",
      id: childId,
      slug,
      parent: id,
      kind: str(meta.agentType),
      model: str(meta.model),
      title: oneLine(meta.description, 120) || childId,
      /* Which Agent tool call in the parent spawned it. Kept so a card in the
         transcript and a row in the list can be recognised as the same run. */
      toolUseId: str(meta.toolUseId),
      depth: Number(meta.spawnDepth) || 1,
      updated: stat.mtimeMs,
      bytes: stat.size,
    });
  }
  out.sort((a, b) => b.updated - a.updated);
  return { ok: true, dir, children: out };
}

/** Strings this long are a file somebody read, not a message. The transcript
 *  renderer truncates for display anyway; this keeps it off the IPC channel. */
function clamp(value) {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}\n… [${value.length - MAX_STRING} more characters]`
      : value;
  }
  if (Array.isArray(value)) return value.map(clamp);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // The thinking signature is a kilobyte of base64 that renders as
      // nothing. It is the single largest thing in a reasoning-heavy session.
      if (k === "signature") continue;
      out[k] = clamp(v);
    }
    return out;
  }
  return value;
}

/**
 * One session's records, ready for board/src/lib/sessions.mjs.
 *
 * SIDECHAINS ARE LEFT OUT of a claude session. A subagent's turns are written
 * into the same file with `isSidechain: true`, interleaved with the parent's.
 * Rendered inline they read as the main conversation suddenly being asked
 * something nobody typed.
 *
 * For codex, only `event_msg`/`item_completed` records are kept. The same
 * content is in the file twice — once as an event and once as a
 * `response_item` for the model's own history — and keeping both renders
 * every message twice.
 */
function read(source, slug, id, child = "") {
  const src = source === "codex" ? "codex" : "claude";
  const file = fileFor(src, slug, id, child);
  if (!file) return { ok: false, error: "not a session id", records: [] };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), records: [] };
  }

  const kept = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;

    if (src === "codex") {
      const p = o.payload;
      if (o.type !== "event_msg" || !p || typeof p !== "object") continue;
      if (p.type !== "item_completed" || !p.item) continue;
      kept.push({ source: "codex", timestamp: str(o.timestamp), item: clamp(p.item) });
      continue;
    }

    /* ⚠️ A SUBAGENT TRANSCRIPT IS ENTIRELY isSidechain. Every record in
       `subagents/agent-<id>.jsonl` carries `isSidechain: true`, because from
       the PARENT's point of view that is exactly what it is. Skipping them
       here — correct for the parent file, where they would interleave into a
       conversation nobody typed — returns an empty transcript for the child
       file, which reads as "this subagent did nothing". */
    if (o.isSidechain && !child) continue;
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (!o.message) continue;
    kept.push({
      source: "claude",
      type: o.type,
      uuid: str(o.uuid),
      timestamp: str(o.timestamp),
      message: clamp(o.message),
    });
  }

  const truncated = kept.length > MAX_RECORDS;
  return {
    ok: true,
    file,
    source: src,
    truncated,
    total: kept.length,
    records: truncated ? kept.slice(kept.length - MAX_RECORDS) : kept,
  };
}

module.exports = { list, read, children, claudeDir, codexDir, _fileFor: fileFor };
