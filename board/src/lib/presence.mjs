import { agentName } from "./mentions.mjs";
/**
 * Where is an agent editing? Pure functions, no DOM, no Yjs: the hook records
 * what a tool is ABOUT to do (PreToolUse is all it reports), the desktop hands
 * that over when the file changes on disk, and this finds the lines in the
 * settled text.
 *
 * HONESTY RULE: a range is returned only when the new text is found in the file
 * exactly once. Not found, truncated, or ambiguous means null, and the caller
 * shows the agent on the file tab only. A guessed line is worse than none.
 */

/** An agent's range disappears this long after the last edit that located it. */
export const AGENT_TTL_MS = 10_000;
/** A hint older than this at the moment the file changes is not about that change. */
export const HINT_MAX_AGE_MS = 20_000;

/** "Mina · Claude" */
export function agentLabel(actor, agent) {
  return `${actor || "someone"} · ${agentName(String(agent || "").toLowerCase())}`;
}

/** A stable awareness clientID for one actor's agent (FNV-1a, never 0). Real
 *  clientIDs are random 32-bit ints, so a collision is a 2^-32 event. */
export function agentClientId(actor, agent) {
  let h = 0x811c9dc5;
  const s = `zevet-agent\0${actor}\0${agent}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

const str = (v) => (typeof v === "string" && v ? v : null);

/**
 * The text a tool call is about to write, per file.
 *   Claude Code Edit       { file_path, new_string }
 *   Claude Code MultiEdit  { file_path, edits: [{ new_string }] }
 *   opencode edit          { filePath, newString }
 *   Codex apply_patch      { command: "*** Begin Patch ..." } (also `input`/`patch`)
 * Write/whole-file tools are skipped on purpose: the "range" would be the whole
 * file, which says nothing.
 * @returns {Array<{file: string|null, blocks: string[]}>}
 */
export function extractEdits(tool, input) {
  const i = input && typeof input === "object" ? input : {};
  const file = str(i.file_path) || str(i.filePath) || str(i.path);
  const patch = str(i.command) || str(i.patch) || str(i.input);
  if (patch && /^\*\*\* Begin Patch/m.test(patch)) return patchBlocks(patch);
  const one = str(i.new_string) ?? str(i.newString);
  if (one != null) return [{ file, blocks: [one] }];
  if (Array.isArray(i.edits)) {
    const blocks = i.edits.map((e) => (e && (str(e.new_string) ?? str(e.newString))) || null).filter(Boolean);
    if (blocks.length) return [{ file, blocks }];
  }
  return [];
}

/** Added-line blocks of an apply_patch body, per file. "Add File" is skipped (whole file). */
export function patchBlocks(patch) {
  const out = [];
  let cur = null;
  let run = null;
  const flush = () => {
    if (run && cur) cur.blocks.push(run.join("\n"));
    run = null;
  };
  for (const raw of String(patch).split(/\r?\n/)) {
    const upd = /^\*\*\* Update File: (.+)$/.exec(raw);
    if (upd || /^\*\*\* (Add|Delete) File: /.test(raw) || raw.startsWith("*** End Patch")) {
      flush();
      cur = upd ? { file: upd[1].trim(), blocks: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) (run ||= []).push(raw.slice(1));
    else flush();
  }
  flush();
  return out.filter((e) => e.blocks.length);
}

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** Does a path as the agent wrote it (absolute, or relative to its cwd) name `relPath`? */
export function sameFile(agentPath, relPath) {
  const a = norm(agentPath);
  const r = norm(relPath);
  if (!a || !r) return false;
  return a === r || a.endsWith("/" + r);
}

/** 1-based line of a char offset. */
function lineAt(text, index) {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * Find ONE block in `text`. Exact match first, then with outer whitespace
 * trimmed (agents often add or drop a trailing newline). Two matches is not an
 * answer.
 * @returns {{from:number,to:number,fromLine:number,toLine:number}|null}
 */
export function locateBlock(text, block) {
  const t = String(text ?? "");
  for (const needle of [block, String(block).trim()]) {
    if (!needle) continue;
    const at = t.indexOf(needle);
    if (at === -1) continue;
    if (t.indexOf(needle, at + 1) !== -1) return null;
    const to = at + needle.length;
    return { from: at, to, fromLine: lineAt(t, at), toLine: lineAt(t, Math.max(at, to - (needle.endsWith("\n") ? 1 : 0))) };
  }
  return null;
}

/** The span covering every block that located. Blocks that did not are ignored,
 *  never guessed at; null if none did. */
export function locateEdit(text, blocks) {
  let best = null;
  for (const b of blocks || []) {
    const r = locateBlock(text, b);
    if (!r) continue;
    best = best
      ? { from: Math.min(best.from, r.from), to: Math.max(best.to, r.to), fromLine: Math.min(best.fromLine, r.fromLine), toLine: Math.max(best.toLine, r.toLine) }
      : r;
  }
  return best;
}

/**
 * Hints (as the desktop spooled them) -> ranges for one open file.
 * hint = { ts, actor, agent, tool, input }.  Newest first; one per actor+agent.
 * @returns {Array<{actor:string,agent:string,tool:string,ts:number,from:number,to:number,fromLine:number,toLine:number}>}
 */
export function agentRanges(hints, relPath, text, now = Date.now()) {
  const seen = new Set();
  const out = [];
  const fresh = (hints || []).filter((h) => h && now - Number(h.ts) <= HINT_MAX_AGE_MS).sort((a, b) => b.ts - a.ts);
  for (const h of fresh) {
    const id = `${h.actor}\0${h.agent}`;
    if (seen.has(id)) continue;
    const mine = extractEdits(h.tool, h.input).filter((e) => e.file == null || sameFile(e.file, relPath));
    const r = locateEdit(text, mine.flatMap((e) => e.blocks));
    if (!r) continue;
    seen.add(id);
    out.push({ actor: h.actor, agent: h.agent, tool: h.tool, ts: h.ts, ...r });
  }
  return out;
}
