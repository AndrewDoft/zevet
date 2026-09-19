// Sealing for document traffic. The hub relays these blobs and cannot read one.
//
// The scheme is AES-256-GCM with a random 96-bit nonce, under the key
// `deriveDocKey` produces from the team's master secret (see secret.mjs for why
// the hub is never given that secret).
//
//     frame = VERSION(1) || NONCE(12) || CIPHERTEXT || TAG(16)
//
// The version byte is not decoration. The first time this scheme changes, every
// install in the field is holding blobs written by the old one, and a length
// check alone would turn that into a decryption failure with no diagnosis. One
// byte buys a specific error message years from now.
//
// ⚠️ THE ROOM NAME IS AUTHENTICATED, NOT JUST THE PAYLOAD. It goes in as GCM's
// additional data, so a hub that takes a sealed update from `repo:src/db.ts`
// and replays it into `repo:src/auth.ts` produces an authentication failure
// rather than a silent corruption of a file nobody was editing. A relay is in
// exactly the position to try this, and it is the one attack a dumb relay can
// mount without breaking the encryption at all. AAD costs nothing and closes
// it.
//
// ⚠️ NONCE REUSE IS THE ONE FATAL MISTAKE with GCM, so it is worth being
// explicit about why random nonces are safe here. 96-bit random nonces collide
// at the birthday bound, around 2^32 messages under one key before the risk
// stops being negligible. Document traffic is debounced to roughly 20 messages
// a second while someone is actually typing, so 2^32 is on the order of seven
// years of continuous, uninterrupted typing by one team on one master secret.
// The alternative -- a counter -- would need every participant to coordinate a
// disjoint counter space, which is more state, more to get wrong, and worse
// when a client restarts and forgets where it was. Rotate the master secret if
// a team ever gets near this; nothing here does it for you.
//
// ⚠️ NOT VERIFIED: this has never run against the hub, and no two machines have
// ever exchanged a sealed update. It is unit-tested against itself only.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES;

/** The smallest possible frame: version, nonce, empty ciphertext, tag. */
export const MIN_FRAME_BYTES = HEADER_BYTES + TAG_BYTES;

function assertKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new TypeError("doc key must be 32 bytes");
  }
}

/**
 * Room names are the additional data. They are UTF-8 strings chosen by the
 * client (`<repo>:<relative path>`), never by the hub.
 */
function aadFor(room) {
  if (typeof room !== "string" || room.length === 0) {
    throw new TypeError("room must be a non-empty string");
  }
  return Buffer.from(room, "utf8");
}

/**
 * Seal one message. Returns a fresh Buffer; the input is not modified.
 */
export function seal(key, room, plaintext) {
  assertKey(key);
  const body = plaintext instanceof Uint8Array ? plaintext : Buffer.from(plaintext);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aadFor(room));
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, ct, cipher.getAuthTag()]);
}

/**
 * Open one message, or throw.
 *
 * Every failure path throws rather than returning null, and the caller is
 * expected to treat a throw as "drop this message and keep the connection".
 * A relay that can make a client fall over by sending it nine bad bytes is a
 * denial of service with extra steps.
 */
export function open(key, room, frame) {
  assertKey(key);
  const buf = frame instanceof Uint8Array ? Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength) : Buffer.from(frame);
  if (buf.length < MIN_FRAME_BYTES) {
    throw new Error(`sealed frame too short: ${buf.length} < ${MIN_FRAME_BYTES}`);
  }
  if (buf[0] !== VERSION) {
    throw new Error(`unknown sealed frame version ${buf[0]}, expected ${VERSION}`);
  }
  const nonce = buf.subarray(1, HEADER_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(HEADER_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aadFor(room));
  decipher.setAuthTag(tag);
  // `final()` is what actually verifies the tag. Skipping it -- which is easy to
  // do, because `update()` already returns the plaintext -- turns authenticated
  // encryption into unauthenticated encryption and is a classic way to ship a
  // scheme that looks right and defends nothing.
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
