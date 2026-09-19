// Key derivation for zevet's two secrets, which are really one secret.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// zevet is adding collaborative editing, which means file CONTENTS now cross
// the hub. Until now they never did: `client/hook.mjs` sends a tool name, a
// repo-relative path and a scrubbed prompt, and `hub/server.mjs` has no concept
// of "the contents of file X" at all. usemasora.com/zevet says so in as many
// words — "the board sees which file was touched, never what is in it" — and
// that sentence is the reason for the scheme below rather than a consequence
// of it. A relay that forwards plaintext CRDT updates would have made it false
// on the day the editor shipped, and the hub Andrew runs is a box in Google
// Cloud holding, in that case, everybody's source.
//
// So the hub relays ciphertext it cannot read. The whole trick is that the hub
// is never given the secret the key comes from:
//
//     teammates share one master secret S
//
//     auth token  =  SHA-256("zevet-auth\0" || S)       <- the hub gets THIS
//     doc key     =  HKDF-SHA-256(S, info "zevet-doc")  <- the hub never sees S
//
// The hub can check the token it was given against the token it holds, and can
// do nothing else with it. Inverting SHA-256 to recover S is the assumption the
// whole thing rests on, and it is the ordinary one.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES NOT PROTECT AGAINST, stated here because a security property
// that is oversold is worse than one that is absent:
//
//   • A MALICIOUS HUB THAT SERVES BAD BOARD JAVASCRIPT. The board window loads
//     its UI from the hub (`main.js` → `loadURL(cfg.hub)`), so a hub that wants
//     your plaintext does not need the key — it ships JavaScript into the
//     window that already has it. Encryption here defends against a hub that is
//     honest but curious, against whoever can read its memory or its disk, and
//     against anyone who ends up with a copy of its logs. It does not defend
//     against a hub that has been taken over. The fix for that is to stop
//     loading the editor from the hub and serve it from the desktop app's own
//     files; that is a real change and it has NOT been made.
//   • TRAFFIC ANALYSIS. The hub still learns who is editing which file in which
//     repo, when, and roughly how much. That is the board's entire job.
//   • A TEAMMATE. Everyone holding S can read everything. This is a shared-team
//     secret, not per-user keys.
//
// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION COST, accepted deliberately (Andrew, 2026-09-18). Before this,
// `~/.zevet/config.json`'s `token` WAS the hub's `ZEVET_TOKEN`, compared
// byte-for-byte. Now the config holds S and the client presents the derived
// token, so the hub's own env var has to be set to the derived value once. An
// install left alone keeps working only until the hub's env changes; after that
// it gets a 401 and has to re-run setup. There is exactly one deployed hub and
// a small number of installs, which is the only reason this is affordable.
//
// ⚠️ NOT VERIFIED HERE: nothing in this file has been run against the deployed
// hub. It is pure derivation with test vectors of its own making; the moment it
// meets a real `ZEVET_TOKEN` is the moment to check that claim again.

import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A master secret is hex because it travels by hand. `setup.ps1` prints it, a
 * person pastes it into Slack or reads it aloud, and somebody types it on the
 * other end — so the alphabet has to survive a phone call and a terminal that
 * may mangle anything outside ASCII. 24 bytes, the same width the README
 * already tells people to generate with `openssl rand -hex 24`.
 *
 * Accepting a SHORTER secret is refused rather than warned about. A warning at
 * setup time is read once and the install lives for years.
 */
export const SECRET_BYTES = 24;
const MIN_SECRET_HEX = SECRET_BYTES * 2;

/** The domain separators. They are prefixes, not suffixes, and they carry a NUL
 *  so that no value of one label can ever be a prefix of another. With only two
 *  labels this is belt and braces; the cost is nothing and the next label added
 *  by someone who has not read this comment is the one it protects. */
const AUTH_LABEL = Buffer.from("zevet-auth\0", "utf8");
const DOC_INFO = Buffer.from("zevet-doc", "utf8");

/**
 * HKDF needs a salt. A per-install random salt cannot be used: two teammates
 * holding the same S must arrive at the same key without talking to each other
 * about anything else, and there is nowhere to put a salt that the hub is not
 * also allowed to see. A fixed, published salt is the correct construction when
 * the input keying material is already a uniformly random 24-byte secret —
 * HKDF's extract step is there to condition low-entropy input, and this input
 * is not low-entropy. RFC 5869 §3.1 says as much.
 */
const DOC_SALT = Buffer.from("zevet/doc-key/v1", "utf8");

