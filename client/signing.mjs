// Ed25519 verification of the hub's client manifest. ESM twin of
// desktop/update-signing.js (same scheme, same pinned key) — keep in step;
// test/update-signing.test.mjs pins both to one vector.
//
// Domain is `zevet-client-v1` + one newline byte (0x0a).
import crypto from "node:crypto";
import { insecureHub } from "./secret.mjs";

export const CLIENT_DOMAIN = "zevet-client-v1\n";
export const PINNED_KEYS = { "zevet-2026-09": "WtLCaM3MBForULoSLJ0tYRmPyr4fOv24wBbugXSahZc=" };
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
  }
  const s = JSON.stringify(v);
  if (s === undefined) throw new Error("cannot canonicalize a non-JSON value");
  return s;
}

/** Throws unless `envelope` signs `doc` under CLIENT_DOMAIN with a pinned key. Returns the key id. */
export function verifyClientManifest(doc, envelope, keys = PINNED_KEYS) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("signed document is not an object");
  if (!envelope || typeof envelope !== "object") throw new Error("the manifest is not signed");
  if (envelope.algorithm !== "ed25519") throw new Error("signature algorithm must be ed25519");
  const id = envelope.key_id;
  if (typeof id !== "string" || !Object.hasOwn(keys, id)) throw new Error(`signed by an untrusted key (${JSON.stringify(id)})`);
  if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
    throw new Error("signature is not 64 bytes of base64");
  }
  const raw = Buffer.from(keys[id], "base64");
  if (raw.length !== 32) throw new Error("public key is not 32 bytes");
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  const ok = crypto.verify(null, Buffer.from(CLIENT_DOMAIN + canonicalize(doc), "utf8"), key, Buffer.from(envelope.signature, "base64"));
  if (!ok) throw new Error("signature does not match the document");
  return id;
}

/**
 * The manifest to act on: the SIGNED payload's files, or an error string.
 * Unsigned is accepted only behind ZEVET_ALLOW_UNSIGNED_MANIFEST=1.
 * ZEVET_HUB_TRUSTED_KEY ("<id>:<raw key base64>") adds a trusted key, for a
 * loopback hub only (tests, local dev) so it can never redirect trust for a
 * real hub.
 */
export function readSignedManifest(remote, { hub, env = process.env } = {}) {
  if (!remote || typeof remote !== "object") return { error: "not shaped like a manifest" };
  if (remote.payload === undefined && remote.signature === undefined && env.ZEVET_ALLOW_UNSIGNED_MANIFEST === "1") {
    return { manifest: remote, unsigned: true };
  }
  let keys = PINNED_KEYS;
  const spec = env.ZEVET_HUB_TRUSTED_KEY;
  if (spec && !insecureHub(hub) && new URL(hub).protocol === "http:" && spec.includes(":")) {
    const i = spec.indexOf(":");
    keys = { ...PINNED_KEYS, [spec.slice(0, i)]: spec.slice(i + 1) };
  }
  try {
    verifyClientManifest(remote.payload, remote.signature, keys);
  } catch (err) {
    return { error: `the manifest is not validly signed: ${err.message}` };
  }
  return { manifest: remote.payload };
}
