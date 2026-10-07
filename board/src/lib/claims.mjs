// Advisory path claims on the board (D-070). Pure, so the tests run the file
// that ships. The claims themselves are sealed and opened on the desktop side
// (desktop/claims.js); what reaches the board is already plain.

const base = (p) => String(p).split("/").pop();

/** The folder's name: what a claim's `repo` is, on either kind of slash. */
export function repoNameOf(root) {
  return String(root || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

/** The chip's words: the file name when there is one, else a count. */
export function chipText(paths) {
  return paths.length === 1 ? base(paths[0]) : `${paths.length} files`;
}

/** Every path one session has claimed, or [] . */
export function claimedBySession(claims, session) {
  if (!session) return [];
  return [...new Set((claims || []).filter((c) => c.session === session).flatMap((c) => c.paths))];
}

/** Who holds `path`, or null. `repo` keeps `src/db.ts` in one repo apart from another's. */
export function claimOfPath(claims, path, repo = "") {
  for (const c of claims || []) {
    if (repo && c.repo && c.repo.toLowerCase() !== repo.toLowerCase()) continue;
    if (c.paths.includes(path)) return c;
  }
  return null;
}

const PATHISH = /(?:^|[\s"'`(\[])((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.[A-Za-z][\w]{1,7})(?=[\s"'`)\],:;!?]|\.(?:\s|$)|$)/g;

/** File-looking words in a prompt: where the task says it is going. */
export function pathsIn(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(PATHISH)) {
    const p = m[1].replace(/^\.\//, "").replace(/[.-]+$/, "");
    if (!/^https?:/i.test(p) && /[A-Za-z]/.test(p) && p.length < 200) out.add(p);
  }
  return [...out].slice(0, 20);
}

/** The composer's gate: true to send. No hits sends untouched; otherwise the
 *  person decides ("send" / anything else). Nothing is ever sent unasked. */
export async function gateSend(check, ask) {
  const hits = await check();
  if (!hits || !hits.length) return true;
  return (await ask(hits)) === "send";
}

/** One short line per hit: "overlapping · Kai · s-kai". */
export function hitLine(h) {
  return [h.label, h.actor, h.session ? String(h.session).slice(0, 8) : ""].filter(Boolean).join(" · ");
}