/** AES-256-GCM. 32 bytes. */
export const DOC_KEY_BYTES = 32;

/** Generate a fresh master secret. Hex, lower case. */
export function newMasterSecret() {
  return randomBytes(SECRET_BYTES).toString("hex");
}

/**
 * Accept a master secret the way a human will actually supply it — with
 * whitespace around it, possibly in upper case, possibly wrapped by a mail
 * client. Reject anything that is not hex of at least the required width,
 * because a truncated paste that silently derives a different key would show up
 * as "the board is empty and nobody knows why".
 */
export function normaliseMasterSecret(raw) {
  if (typeof raw !== "string") throw new TypeError("master secret must be a string");
  const s = raw.trim().replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) throw new Error("master secret must be hex");
  if (s.length < MIN_SECRET_HEX) {
    throw new Error(`master secret must be at least ${SECRET_BYTES} bytes (${MIN_SECRET_HEX} hex chars)`);
  }
  if (s.length % 2 !== 0) throw new Error("master secret must be a whole number of bytes");
  return s;
}

/**
 * The value the client presents to the hub, and the value the hub stores in
 * `ZEVET_TOKEN`. Hex, 64 chars.
 *
 * Deliberately a plain hash and not an HMAC or a password KDF: S is already 24
 * random bytes, so there is no dictionary to stretch against and nothing an
 * attacker could grind. Choosing Argon2 here would cost a dependency in a repo
 * that has none and buy exactly nothing.
 */
export function deriveAuthToken(masterSecret) {
  const s = normaliseMasterSecret(masterSecret);
  return createHash("sha256")
    .update(AUTH_LABEL)
    .update(Buffer.from(s, "hex"))
    .digest("hex");
}

/**
 * The AES-256-GCM key for document traffic. Returns raw bytes, never hex —
 * a key that is a string tends to end up in a log line.
 */
export function deriveDocKey(masterSecret) {
  const s = normaliseMasterSecret(masterSecret);
  // hkdfSync returns an ArrayBuffer; Buffer.from wraps it without copying.
  return Buffer.from(hkdfSync("sha256", Buffer.from(s, "hex"), DOC_SALT, DOC_INFO, DOC_KEY_BYTES));
}

/**
 * One place that decides what credential this machine actually has, so that
 * `hook.mjs`, `updater.mjs`, `doctor.mjs` and the desktop app cannot drift into
 * three answers. Every caller reads `~/.zevet/config.json` the same way and
 * lets the environment win; this takes what they found and resolves it.
 *
 * ⚠️ THIS IS DELIBERATELY ADDITIVE, and the `legacy` branch is not dead weight.
 * There are installs in the field whose config holds a raw `token` — the hub's
 * `ZEVET_TOKEN` verbatim — and a change that stopped honouring them would take
 * the board away from everyone the moment they updated, before anyone had
 * touched the hub's env. So a config with a `secret` derives; a config with
 * only a `token` keeps working exactly as it did and says so, and the editor
 * (which needs a key the hub must not hold) is simply unavailable to it.
 *
 * ⚠️ THE TWO CANNOT BOTH BE RIGHT AGAINST ONE HUB. The hub holds a single
 * `ZEVET_TOKEN`; once it is set to the derived value, a legacy install gets a
 * 401. That is the cutover, and it is a coordinated one: set the hub's env and
 * re-run setup everywhere. The fallback buys an ordering, not a coexistence.
 *
 * A malformed secret returns an `error` rather than throwing, because the
 * loudest caller here is `hook.mjs`, which runs on every tool call and is
 * forbidden from throwing. It also does NOT quietly fall back to the legacy
 * token: a typo in the secret that silently swapped credentials would be the
 * "empty board and nobody knows why" failure this project treats as its worst.
 * `doctor.mjs` is where that error is meant to surface.
 */
export function resolveAuth({ env = process.env, file = {} } = {}) {
  const rawSecret = env.ZEVET_SECRET || file.secret || "";
  if (rawSecret) {
    try {
      const secret = normaliseMasterSecret(rawSecret);
      return { token: deriveAuthToken(secret), secret, legacy: false, error: null };
    } catch (err) {
      return { token: "", secret: "", legacy: false, error: err.message };
    }
  }
  const token = env.ZEVET_TOKEN || file.token || "";
  return { token, secret: "", legacy: Boolean(token), error: null };
}

/**
 * Constant-time comparison of two derived tokens.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * length and, worse, crash the caller on a malformed token — so the lengths are
 * compared first and a mismatch answers false rather than raising.
 */
export function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
