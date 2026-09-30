"use strict";
// Ed25519 signatures over the update feed. The scheme lives in @masora/desktop-kit;
// this file is Zevet's domains and pinned keys.
//
// Signed bytes are DOMAIN + canonical JSON of the document, so a signature for
// one kind of document (the app feed) is never valid as another (the hub's
// client manifest). Same scheme as Zevet Voice's updates/signing.py:
// canonical = sorted keys, compact separators, non-ASCII left as-is.
//
// client/signing.mjs is the ESM twin used by the hub client; test/update-signing
// .test.mjs pins both to one vector so they cannot drift.
const kit = require("@masora/desktop-kit");

/** The domain string is `zevet-update-v1` followed by ONE newline byte (0x0a),
 *  as in Voice's `b"masora-dictation-release-v1\n"`. */
const UPDATE_DOMAIN = "zevet-update-v1\n";
const CLIENT_DOMAIN = "zevet-client-v1\n";

/** Pinned public keys: id -> raw 32-byte ed25519 key, base64. Rotating means
 *  shipping an app that lists both, then retiring the old id. */
const PINNED_KEYS = {
  "zevet-2026-09": "WtLCaM3MBForULoSLJ0tYRmPyr4fOv24wBbugXSahZc=",
};

/** The family index (https://usemasora.com/download/masora-family-latest.json, verified by family-index.js) is
 *  published by Masora's release process under its own domain. Zevet only uses it to decide WHEN to check its
 *  own signed feed, so a forged index costs one request to the download host and nothing else.
 *
 *  ⚠️ No key is pinned here: Zevet never copies another product's keys. Until the publisher's public key is
 *  added to FAMILY_INDEX_KEYS (a Zevet release), or set as ZEVET_FAMILY_INDEX_TRUSTED_KEY=<key id>:<raw
 *  ed25519 key, base64>, every index fails to verify and the poll stays off. */
const FAMILY_INDEX_KEYS = {};

/** The keys an index may be signed with: the pinned set plus the env-pinned one. */
function familyIndexKeys(env = process.env) {
  const spec = env.ZEVET_FAMILY_INDEX_TRUSTED_KEY;
  const i = spec ? spec.indexOf(":") : -1;
  return i > 0 ? { ...FAMILY_INDEX_KEYS, [spec.slice(0, i)]: spec.slice(i + 1) } : { ...FAMILY_INDEX_KEYS };
}

/** Throws unless `envelope` is a valid signature over `doc` by a key in `keys`
 *  (default: the pinned set). Returns the key id. No fallback: a throw is "reject". */
const verifySigned = (domain, doc, envelope, keys = PINNED_KEYS) => kit.verifySigned(domain, doc, envelope, keys);

module.exports = { UPDATE_DOMAIN, CLIENT_DOMAIN, PINNED_KEYS, FAMILY_INDEX_KEYS, familyIndexKeys, canonicalize: kit.canonicalize, verifySigned, signDocument: kit.signDocument };
