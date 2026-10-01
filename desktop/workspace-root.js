"use strict";
const path = require("path");

/**
 * The folder a renderer-supplied root resolves to, or null if it is not one the
 * user opened. Pure so the guard can be tested without Electron.
 *
 * Accepted: an opened workspace itself, anything inside one, and a git worktree
 * whose ORIGIN checkout is one (an agent thread rooted at its worktree). Nothing
 * else: the renderer is untrusted, so an unrelated folder stays refused.
 */
function resolveKnown(root, workspaces, originOf) {
  const want = path.resolve(String(root || ""));
  const open = workspaces.map((d) => path.resolve(d));
  if (open.some((d) => d === want)) return want;
  const inside = open.some((d) => {
    const rel = path.relative(d, want);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (inside) return want;
  const origin = originOf(want);
  return origin && open.includes(path.resolve(origin)) ? want : null;
}

/** What every handler replies when `resolveKnown` refuses. The board matches it. */
const NOT_OPEN = "not an opened workspace";

module.exports = { resolveKnown, NOT_OPEN };
