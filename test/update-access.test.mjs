// Contract tests: fake cloud responses, real encrypted files, and the actual
// updater stream/hash code. Electron's OS keychain adapter stays in main.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
const { UpdateAccess, encryptionAvailable } = require("../desktop/update-access.js");
const { AppUpdater } = require("../desktop/app-update.js");
const PRODUCT = "zevet";
const ORIGIN = "https://usemasora.com";
const REGISTER = `${ORIGIN}/api/connector/register`;
const FEED = `${ORIGIN}/download/${PRODUCT === "context" ? "masora-context" : PRODUCT}-latest.json`;
const TOKEN = `paup_${"a".repeat(32)}_${"A".repeat(43)}`;
const NEW_TOKEN = `paup_${"b".repeat(32)}_${"B".repeat(43)}`;
const code = { device_code: "private-poll-code", user_code: "ABCD-EFG2", verify_url: `${ORIGIN}/access?device_code=ABCD-EFG2` };
const grant = (token = TOKEN) => ({ token, kind: "updates", product: PRODUCT, device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function encryptedStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
function fixture(t, fetchImpl = async () => { throw new Error("Unexpected network request"); }, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-updates-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const storage = encryptedStorage();
  const config = { product: PRODUCT, file: path.join(dir, "update-access.json"), storage,
    platform: "darwin", fetchImpl, sleep: async () => {}, ...options };
  return { dir, storage, config, access: new UpdateAccess(config) };
}
function service(polls, starts = []) {
  return async (url, options) => {
    assert.equal(url, REGISTER);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(new Headers(options.headers).get("authorization"), null);
    const body = JSON.parse(options.body);
    if (!body.device_code) {
      assert.deepEqual(body, { kind: "updates", product: PRODUCT, name: "Test app", platform: "darwin" });
      starts.push(body);
      return json(code);
    }
    assert.deepEqual(body, { device_code: code.device_code });
    assert.ok(polls.length, "polling must terminate");
    const next = polls.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}
const approval = { name: "Test app", approve: async ({ userCode, verifyUrl }) => {
  assert.equal(userCode, code.user_code);
  assert.equal(verifyUrl, code.verify_url);
  assert.ok(!verifyUrl.includes(code.device_code));
  return true;
} };

test("missing credentials never fetch a public feed or start browser pairing", async (t) => {
  const { access } = fixture(t);
  await assert.rejects(access.fetch(FEED), { code: "update_access_required" });
});

test("a fresh automatic check never touches the OS keychain", async (t) => {
  let keychainCalls = 0, networkCalls = 0;
  const { access, dir } = fixture(t, async () => { networkCalls++; }, {
    storage: { isEncryptionAvailable() { keychainCalls++; throw new Error("OS prompt would block here"); } },
  });
  const state = await makeUpdater(dir, access).check();
  assert.equal(state.phase, "error");
  assert.equal(state.authRequired, true);
  assert.equal(keychainCalls, 0, "a missing credential must not initialize the OS keychain");
  assert.equal(networkCalls, 0);
});

test("one-time browser approval persists only ciphertext and survives relaunch", async (t) => {
  const starts = [];
  const { access, config } = fixture(t, service([json({}, 428), json(grant())], starts));
  const first = access.connect(approval);
  assert.equal(access.connect(approval), first, "repeated clicks share approval");
  assert.equal(await first, true);
  assert.equal(starts.length, 1);
  const stored = fs.readFileSync(config.file, "utf8");
  assert.ok(!stored.includes(TOKEN));
  assert.ok(!stored.includes(code.device_code));
  assert.equal(JSON.parse(stored).product, PRODUCT);
  if (process.platform !== "win32") assert.equal(fs.statSync(config.file).mode & 0o777, 0o600);
  assert.equal(new UpdateAccess(config).readToken(), TOKEN);
  assert.deepEqual(fs.readdirSync(path.dirname(config.file)), ["update-access.json"]);
});

test("OS encryption unavailable, insecure Linux fallback, or wrong OS account require sign-in", async (t) => {
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(encryptionAvailable({ isEncryptionAvailable: () => false }, platform), false);
  }
  for (const backend of ["basic_text", "unknown", "future-unknown-backend"]) {
    assert.equal(encryptionAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, "linux"), false);
  }
  const { access, config } = fixture(t);
  access.saveToken(TOKEN, "device-1");
  assert.equal(new UpdateAccess({ ...config, storage: encryptedStorage() }).readToken(), null);
  const insecure = new UpdateAccess({ ...config, storage: { isEncryptionAvailable: () => false } });
  await assert.rejects(insecure.connect(approval), /OS keychain/);
  assert.equal(insecure.readToken(), null);
});

test("corrupt, plaintext, or another product's saved grant is unusable", (t) => {
  const { access, config } = fixture(t);
  for (const data of ["{", JSON.stringify({ token: TOKEN }), JSON.stringify({ version: 1, origin: ORIGIN, product: "wrong", token_enc: "anything" })]) {
    fs.writeFileSync(config.file, data);
    assert.equal(access.readToken(), null);
  }
});

for (const [status, message] of [[403, /denied/], [404, /expired or was already used/], [500, /could not finish/]]) {
  test(`approval ${status} ends without saving or retrying`, async (t) => {
    const polls = [json({}, status)];
    const { access, config } = fixture(t, service(polls));
    await assert.rejects(access.connect(approval), message);
    assert.equal(polls.length, 0);
    assert.equal(fs.existsSync(config.file), false);
  });
}

test("cancel does not poll; pending approval has a finite deadline", async (t) => {
  const { access } = fixture(t, service([]));
  assert.equal(await access.connect({ ...approval, approve: async () => false }), false);
  let now = 0, polls = 0;
  const timed = fixture(t, async (_url, opts) => {
    if (JSON.parse(opts.body).device_code) { polls++; return json({}, 428); }
    return json(code);
  }, { now: () => now, sleep: async (ms) => { now += ms; } }).access;
  await assert.rejects(timed.connect(approval), /timed out/);
  assert.equal(polls, 179);
});

for (const wrong of [{ product: "other" }, { kind: "connector" }, { token: "pacon_local_data_token" }, { device_id: null }, { device_id: "not-a-uuid" }, { token: `paup_${"a".repeat(40)}` }, { token: `paup_${"a".repeat(32)}_${"A".repeat(42)}` }]) {
  test(`invalid grant ${JSON.stringify(wrong)} is never stored`, async (t) => {
    const { access, config } = fixture(t, service([json({ ...grant(), ...wrong })]));
    await assert.rejects(access.connect(approval), /wrong update product/);
    assert.equal(fs.existsSync(config.file), false);
  });
}

for (const verify_url of ["https://evil.example/access?device_code=ABCD-EFG2", `${ORIGIN}/access?device_code=private-poll-code`, `${code.verify_url}&token=secret`, `${code.verify_url}#token`, `https://user:pass@usemasora.com/access?device_code=ABCD-EFG2`]) {
  test(`untrusted approval address is never opened: ${verify_url}`, async (t) => {
    let opened = false;
    const { access } = fixture(t, async () => json({ ...code, verify_url }));
    await assert.rejects(access.connect({ approve: async () => { opened = true; return true; } }), /invalid update approval address/);
    assert.equal(opened, false);
  });
}

for (const user_code of ["abcd-EFG2", "ABCD-1234", "ABCD-8888", "ABCD-EFGH-extra"]) {
  test(`malformed public code is rejected: ${user_code}`, async (t) => {
    let opened = false;
    const { access } = fixture(t, async () => json({ ...code, user_code, verify_url: `${ORIGIN}/access?device_code=${user_code}` }));
    await assert.rejects(access.connect({ approve: async () => { opened = true; return true; } }), /invalid update approval address/);
    assert.equal(opened, false);
  });
}

test("bearer is restricted to fixed-host direct download requests", async (t) => {
  const calls = [];
  const { access } = fixture(t, async (url, opts) => {
    calls.push(url);
    assert.equal(new Headers(opts.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(new Headers(opts.headers).get("cookie"), null);
    assert.equal(new Headers(opts.headers).get("accept"), "application/json");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.credentials, "omit");
    return json({});
  });
  access.saveToken(TOKEN, "device-1");
  await access.fetch(FEED, { redirect: "follow", credentials: "include", headers: { cookie: "private=1", accept: "application/json" } });
  for (const url of ["https://evil.example/download/build.exe", "http://usemasora.com/download/build.exe", `${FEED}?token=secret`, `${FEED}#secret`, `${ORIGIN}/api/users`, `${ORIGIN}/download/nested/build.exe`, "broken"]) {
    await assert.rejects(access.fetch(url), /directly from Masora/);
  }
  assert.deepEqual(calls, [FEED]);
});

for (const status of [401, 403]) {
  test(`download ${status} invalidates saved access and prevents an anonymous retry`, async (t) => {
    let requests = 0;
    const { access, config } = fixture(t, async () => { requests++; return json({}, status); });
    access.saveToken(TOKEN, "device-1");
    await assert.rejects(access.fetch(FEED), { code: "update_access_required" });
    assert.equal(fs.existsSync(config.file), false);
    await assert.rejects(access.fetch(FEED), { code: "update_access_required" });
    assert.equal(requests, 1);
  });
}

test("network and redirect failures retain the grant and sanitize transport errors", async (t) => {
  const secretError = new Error(`Authorization: Bearer ${TOKEN}`);
  const { access } = fixture(t, async () => { throw secretError; });
  access.saveToken(TOKEN, "device-1");
  await assert.rejects(access.fetch(FEED), (error) => !error.message.includes(TOKEN) && error.code !== "update_access_required");
  assert.equal(access.readToken(), TOKEN);
  const pairing = fixture(t, service([secretError])).access;
  await assert.rejects(pairing.connect(approval), (error) => !error.message.includes(TOKEN) && /Try again/.test(error.message));
});

function makeUpdater(dir, access, log = () => {}) {
  return new AppUpdater({ currentVersion: "0.1.0", feedUrl: FEED, platform: "darwin", arch: "arm64", platformKey: "darwin-arm64",
    dir: path.join(dir, "downloads"), downloadDir: path.join(dir, "downloads"), fetchImpl: (url, opts) => access.fetch(url, opts), log });
}
function manifest(bytes, advertised = bytes) {
  return { version: "9.0.0", platforms: { "darwin-arm64": {
    file: `${PRODUCT === "context" ? "masora-context" : PRODUCT}-9.0.0-macos-arm64.dmg`, bytes: bytes.length,
    sha256: createHash("sha256").update(advertised).digest("hex"),
  } } };
}
for (const fault of [null, "binary-denied", "checksum"]) {
  test(`real updater authorizes metadata and binary and preserves verification: ${fault}`, async (t) => {
    const bytes = randomBytes(1024), seen = [], logs = [];
    const m = manifest(bytes, fault === "checksum" ? randomBytes(bytes.length) : bytes);
    let revoked = false;
    const { access, dir } = fixture(t, async (url, options) => {
      assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(options.redirect, "error");
      seen.push(url);
      if (revoked || (url !== FEED && fault === "binary-denied")) return json({}, 403);
      return url === FEED ? json(m) : new Response(bytes);
    });
    access.saveToken(TOKEN, "device-1");
    const updater = makeUpdater(dir, access, (line) => logs.push(line));
    const state = await updater.check();
    assert.equal(seen.length, 2);
    assert.equal(state.phase, fault ? "error" : "ready");
    assert.equal(Boolean(state.authRequired), fault === "binary-denied");
    assert.ok(!logs.join("\n").includes(TOKEN));
    if (!fault) {
      const cached = makeUpdater(dir, access);
      assert.equal((await cached.check()).phase, "ready");
      assert.equal(seen.length, 3, "cached installer still requires an authenticated manifest");
      revoked = true;
      const denied = await cached.check();
      assert.equal(denied.phase, "error");
      assert.equal(denied.authRequired, true);
    } else {
      assert.deepEqual(fs.readdirSync(path.join(dir, "downloads")), []);
    }
  });
}

for (const denyReplacement of [false, true]) {
  test(`manual refresh pairs once and retries once; replacement denied=${denyReplacement}`, async (t) => {
    let starts = 0, polls = 0, downloads = 0, approvals = 0;
    const bytes = randomBytes(128);
    const { access, dir } = fixture(t, async (url, opts) => {
      if (url === REGISTER) {
        if (JSON.parse(opts.body).device_code) { polls++; return json(grant(NEW_TOKEN)); }
        starts++; return json(code);
      }
      downloads++;
      if (new Headers(opts.headers).get("authorization") === `Bearer ${TOKEN}` || denyReplacement) return json({}, 401);
      return url === FEED ? json(manifest(bytes)) : new Response(bytes);
    });
    access.saveToken(TOKEN, "device-old");
    const updater = makeUpdater(dir, access);
    const config = { check: () => updater.check(), name: "Test app", approve: async () => { approvals++; return true; },
      setError: (error) => ({ phase: "error", authRequired: true, error }) };
    const first = access.manualCheck(config);
    assert.equal(access.manualCheck(config), first);
    const state = await first;
    assert.equal(state.phase, denyReplacement ? "error" : "ready");
    assert.equal(starts, 1); assert.equal(polls, 1); assert.equal(approvals, 1);
    assert.equal(downloads, denyReplacement ? 2 : 3);
    assert.equal(access.readToken(), denyReplacement ? null : NEW_TOKEN);
  });
}
