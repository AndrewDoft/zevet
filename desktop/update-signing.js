"use strict";
// Ed25519 signatures over the update feed. node:crypto only.
//
// Signed bytes are DOMAIN + canonical JSON of the document, so a signature for
// one kind of document (the app feed) is never valid as another (the hub's
// client manifest). Same scheme as Zevet Voice's updates/signing.py:
// canonical = sorted keys, compact separators, non-ASCII left as-is.
//
// client/signing.mjs is the ESM twin used by the hub client; test/update-signing
// .test.mjs pins both to one vector so they cannot drift.
const crypto = require("node:crypto");

/** The domain string is `zevet-update-v1` followed by ONE newline byte (0x0a),
 *  as in Voice's `b"masora-dictation-release-v1\n"`. */
const UPDATE_DOMAIN = "zevet-update-v1\n";
const CLIENT_DOMAIN = "zevet-client-v1\n";

/** Pinned public keys: id -> raw 32-byte ed25519 key, base64. Rotating means
 *  shipping an app that lists both, then retiring the old id. */
const PINNED_KEYS = {
  "zevet-2026-09": "WtLCaM3MBForULoSLJ0tYRmPyr4fOv24wBbugXSahZc=",
};

// DER prefix of an ed25519 SubjectPublicKeyInfo; the raw key follows.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  }
  const s = JSON.stringify(v);
  if (s === undefined) throw new Error("cannot canonicalize a non-JSON value");
  return s;
}

const signedBytes = (domain, doc) => Buffer.from(domain + canonicalize(doc), "utf8");

function publicKeyObject(rawBase64) {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) throw new Error("public key is not 32 bytes");
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Throws unless `envelope` is a valid signature over `doc` by a key in `keys`.
 *  Returns the key id. No fallback: callers treat a throw as "reject". */
function verifySigned(domain, doc, envelope, keys = PINNED_KEYS) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("signed document is not an object");
  if (!envelope || typeof envelope !== "object") throw new Error("the feed is not signed");
  if (envelope.algorithm !== "ed25519") throw new Error("signature algorithm must be ed25519");
  const id = envelope.key_id;
  if (typeof id !== "string" || !Object.hasOwn(keys, id)) throw new Error(`signed by an untrusted key (${JSON.stringify(id)})`);
  if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
    throw new Error("signature is not 64 bytes of base64");
  }
  const ok = crypto.verify(null, signedBytes(domain, doc), publicKeyObject(keys[id]), Buffer.from(envelope.signature, "base64"));
  if (!ok) throw new Error("signature does not match the document");
  return id;
}

function signDocument(domain, doc, privatePem, keyId) {
  const sig = crypto.sign(null, signedBytes(domain, doc), crypto.createPrivateKey(privatePem));
  return { algorithm: "ed25519", key_id: keyId, signature: sig.toString("base64") };
}

module.exports = { UPDATE_DOMAIN, CLIENT_DOMAIN, PINNED_KEYS, canonicalize, verifySigned, signDocument };
