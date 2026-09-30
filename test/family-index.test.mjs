// The signed family index: verified against Zevet's OWN keys (never Masora's), and acted on only to check for an
// update sooner. The keys here are throwaway.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { verifyIndex, newerZevet, INDEX_URL } = require(path.join(ROOT, "desktop", "family-index.js"));
const { signDocument, familyIndexKeys, FAMILY_INDEX_KEYS, PINNED_KEYS } = require(path.join(ROOT, "desktop", "update-signing.js"));
const { Family } = require(path.join(ROOT, "desktop", "family.js"));

const DOMAIN = "masora-family-index-v1\n";
const pair = generateKeyPairSync("ed25519");
const PEM = pair.privateKey.export({ format: "pem", type: "pkcs8" });
const KEYS = { "idx-test": pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };

const doc = (zevet = "0.2.200", extra = {}) => ({
  schema: 1,
  type: "family-index",
  issued_at: "2026-09-30T00:00:00Z",
  products: { masora: { version: "0.3.125" }, zevet: { version: zevet }, voice: { version: "0.1.20" }, ...extra },
});
const signed = (d, domain = DOMAIN, pem = PEM) => ({ signed: d, signature: signDocument(domain, d, pem, "idx-test") });
const serve = (body, status = 200) => async (url) => ({ ok: status === 200, status, json: async () => body, url });

describe("verifyIndex", () => {
  test("a validly signed index gives each product's version; unknown products are ignored", () => {
    assert.deepEqual(verifyIndex(signed(doc("0.2.200", { newthing: { version: "9.9.9" } })), KEYS), { masora: "0.3.125", zevet: "0.2.200", voice: "0.1.20" });
  });
  test("refused: another domain, another key, a tampered body, a bad shape, a bad version", () => {
    assert.throws(() => verifyIndex(signed(doc(), "zevet-update-v1\n"), KEYS), /signature does not match/);
    const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    assert.throws(() => verifyIndex(signed(doc(), DOMAIN, other), KEYS), /does not match/);
    const t = signed(doc());
    t.signed.products.zevet.version = "9.9.9";
    assert.throws(() => verifyIndex(t, KEYS), /does not match/);
    assert.throws(() => verifyIndex(signed({ ...doc(), type: "feed" }), KEYS), /not a family index/);
    assert.throws(() => verifyIndex(signed({ ...doc(), products: "none" }), KEYS), /no products/);
    assert.throws(() => verifyIndex(signed(doc("latest")), KEYS), /bad version for zevet/);
    assert.throws(() => verifyIndex({ payload: doc(), signature: signed(doc()).signature }, KEYS), /not signed/); // Masora layout only
  });
  test("an untrusted key id is refused", () => {
    assert.throws(() => verifyIndex(signed(doc()), { "someone-else": KEYS["idx-test"] }), /untrusted key/);
  });
});

