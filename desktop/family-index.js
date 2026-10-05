// The signed family index, read the way Masora reads it (masora2 apps/desktop/shell/family-updates.js
// verifyIndex; contract docs/contracts/family_updates.md). It names each product's current version. Zevet uses
// one line of it: when it names a newer Zevet than this one, check the update feed now instead of at the next
// hourly tick. The installer still comes only from Zevet's own signed feed (app-update.js), so this is a
// nudge and never a path for code. Electron-free; family.js owns the timers.
"use strict";

const kit = require("@masora/desktop-kit");

const INDEX_URL = "https://usemasora.com/download/masora-family-latest.json";
/** Masora's domain for this document, so no product feed's signature can be replayed as an index. The KEYS are
 *  Zevet's own and live in the shell (update-signing.js familyIndexKeys); main.js passes them in. */
const FAMILY_INDEX_DOMAIN = "masora-family-index-v1\n";
const PRODUCTS = ["masora", "zevet", "voice"];
const VERSION = /^\d+(?:\.\d+){0,3}$/;

/** The signed index -> { masora, zevet, voice } versions (any subset). Throws when it does not verify
 *  against `keys` or is malformed: an index that cannot be trusted names nothing. */
function verifyIndex(body, keys) {
  const doc = kit.verifyFeed(body, FAMILY_INDEX_DOMAIN, keys, "signed");
  if (doc.schema !== 1 || doc.type !== "family-index") throw new Error("not a family index");
  if (!doc.products || typeof doc.products !== "object") throw new Error("index names no products");
  const versions = {};
  for (const [name, entry] of Object.entries(doc.products)) {
    if (!PRODUCTS.includes(name)) continue;
    if (!entry || typeof entry.version !== "string" || !VERSION.test(entry.version)) throw new Error(`bad version for ${name}`);
    versions[name] = entry.version;
  }
  return versions;
}

/** One pass. Returns the newer Zevet version the index names, else null. Never throws. With no key to verify
 *  against it does not even fetch. */
async function newerZevet({ fetchImpl = fetch, keys, version, url = INDEX_URL, log = () => {} }) {
  if (!keys || Object.keys(keys).length === 0) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" });
    if (!res.ok) throw new Error(`index returned ${res.status}`);
    const named = verifyIndex(await res.json(), keys).zevet;
    return named && kit.compareVersions(version, named) < 0 ? named : null;
  } catch (err) {
    log(`family index: ${err.message}`);
    return null;
  }
}

module.exports = { INDEX_URL, verifyIndex, newerZevet };
