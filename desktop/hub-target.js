"use strict";
// Which hub this app talks to. The person never sees or types one: a team name
// resolves to its own team on this hub. Self-hosting is an admin setting only
// (docs/self-hosting.md): ZEVET_HUB, or `defaultHub` in ~/.zevet/config.json.

/** The Masora cloud: web app at /, API at /api, MCP at /mcp, and the hub under /hub (Caddy strips the prefix). */
const PRIMARY_ORIGIN = "https://app.usemasora.com";

/** ZEVET_CLOUD_ORIGIN (tests/dev), else the cloud. Sync. */
function cloudOrigin() {
  return String(process.env.ZEVET_CLOUD_ORIGIN || "").trim().replace(/\/+$/, "") || PRIMARY_ORIGIN;
}

const hostedHub = () => `${cloudOrigin()}/hub`;

/** The hub's own domain, the default from before the cloud origin. Still served, never decommissioned. */
const DOMAIN_HUB = "https://hub.usemasora.com";

/**
 * The address this shipped BEFORE hub.usemasora.com existed, and never
 * decommissioned — Caddy serves the same hub on both names permanently,
 * specifically so a network that blocks sslip.io (some corporate/school DNS
 * filters do, on principle) is not the only way in, and so a network that
 * cannot resolve the new domain yet is not the only way OUT.
 *
 * The one thing this constant is FOR: main.js's migrateHubDomain compares an
 * existing config's `cfg.hub` against it to know the install is still on the
 * old default (never touches a hub the user or an admin set on purpose).
 */
const LEGACY_HUB = "https://34-74-69-129.sslip.io";

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
  return clean(env.ZEVET_HUB) || clean(cfg && cfg.hub) || clean(cfg && cfg.defaultHub) || hostedHub();
}

module.exports = { PRIMARY_ORIGIN, cloudOrigin, hostedHub, DOMAIN_HUB, LEGACY_HUB, resolveHub };
