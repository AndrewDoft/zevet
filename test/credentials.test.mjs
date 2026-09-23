// Personal model credentials (desktop/credentials.js): the on-device half of
// D-0NN. Same shape as test/masora.test.mjs's token round-trip — a stub in
// place of safeStorage, so this runs under plain `node --test` with no
// Electron app.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const home = tempDir("zevet-credentials-cfg-");
process.env.ZEVET_HOME = home.dir;

const require = createRequire(import.meta.url);
const credentials = require(path.join(ROOT, "desktop", "credentials.js"));

/** A reversible stand-in for safeStorage.encryptString/decryptString — see
 *  test/masora.test.mjs's own copy for why this is real enough. */
function fakeCrypto(key = "k") {
  return {
    encrypt: (s) => Buffer.from(`${key}:${s}`, "utf8"),
    decrypt: (buf) => {
      const s = buf.toString("utf8");
      if (!s.startsWith(`${key}:`)) throw new Error("wrong key");
      return s.slice(key.length + 1);
    },
  };
}

describe("personal credentials", () => {
  test("round-trips through the injected encrypt/decrypt and never writes plaintext", () => {
    const { encrypt, decrypt } = fakeCrypto();
    const { id } = credentials.addCredential(
      { label: "my plan", provider: "anthropic", kind: "subscription_token", key: "sk-ant-oat01-supersecret" },
      encrypt,
    );
    assert.equal(credentials.credentialKey(id, decrypt), "sk-ant-oat01-supersecret");

    const raw = JSON.parse(require("node:fs").readFileSync(credentials.CONFIG_PATH, "utf8"));
    assert.doesNotMatch(JSON.stringify(raw), /supersecret/);
  });

  test("listCredentials never contains the encrypted blob, only metadata", () => {
    const { encrypt } = fakeCrypto();
    credentials.addCredential({ label: "work key", provider: "anthropic", kind: "api_key", key: "sk-ant-api03-abc" }, encrypt);
    const list = credentials.listCredentials();
    const rec = list.find((c) => c.label === "work key");
    assert.ok(rec);
    assert.equal(rec.provider, "anthropic");
    assert.equal(rec.kind, "api_key");
    assert.equal(rec.last4, "-abc");
    assert.equal("keyEnc" in rec, false);
    assert.equal("key" in rec, false);
  });

  test("credentialKey fails closed (null, not a throw) when decryption fails — e.g. a config copied to another machine", () => {
    const { encrypt } = fakeCrypto("machine-a");
    const { id } = credentials.addCredential({ provider: "anthropic", kind: "api_key", key: "sk-ant-api03-xyz" }, encrypt);
    const { decrypt: wrongDecrypt } = fakeCrypto("machine-b");
    assert.equal(credentials.credentialKey(id, wrongDecrypt), null);
  });

  test("credentialKey returns null for an id that does not exist", () => {
    const { decrypt } = fakeCrypto();
    assert.equal(credentials.credentialKey("nope", decrypt), null);
  });

  test("removeCredential removes it and reports whether one existed", () => {
    const { encrypt } = fakeCrypto();
    const { id } = credentials.addCredential({ provider: "openai", kind: "api_key", key: "sk-openai-abc" }, encrypt);
    assert.equal(credentials.removeCredential(id), true);
    assert.equal(credentials.listCredentials().some((c) => c.id === id), false);
    assert.equal(credentials.removeCredential(id), false, "already gone");
  });

  test("an unlabelled credential gets a readable default label from its provider and kind", () => {
    const { encrypt } = fakeCrypto();
    const { id } = credentials.addCredential({ provider: "anthropic", kind: "subscription_token", key: "sk-ant-oat01-x" }, encrypt);
    const rec = credentials.listCredentials().find((c) => c.id === id);
    assert.match(rec.label, /subscription token/);
  });
});
