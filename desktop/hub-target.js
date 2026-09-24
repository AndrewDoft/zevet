"use strict";
// Which hub this app talks to. The person never sees or types one: a team name
// resolves to its own team on this hub. Self-hosting is an admin setting only
// (docs/self-hosting.md): ZEVET_HUB, or `defaultHub` in ~/.zevet/config.json.

/** The hub the app ships pointing at. */
const HOSTED_HUB = "https://34-74-69-129.sslip.io";

function clean(v) {
  const s = typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
  return /^https?:\/\/[^\s/]+/i.test(s) ? s : "";
}

/**
 * env, then the hub an existing install already stored, then the admin's
 * `defaultHub`, then the hosted one. A renderer never supplies this.
 * @param {{ env?: Record<string,string|undefined>, cfg?: object|null }} from
 */
function resolveHub({ env = {}, cfg = null } = {}) {
  return clean(env.ZEVET_HUB) || clean(cfg && cfg.hub) || clean(cfg && cfg.defaultHub) || HOSTED_HUB;
}

module.exports = { HOSTED_HUB, resolveHub };
