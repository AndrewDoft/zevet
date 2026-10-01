"use strict";
// Which hub this app talks to. The person never sees or types one: a team name
// resolves to its own team on this hub. Self-hosting is an admin setting only
// (docs/self-hosting.md): ZEVET_HUB, or `defaultHub` in ~/.zevet/config.json.

const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");

/** The Masora cloud: web app at /, API at /api, MCP at /mcp, and the hub under /hub (Caddy strips the prefix). */
const PRIMARY_ORIGIN = "https://app.usemasora.com";
/** Serves the same stack until app.usemasora.com has a DNS record. */
const FALLBACK_ORIGIN = "https://app-34-74-69-129.sslip.io";
const LOOKUP_MS = 300;

let picked = "";

function cacheFile() {
  return path.join(require("./zevet-home.js").zevetHome(), "cloud-origin.json");
}

function readCached(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file || cacheFile(), "utf8")).origin;
    return o === PRIMARY_ORIGIN || o === FALLBACK_ORIGIN ? o : "";
  } catch {
    return "";
  }
}

/** ZEVET_CLOUD_ORIGIN, else what launch picked, else the cached pick, else the fallback (always resolves). Sync. */
function cloudOrigin() {
  const env = String(process.env.ZEVET_CLOUD_ORIGIN || "").trim().replace(/\/+$/, "");
  return env || picked || readCached() || FALLBACK_ORIGIN;
}

const hostedHub = () => `${cloudOrigin()}/hub`;

/**
 * Called once at launch, before anything reads the origin. A cached primary costs one file read; otherwise
 * one dns.lookup raced against LOOKUP_MS. A fallback pick is not trusted next launch: DNS may exist by then.
 * @param {{ lookup?: Function, file?: string, timeoutMs?: number }} o
 */
async function pickCloudOrigin({ lookup = dns.promises.lookup, file, timeoutMs = LOOKUP_MS } = {}) {
  if (String(process.env.ZEVET_CLOUD_ORIGIN || "").trim()) return cloudOrigin();
  const f = file || cacheFile();
  let origin = readCached(f);
  if (origin !== PRIMARY_ORIGIN) {
    let timer;
    const resolves = await Promise.race([
      lookup(new URL(PRIMARY_ORIGIN).hostname).then(() => true, () => false),
      new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    origin = resolves ? PRIMARY_ORIGIN : FALLBACK_ORIGIN;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ origin }));
    } catch {
      // an unwritable cache only costs a lookup next launch
    }
  }
  return (picked = origin);
}

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

module.exports = { PRIMARY_ORIGIN, FALLBACK_ORIGIN, cloudOrigin, hostedHub, pickCloudOrigin, DOMAIN_HUB, LEGACY_HUB, resolveHub };