describe("newerZevet", () => {
  test("names the version only when it is newer than the running one", async () => {
    assert.equal(await newerZevet({ fetchImpl: serve(signed(doc("0.2.200"))), keys: KEYS, version: "0.2.199" }), "0.2.200");
    assert.equal(await newerZevet({ fetchImpl: serve(signed(doc("0.2.200"))), keys: KEYS, version: "0.2.200" }), null);
    assert.equal(await newerZevet({ fetchImpl: serve(signed(doc("0.2.200"))), keys: KEYS, version: "0.2.201" }), null);
  });
  test("a forged, unreachable or malformed index names nothing and never throws", async () => {
    const logs = [];
    const forged = signed(doc("9.9.9"), DOMAIN, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
    assert.equal(await newerZevet({ fetchImpl: serve(forged), keys: KEYS, version: "0.1.0", log: (m) => logs.push(m) }), null);
    assert.equal(await newerZevet({ fetchImpl: serve({}, 503), keys: KEYS, version: "0.1.0", log: (m) => logs.push(m) }), null);
    assert.equal(await newerZevet({ fetchImpl: async () => { throw new Error("offline"); }, keys: KEYS, version: "0.1.0", log: (m) => logs.push(m) }), null);
    assert.equal(logs.length, 3);
  });
  test("no key to verify against: it does not even fetch", async () => {
    let fetched = 0;
    const fetchImpl = async () => { fetched++; return serve(signed(doc()))(); };
    assert.equal(await newerZevet({ fetchImpl, keys: {}, version: "0.1.0" }), null);
    assert.equal(await newerZevet({ fetchImpl, keys: undefined, version: "0.1.0" }), null);
    assert.equal(fetched, 0);
  });
  test("it asks for the public index URL, refusing redirects", async () => {
    let seen;
    await newerZevet({ fetchImpl: async (u, o) => { seen = [u, o]; return serve(signed(doc()))(); }, keys: KEYS, version: "0.1.0" });
    assert.equal(seen[0], INDEX_URL);
    assert.equal(seen[1].redirect, "error");
  });
});

describe("Zevet's own trust for the index", () => {
  test("no key is pinned by default, and none of Masora's is copied in", () => {
    assert.deepEqual(FAMILY_INDEX_KEYS, {});
    assert.deepEqual(familyIndexKeys({}), {});
    assert.equal(Object.keys(familyIndexKeys({})).some((id) => id.startsWith("masora")), false);
    assert.equal(Object.keys(PINNED_KEYS).every((id) => id.startsWith("zevet")), true);
  });
  test("ZEVET_FAMILY_INDEX_TRUSTED_KEY pins one: <key id>:<raw key, base64>", () => {
    assert.deepEqual(familyIndexKeys({ ZEVET_FAMILY_INDEX_TRUSTED_KEY: "idx-test:AAAA" }), { "idx-test": "AAAA" });
    assert.deepEqual(familyIndexKeys({ ZEVET_FAMILY_INDEX_TRUSTED_KEY: "nocolon" }), {});
  });
});

describe("Family.checkIndex", () => {
  const mk = (over = {}) => {
    const calls = [];
    let t = 1_000_000;
    const f = new Family({
      dir: mkdtempSync(path.join(tmpdir(), "zevet-fidx-")),
      readMasora: () => ({ paired: true }),
      fetchImpl: serve(signed(doc("0.2.200"))),
      detect: async () => null,
      version: "0.2.199",
      indexKeys: KEYS,
      onIndexNewer: (v) => calls.push(v),
      now: () => t,
      ...over,
    });
    return { f, calls, advance: (ms) => { t += ms; } };
  };

  test("a newer Zevet in the index runs the update check", async () => {
    const { f, calls } = mk();
    assert.equal(await f.checkIndex(), "0.2.200");
    assert.deepEqual(calls, ["0.2.200"]);
  });
  test("the same version is acted on once per six hours, not hourly", async () => {
    const { f, calls, advance } = mk();
    await f.checkIndex();
    advance(60 * 60 * 1000);
    assert.equal(await f.checkIndex(), null);
    advance(6 * 60 * 60 * 1000);
    await f.checkIndex();
    assert.equal(calls.length, 2);
  });
  test("current, forged or keyless: no check", async () => {
    const a = mk({ version: "0.2.200" });
    await a.f.checkIndex();
    const b = mk({ indexKeys: {} });
    await b.f.checkIndex();
    const c = mk({ fetchImpl: serve(signed(doc("0.2.200"), "other\n")) });
    await c.f.checkIndex();
    assert.deepEqual([a.calls, b.calls, c.calls], [[], [], []]);
  });
  test("a check that throws is swallowed", async () => {
    const { f } = mk({ onIndexNewer: () => { throw new Error("boom"); } });
    assert.equal(await f.checkIndex(), "0.2.200");
  });
  test("the zevet.request.json path is untouched: a sibling's update request still runs runUpdate", async () => {
    let updates = 0;
    const { f } = mk({ runUpdate: async () => { updates++; } });
    const kit = require(path.join(ROOT, "desktop", "node_modules", "@masora", "desktop-kit"));
    kit.writeRequest(f.dir, "zevet", { action: "update", requested_by: "masora", at: new Date().toISOString() });
    await f.pollRequest();
    assert.equal(updates, 1);
  });
});

describe("main.js wires the index to the updater's check, never its install", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  test("keys from the shell, check() on a newer index, and no install in that path", () => {
    assert.match(main, /indexKeys: familyIndexKeys\(\)/);
    const at = main.indexOf("onIndexNewer:");
    const body = main.slice(at, at + 260);
    assert.match(body, /appUpdater\.check\(\)/);
    assert.doesNotMatch(body, /install/);
  });
});
