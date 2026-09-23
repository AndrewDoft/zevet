// Personal model credentials — kept ONLY on this machine, never sent to the
// hub or any team member. Same precedent as desktop/masora.js's device token
// (DECISIONS.md D-010): Electron's `safeStorage`, OS-keychain-backed, no new
// dependency. `encrypt`/`decrypt` are injected rather than required at the
// top, so this loads and is testable under plain `node --test` with no
// Electron app running (main.js is the only caller that passes the real
// safeStorage).
//
// Team credentials are the hub's job (hub/accounts.mjs + hub/server.mjs's
// /team/credentials routes) — this file only ever holds this one person's
// own keys, e.g. a personal Claude subscription token a team-shared API key
// cannot represent (D-0NN: a subscription is single-person by nature).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CONFIG_PATH = path.join(HOME, "credentials.json");

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" && Array.isArray(parsed.credentials)
      ? parsed
      : { credentials: [] };
  } catch {
    return { credentials: [] };
  }
}

function writeRaw(raw) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows uses ACLs; every secret in this file is encrypted either way.
  }
}

/** Metadata only — never `keyEnc`, same rule masora.js's readConfig()
 *  follows for its own token. This is what the board's settings list and
 *  the spawn-time env lookup are both allowed to see without decrypting. */
function listCredentials() {
  return readRaw().credentials.map(({ keyEnc, ...meta }) => meta);
}

/** `encrypt` is `string -> Buffer`, i.e. `safeStorage.encryptString` bound
 *  by the caller (main.js), or a reversible fake in tests. Returns the new
 *  record's id. */
function addCredential({ label, provider, kind, key }, encrypt) {
  const raw = readRaw();
  const rec = {
    id: crypto.randomBytes(8).toString("hex"),
    label: String(label || "").trim() || `${provider} ${kind === "subscription_token" ? "subscription token" : "key"}`,
    provider: String(provider),
    kind: String(kind),
    last4: String(key).slice(-4),
    keyEnc: encrypt(String(key)).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  raw.credentials.push(rec);
  writeRaw(raw);
  return { id: rec.id };
}

/** Returns whether one existed to remove. */
function removeCredential(id) {
  const raw = readRaw();
  const before = raw.credentials.length;
  raw.credentials = raw.credentials.filter((c) => c.id !== id);
  if (raw.credentials.length === before) return false;
  writeRaw(raw);
  return true;
}

/** `decrypt` is `Buffer -> string`, i.e. `safeStorage.decryptString` bound
 *  by the caller. Returns null — never throws — for no such id, or a blob
 *  that cannot be decrypted (encrypted on a different machine/user, or
 *  safeStorage unavailable): both fold to "no credential" for a spawn path
 *  that must never crash the app over a missing key. */
function credentialKey(id, decrypt) {
  const c = readRaw().credentials.find((c) => c.id === id);
  if (!c) return null;
  try {
    return decrypt(Buffer.from(c.keyEnc, "base64"));
  } catch {
    return null;
  }
}

module.exports = {
  CONFIG_PATH,
  listCredentials,
  addCredential,
  removeCredential,
  credentialKey,
};
