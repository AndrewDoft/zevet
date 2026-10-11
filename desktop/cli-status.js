// Whether a vendor CLI is really signed in, asked of the CLI itself: `claude auth status` (JSON) and
// `codex login status`. An auth file proves nothing (a revoked login leaves it behind). This is the
// only way a subscription is looked at: no token is read, no request is made on its behalf.
//
// Verdict: { loggedIn: true | false | null, method?, plan?, at }. null = the CLI could not be run or
// timed out; it never overwrites a known answer. Stale-while-revalidate, so asking never blocks the UI.
"use strict";

const TTL_MS = 2 * 60_000;
const ARGS = { claude: ["auth", "status"], codex: ["login", "status"] };

/** Pure: a CLI's exit code and output -> verdict (without `at`). */
function interpret(agent, rc, out) {
  const text = String(out || "");
  if (agent === "claude") {
    try {
      const d = JSON.parse(text);
      if (rc !== 0 || !d || d.loggedIn !== true) return { loggedIn: false };
      const plan = typeof d.subscriptionType === "string" ? d.subscriptionType.trim() : "";
      const email = typeof d.email === "string" ? d.email.trim() : "";
      return { loggedIn: true, method: d.authMethod === "claude.ai" ? "plan" : "key", ...(plan ? { plan } : {}), ...(email ? { email } : {}) };
    } catch {
      return { loggedIn: false };
    }
  }
  const low = text.toLowerCase();
  if (rc !== 0 || !low.includes("logged in") || low.includes("not logged in")) return { loggedIn: false };
  return { loggedIn: true, method: low.includes("chatgpt") ? "plan" : "key" };
}

/** `run(agent, args)` -> Promise<{rc, out} | null>, supplied by main.js (resolves the binary, hidden window). */
function createCliStatus({ run, now = Date.now, ttlMs = TTL_MS, waitMs = 9000 }) {
  const cache = new Map();
  const inflight = new Map();

  function refresh(agent) {
    if (!ARGS[agent]) return Promise.resolve({ loggedIn: null, at: now() });
    if (inflight.has(agent)) return inflight.get(agent);
    const p = (async () => {
      let r = null;
      try { r = await run(agent, ARGS[agent]); } catch { r = null; }
      const prev = cache.get(agent);
      // Unknown keeps the last real answer, and its age.
      const v = r ? { ...interpret(agent, r.rc, r.out), at: now() } : prev ? { ...prev } : { loggedIn: null, at: now() };
      cache.set(agent, v);
      return v;
    })().finally(() => inflight.delete(agent));
    inflight.set(agent, p);
    return p;
  }

  /** The cached verdict at once; a stale one starts a background refresh. With nothing cached yet it waits (bounded) for the first answer. */
  async function get(agent) {
    const hit = cache.get(agent);
    if (hit && now() - hit.at < ttlMs) return hit;
    const fresh = refresh(agent);
    if (hit) return hit;
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r({ loggedIn: null, at: now() }), waitMs); });
    try { return await Promise.race([fresh, late]); } finally { clearTimeout(timer); }
  }

  return { get, refresh, peek: (agent) => cache.get(agent) };
}

module.exports = { createCliStatus, interpret };
