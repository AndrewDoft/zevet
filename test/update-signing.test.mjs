// The signature scheme both update channels rest on (desktop feed, hub client
// manifest). One CJS implementation for the app, one ESM twin for the client;
// these tests pin them to each other and to the real pinned key.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import * as esm from "../client/signing.mjs";

const cjs = createRequire(import.meta.url)(path.join(ROOT, "desktop", "update-signing.js"));

function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pem: privateKey.export({ format: "pem", type: "pkcs8" }),
    keys: { "zevet-test": publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") },
  };
}

// Signed once with the REAL zevet-2026-09 key over UPDATE_DOMAIN + canonical(DOC).
// Public data. If this stops verifying, the pinned key, the domain bytes or the
// canonicalisation changed, and every installed app would reject every feed.
const DOC = { version: "0.2.84", platforms: { "win32-x64": { bytes: 1, file: "x", sha256: "0".repeat(64) } }, schema: 1 };
const REAL_SIGNATURE = {
  algorithm: "ed25519",
  key_id: "zevet-2026-09",
  signature: "m464gnddVxaD26bT6ZIo4hQjIQIlwyjFBolFzjq00NNEgNGcpdlMl2hvo/4FkN8MVSBA5hE3lwpYyreiuEDHDg==",
};

describe("canonical form", () => {
  test("sorted keys, compact, non-ASCII untouched (Zevet Voice's canonical())", () => {
    const doc = { b: 1, a: [3, { d: null, c: "h\u00e9llo \u2713" }], n: 1.5 };
    assert.equal(cjs.canonicalize(doc), '{"a":[3,{"c":"h\u00e9llo \u2713","d":null}],"b":1,"n":1.5}');
    assert.equal(esm.canonicalize(doc), cjs.canonicalize(doc));
  });
});

describe("verify", () => {
  test("the real pinned key verifies a real signature under the exact domain bytes", () => {
    assert.equal(cjs.UPDATE_DOMAIN, "zevet-update-v1\n");
    assert.equal(cjs.verifySigned(cjs.UPDATE_DOMAIN, DOC, REAL_SIGNATURE), "zevet-2026-09");
  });

  test("a signature made in one domain is worthless in the other", () => {
    const { pem, keys } = testKey();
    const sig = cjs.signDocument(cjs.UPDATE_DOMAIN, DOC, pem, "zevet-test");
    assert.equal(cjs.verifySigned(cjs.UPDATE_DOMAIN, DOC, sig, keys), "zevet-test");
    assert.throws(() => cjs.verifySigned(cjs.CLIENT_DOMAIN, DOC, sig, keys), /does not match/);
    assert.throws(() => esm.verifyClientManifest(DOC, sig, keys), /does not match/);
  });

  test("the CJS signer and the ESM verifier agree", () => {
    const { pem, keys } = testKey();
    const sig = cjs.signDocument(esm.CLIENT_DOMAIN, DOC, pem, "zevet-test");
    assert.equal(esm.verifyClientManifest(DOC, sig, keys), "zevet-test");
  });

  test("tampering, unknown key ids, and malformed envelopes all throw", () => {
    const { pem, keys } = testKey();
    const sig = cjs.signDocument(cjs.UPDATE_DOMAIN, DOC, pem, "zevet-test");
    const v = (doc, env, k = keys) => cjs.verifySigned(cjs.UPDATE_DOMAIN, doc, env, k);
    assert.throws(() => v({ ...DOC, version: "9.9.9" }, sig), /does not match/);
    assert.throws(() => v(DOC, { ...sig, key_id: "zevet-other" }), /untrusted key/);
    assert.throws(() => v(DOC, { ...sig, key_id: "__proto__" }), /untrusted key/);
    assert.throws(() => v(DOC, { ...sig, algorithm: "rsa" }), /ed25519/);
    assert.throws(() => v(DOC, { ...sig, signature: "AAAA" }), /64 bytes/);
    assert.throws(() => v(DOC, undefined), /not signed/);
    assert.throws(() => v(undefined, sig), /not an object/);
    assert.throws(() => v([DOC], sig), /not an object/);
    // A perfectly good signature by a key that is not pinned.
    assert.throws(() => cjs.verifySigned(cjs.UPDATE_DOMAIN, DOC, sig), /untrusted key/);
  });
});

test("pinned keys are 32 raw bytes and identical in both implementations", () => {
  for (const b64 of Object.values(cjs.PINNED_KEYS)) assert.equal(Buffer.from(b64, "base64").length, 32);
  assert.deepEqual(cjs.PINNED_KEYS, esm.PINNED_KEYS);
  assert.ok(readFileSync(path.join(ROOT, "desktop", "update-signing.js"), "utf8").includes("zevet-2026-09"));
});
