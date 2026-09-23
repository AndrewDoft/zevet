// Plan utilization for a credential, used by the "Auto" ladder
// (desktop/credential-ladder.js) to decide when to roll to the next rung.
//
// `fetchImpl` is injected (default global `fetch`), same reasoning as
// agent-console.js's `spawn` — a real probe hits api.anthropic.com and
// spends nothing, but a test suite that has to do that on every run is a
// suite nobody runs. `now` is injected too, so the 60s cache is testable
// without a real minute passing.
"use strict";

const CACHE_MS = 60 * 1000;

/** credentialId -> { value, at } */
const cache = new Map();

/**
 * `credential` is `{provider, kind, key}` (what main.js's `resolveCredential`
 * already produces for spawning). Returns the utilization as a fraction
 * 0..1, or undefined if it could not be determined — an unsupported
 * provider, or the probe request itself failing. credential-ladder.js's
 * `choose()` treats undefined as "skip this rung", never as 0 or 1.
 *
 * Cached per credential id for CACHE_MS: the ladder is walked on every agent
 * spawn, and re-probing every rung on every spawn would be one live request
 * to api.anthropic.com per rung per launch for no benefit — usage does not
 * move that fast.
 */
async function utilizationFor(id, credential, { fetchImpl = fetch, now = Date.now } = {}) {
  const cached = cache.get(id);
  if (cached && now() - cached.at < CACHE_MS) return cached.value;

  const value = await probe(credential, fetchImpl);
  cache.set(id, { value, at: now() });
  return value;
}

async function probe({ provider, kind, key } = {}, fetchImpl) {
  if (provider !== "anthropic" || !key) return undefined;
  let res;
  try {
    res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return undefined;
  }

  if (kind !== "subscription_token") {
    // api_key: no plan window to report at all. 0 (fully available) unless
    // the probe itself failed, in which case the credential is unusable and
    // the ladder should skip this rung, not treat it as wide open.
    return res.ok ? 0 : undefined;
  }

  const h5 = Number(res.headers.get("anthropic-ratelimit-unified-5h-utilization"));
  const h7 = Number(res.headers.get("anthropic-ratelimit-unified-7d-utilization"));
  if (Number.isNaN(h5) && Number.isNaN(h7)) return undefined;
  return Math.max(Number.isNaN(h5) ? 0 : h5, Number.isNaN(h7) ? 0 : h7);
}

/** Test-only: drop every cached reading. */
function _clearCache() {
  cache.clear();
}

module.exports = { utilizationFor, _clearCache };
