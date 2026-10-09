import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";

const require = createRequire(import.meta.url);
const { resolveChannel, createPayloadHealth, DAY_MS } = require("../desktop/payload-health.js");
const { signDocument, verifySigned } = require("../desktop/update-signing.js");
const { PULSE_DOMAIN } = require("../desktop/node_modules/@masora/desktop-kit/lib/payload.js");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keys = { test: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };
const pem = privateKey.export({ format: "pem", type: "pkcs8" });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("missing/blank/stable channels default to stable; every other saved channel is healed and logged", (t) => {
  const root = fixture(t), file = path.join(root, "channel"), logs = [];
  const resolve = () => resolveChannel(root, {}, (m) => logs.push(m));
  assert.equal(resolve(), "stable");
  assert.equal(fs.existsSync(file), false);
  for (const channel of ["", "stable\n"]) {
    fs.writeFileSync(file, channel); assert.equal(resolve(), "stable");
  }
  for (const channel of ["canary", "preview", "unknown\nforged log"]) {
    fs.writeFileSync(file, channel); assert.equal(resolve(), "stable");
    assert.equal(fs.readFileSync(file, "utf8"), "stable");
    assert.match(logs.at(-1), /is retired; using stable/);
    assert.equal(logs.at(-1).includes("\n"), false);
  }
  fs.writeFileSync(file, "canary");
  assert.equal(resolveChannel(root, { ZEVET_PAYLOAD_CHANNEL: "preview" }, () => {}), "preview");
  assert.equal(fs.readFileSync(file, "utf8"), "canary");
});

function rig(t, { root = fixture(t), channel = "stable", report, fetchThrows = false } = {}) {
  let clock = 1000, running = "0.2.131", staged = null, result = { status: "none" }, failure = null, invalid = false;
  let doc = { app: "zevet", channel: "stable", platform: "mac-arm64", build: "0.2.137", seq: 2137 };
  const events = [], logs = [], urls = [];
  fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ high_seq: 2131 }));
  const pulseUrl = `https://example.com/p/zevet/${channel}/mac-arm64/pulse.json`;
  const stableUrl = "https://example.com/p/zevet/stable/mac-arm64/pulse.json";
  const health = createPayloadHealth({
    root, channel, platform: "mac-arm64", pulseUrl, stableUrl, runningBuild: () => running,
    verify: (d, s) => verifySigned(PULSE_DOMAIN, d, s, keys), now: () => clock,
    report: report || ((details) => { events.push(details); return "event-id"; }), log: (m) => logs.push(m),
    fetchImpl: async (url) => {
      urls.push(url);
      if (fetchThrows) throw new Error("offline");
      const signature = signDocument(PULSE_DOMAIN, doc, pem, "test");
      return new Response(JSON.stringify({ signed: doc, signature: invalid ? { ...signature, signature: "A".repeat(88) } : signature }));
    },
  });
  const client = {
    staged: () => staged,
    async check() { await health.fetch(pulseUrl); if (failure) throw failure; return result; },
  };
  health.instrument(client);
  return {
    root, client, logs, events, urls,
    clock: (n) => { clock = n; }, running: (n) => { running = n; }, staged: (n) => { staged = n; },
    result: (n) => { result = n; }, failure: (n) => { failure = n; }, invalid: () => { invalid = true; },
    doc: (n) => { doc = { ...doc, ...n }; },
  };
}

test("every non-staged status is logged once per change, including the sequence floor and refusal reason", async (t) => {
  const r = rig(t);
  for (const status of ["none", "refused", "paused", "needs-shell", "not-in-rollout"]) {
    const value = { status, build: "0.2.137", reason: "test reason" };
    r.result(value);
    assert.equal(await r.client.check(), value);
    await r.client.check();
  }
  assert.equal(r.logs.length, 5);
  for (const l of r.logs) { assert.match(l, /"high_seq":2131/); assert.match(l, /test reason/); }
  r.result({ status: "staged" }); await r.client.check();
  assert.equal(r.logs.length, 5);
  r.result({ status: "none" }); await r.client.check();
  assert.equal(r.logs.length, 6);
});

test("stuck telemetry waits more than 24h, survives restart and newer stable pulses, and reports once", async (t) => {
  const r = rig(t);
  await r.client.check();
  r.clock(1000 + DAY_MS); await r.client.check(); assert.equal(r.events.length, 0);
  const next = rig(t, { root: r.root }); // restart must not erase the elapsed time
  next.doc({ build: "0.2.139", seq: 2139 });
  next.clock(1001 + DAY_MS); await next.client.check(); await next.client.check();
  assert.equal(next.events.length, 1);
  assert.deepEqual(next.events[0], { channel: "stable", high_seq: 2131, running_build: "0.2.131", stable_build: "0.2.139", last_status: { status: "none", build: null, reason: null } });
  const again = rig(t, { root: r.root }); again.clock(DAY_MS * 3); await again.client.check();
  assert.equal(again.events.length, 0);
});

test("a staged update or caught-up running build clears the clock", async (t) => {
  for (const mode of ["staged", "current", "rollback"]) {
    const r = rig(t); await r.client.check(); r.clock(DAY_MS * 2);
    if (mode === "staged") r.staged({ build: "0.2.137" });
    if (mode === "current") r.running("0.2.137");
    if (mode === "rollback") r.doc({ build: "0.2.129", seq: 2129, rollback: "0.2.131" });
    await r.client.check(); assert.equal(r.events.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.root, "update-health.json"))), null);
  }
});

test("forged or wrong-platform stable pulses cannot start the stuck clock", async (t) => {
  for (const kind of ["signature", "platform", "channel", "seq"]) {
    const r = rig(t);
    if (kind === "signature") r.invalid();
    else r.doc({ [kind]: kind === "seq" ? 9999 : "wrong" });
    await r.client.check(); r.clock(DAY_MS * 2); await r.client.check();
    assert.equal(r.events.length, 0);
    assert.equal(fs.existsSync(path.join(r.root, "update-health.json")), false);
    assert.ok(r.logs.some((l) => l.includes("observation failed")));
  }
});

test("download failures still accumulate lag and preserve the original rejection", async (t) => {
  const r = rig(t); const error = new Error("blob download failed"); r.failure(error);
  await assert.rejects(r.client.check(), (e) => e === error);
  r.clock(DAY_MS + 1001); await assert.rejects(r.client.check(), (e) => e === error);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].last_status.status, "error");
});

test("an explicit developer channel compares with the signed stable pulse", async (t) => {
  const r = rig(t, { channel: "canary" }); await r.client.check();
  r.clock(DAY_MS + 1001); await r.client.check();
  assert.equal(r.events[0].channel, "canary");
  assert.ok(r.urls.some((u) => u.includes("/stable/")));
});

test("offline diagnostics never turn a successful check into failure; unavailable reporting retries", async (t) => {
  const offline = rig(t, { channel: "canary", fetchThrows: true });
  // The client itself does not need a fetch for this test: only the separate stable probe fails.
  const client = { staged: () => null, check: async () => ({ status: "none" }) };
  const monitor = createPayloadHealth({ root: offline.root, channel: "canary", platform: "mac-arm64", runningBuild: () => "0.2.131", log: () => {}, fetchImpl: async () => { throw new Error("offline"); } });
  monitor.instrument(client); assert.deepEqual(await client.check(), { status: "none" });
  let calls = 0;
  const r = rig(t, { report: () => { calls++; return calls === 1 ? undefined : "event-id"; } });
  await r.client.check(); r.clock(DAY_MS + 1001); await r.client.check(); await r.client.check(); await r.client.check();
  assert.equal(calls, 2);
});
