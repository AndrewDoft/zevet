// The two halves of "the hub relays what it cannot read": deriving the keys,
// and sealing under them.
//
// What these tests CANNOT establish, and nothing at this level could: that
// AES-256-GCM and HKDF-SHA-256 are sound. Those are node:crypto's, and taking
// them on trust is the point of using them. What is tested here is the part
// that is actually ours and is therefore the part we can get wrong —
// domain separation between the two derived values, and the framing around the
// cipher, including the one attack a relay is in a position to try.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DOC_KEY_BYTES,
  SECRET_BYTES,
  deriveAuthToken,
  deriveDocKey,
  newMasterSecret,
  normaliseMasterSecret,
  sameToken,
} from "../client/secret.mjs";
import { MIN_FRAME_BYTES, VERSION, open, seal } from "../client/doc-crypto.mjs";

/** A fixed secret, so the vectors below are stable across runs. */
const S = "0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210fedcba9876543210";

describe("master secrets", () => {
  test("a generated secret is the advertised width and round-trips", () => {
    const s = newMasterSecret();
    assert.equal(s.length, SECRET_BYTES * 2);
    assert.match(s, /^[0-9a-f]+$/);
    assert.equal(normaliseMasterSecret(s), s);
  });

  test("two generated secrets differ", () => {
    // Not a randomness test -- it catches the specific bug of returning a
    // constant, which is the one that would otherwise pass everything else here.
    assert.notEqual(newMasterSecret(), newMasterSecret());
  });

  test("a secret survives the ways a person will actually paste it", () => {
    // Read aloud, pasted out of a mail client that wrapped it, typed in caps.
    assert.equal(normaliseMasterSecret(`  ${S.toUpperCase()}  `), S);
    assert.equal(normaliseMasterSecret(S.slice(0, 24) + "\n" + S.slice(24)), S);
  });

  test("a truncated or malformed secret is refused, not warned about", () => {
    assert.throws(() => normaliseMasterSecret(S.slice(0, 40)), /at least/);
    assert.throws(() => normaliseMasterSecret("not hex at all"), /hex/);
    assert.throws(() => normaliseMasterSecret(S + "a"), /whole number of bytes/);
    assert.throws(() => normaliseMasterSecret(null), TypeError);
  });
});

describe("derivation", () => {
  test("the auth token is 64 hex chars and deterministic", () => {
    const a = deriveAuthToken(S);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, deriveAuthToken(S));
  });

  test("the auth token is not the secret", () => {
    // The whole scheme rests on the hub being given something other than S.
    // This is the assertion that fails if someone ever "simplifies" it back.
    assert.notEqual(deriveAuthToken(S), S);
    assert.ok(!deriveAuthToken(S).includes(S));
  });

  test("the doc key is 32 bytes and deterministic", () => {
    const k = deriveDocKey(S);
    assert.equal(k.length, DOC_KEY_BYTES);
    assert.deepEqual(k, deriveDocKey(S));
  });

  test("the two derived values are independent of each other", () => {
    // Domain separation. If the labels were ever dropped, these would coincide
    // or one would be a prefix of the other, and the hub -- which holds the
    // auth token -- would hold the document key.
    const token = deriveAuthToken(S);
    const key = deriveDocKey(S);
    assert.notEqual(key.toString("hex"), token);
    assert.ok(!token.startsWith(key.toString("hex").slice(0, 32)));
  });

  test("different secrets give different everything", () => {
    assert.notEqual(deriveAuthToken(S), deriveAuthToken(OTHER));
    assert.notDeepEqual(deriveDocKey(S), deriveDocKey(OTHER));
  });

  test("normalisation happens before derivation", () => {
    // Otherwise the teammate who pasted with a trailing newline silently gets a
    // different key and an empty board, which is the failure this project calls
    // its worst.
    assert.equal(deriveAuthToken(` ${S.toUpperCase()}\n`), deriveAuthToken(S));
    assert.deepEqual(deriveDocKey(` ${S.toUpperCase()}\n`), deriveDocKey(S));
  });

  test("sameToken compares without throwing on a length mismatch", () => {
    assert.ok(sameToken(deriveAuthToken(S), deriveAuthToken(S)));
    assert.ok(!sameToken(deriveAuthToken(S), deriveAuthToken(OTHER)));
    assert.ok(!sameToken("short", deriveAuthToken(S)));
    assert.ok(!sameToken(null, deriveAuthToken(S)));
  });
});

describe("sealing", () => {
  const key = deriveDocKey(S);
  const room = "masora:src/db.ts";
  const msg = Buffer.from("a yjs update would be binary; this is legible on failure");

  test("a sealed message round-trips", () => {
    assert.deepEqual(open(key, room, seal(key, room, msg)), msg);
  });

  test("an empty payload round-trips", () => {
    const sealed = seal(key, room, Buffer.alloc(0));
    assert.equal(sealed.length, MIN_FRAME_BYTES);
    assert.deepEqual(open(key, room, sealed), Buffer.alloc(0));
  });

  test("the frame is version, nonce, ciphertext, tag", () => {
    const sealed = seal(key, room, msg);
    assert.equal(sealed[0], VERSION);
    assert.equal(sealed.length, msg.length + MIN_FRAME_BYTES);
  });

  test("sealing the same bytes twice gives different frames", () => {
    // A fresh nonce every time. Equal frames would mean a fixed nonce, which is
    // the one mistake that breaks GCM outright.
    const a = seal(key, room, msg);
    const b = seal(key, room, msg);
    assert.notDeepEqual(a, b);
    assert.notDeepEqual(a.subarray(1, 13), b.subarray(1, 13));
  });

  test("the hub cannot read it without the key", () => {
    const sealed = seal(key, room, msg);
    assert.ok(!sealed.includes(msg), "plaintext appears in the sealed frame");
    assert.throws(() => open(deriveDocKey(OTHER), room, sealed));
  });

  test("a message cannot be replayed into another room", () => {
    // THE attack a dumb relay can mount: take an update for one file and hand
    // it to everyone editing a different one. The room name is GCM's additional
    // data precisely so this fails closed.
    const sealed = seal(key, "masora:src/db.ts", msg);
    assert.throws(() => open(key, "masora:src/auth.ts", sealed));
  });

  test("a flipped bit anywhere is caught", () => {
    const sealed = seal(key, room, msg);
    for (const i of [1, 6, 20, sealed.length - 1]) {
      const bad = Buffer.from(sealed);
      bad[i] ^= 0x01;
      assert.throws(() => open(key, room, bad), `byte ${i} was not authenticated`);
    }
  });

  test("a truncated frame throws rather than crashing oddly", () => {
    const sealed = seal(key, room, msg);
    assert.throws(() => open(key, room, sealed.subarray(0, MIN_FRAME_BYTES - 1)), /too short/);
    assert.throws(() => open(key, room, Buffer.alloc(0)), /too short/);
  });

  test("an unknown version says so by name", () => {
    const sealed = seal(key, room, msg);
    sealed[0] = 99;
    assert.throws(() => open(key, room, sealed), /version 99/);
  });

  test("a wrong-sized key is refused at the door", () => {
    assert.throws(() => seal(Buffer.alloc(16), room, msg), TypeError);
    assert.throws(() => open(Buffer.alloc(16), room, seal(key, room, msg)), TypeError);
  });

  test("an empty room name is refused", () => {
    // Not pedantry: an empty AAD would authenticate nothing, and the replay
    // above would start passing.
    assert.throws(() => seal(key, "", msg), TypeError);
  });
});
