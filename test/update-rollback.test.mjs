import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Ported from masora2 apps/desktop/shell/test/update-rollback.test.mjs, with Zevet's injected installer arguments.

const { decideBoot, createRollback, STATE_FILE } = createRequire(import.meta.url)("../desktop/update-rollback.js");

const pending = { from: "0.3.124", to: "0.3.125", prev: { version: "0.3.124", file: "old.exe", bytes: 3, sha256: "a" }, rolledBack: false };
const dec = (o) => decideBoot({ running: "0.3.125", pending, boot: null, canRollback: true, ...o }).action;

test("decideBoot", () => {
  assert.equal(dec({ pending: null }), "none");
  assert.equal(dec({ boot: { ok: true } }), "confirm");
  assert.equal(dec({ boot: { ok: false, reason: "unhealthy" } }), "retry");   // one slow boot is not a verdict (§9.1)
  assert.equal(dec({ boot: { ok: false, reason: "timeout" } }), "retry");
  assert.equal(dec({ boot: { ok: false, reason: "unhealthy" }, pending: { ...pending, strikes: 1 } }), "rollback");
  assert.equal(dec({ boot: { ok: false, reason: "crashed" }, migrated: true }), "report");
  assert.equal(dec({ boot: { ok: false, reason: "crashed" } }), "rollback");
  assert.equal(dec({ boot: { ok: false, reason: "crashed" }, canRollback: false }), "report");
  assert.equal(dec({ boot: { ok: false, reason: "foreign" } }), "none");   // another program on the port says nothing about the build
  assert.equal(dec({ boot: null }), "none");
  assert.equal(dec({ running: "0.3.124" }), "clear");                       // the installer never took
  assert.equal(dec({ running: "0.3.124", pending: { ...pending, rolledBack: true } }), "settle");
});

function harness({ platform = "win32", onDisk = true, signed = true } = {}) {
  const head = { v: 5 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-"));
  const calls = { spawn: [], stop: 0, quit: 0, report: [] };
  const mk = (running) => createRollback({
    dir, running, platform, schemaHead: () => head.v,
    installArgs: () => ["--updated", "/S", "--force-run", "/currentuser", "/D=C:\zevet"],
    spawnOptions: { windowsVerbatimArguments: true },
    spawn: (f, a, o) => { calls.spawn.push([path.basename(f), a]); calls.opts = o; return { unref() {}, on(ev, fn) { calls.on = (calls.on || []).concat(ev); calls.onError = fn; } }; },
    verifyPublisher: async () => signed,
    verifiedOnDisk: async () => onDisk,
    stopRuntime: async () => { calls.stop++; },
    quit: () => { calls.quit++; },
    report: (e, tags) => calls.report.push([e.message, tags]),
    setTimeoutImpl: (fn) => { fn(); },
  });
  return { dir, calls, mk, head };
}
const entry = (n) => ({ file: `${n}.exe`, bytes: 3, sha256: "b" });

test("a healthy first launch confirms and becomes the next rollback target", async () => {
  const { mk, dir } = harness();
  const a = mk("0.3.124");
  a.beginInstall({ to: "0.3.125", entry: entry("new") });
  const b = mk("0.3.125");
  assert.equal(await b.afterBoot({ ok: true }), "confirm");
  const s = b.state();
  assert.equal(s.pending, null);
  assert.equal(s.lastGood.version, "0.3.125");
  assert.ok(b.keepFiles().has("new.exe"));
  b.beginInstall({ to: "0.3.126", entry: entry("newer") });
  assert.equal(b.state().pending.prev.file, "new.exe");
  assert.ok(fs.existsSync(path.join(dir, STATE_FILE)));
});

/** A machine that got to 0.3.124 by installer, so 0.3.125 has a way back. */
async function installedWithPrev(h) {
  const a = h.mk("0.3.123");
  a.beginInstall({ to: "0.3.124", entry: { file: "old.exe", bytes: 3, sha256: "a" } });
  await h.mk("0.3.124").afterBoot({ ok: true });
  const b = h.mk("0.3.124");
  b.beginInstall({ to: "0.3.125", entry: entry("new") });
  return h.mk("0.3.125");
}

test("an unhealthy first launch runs the previous installer, reports, and withdraws the version", async () => {
  const h = harness();
  const b = await installedWithPrev(h);
  assert.equal(await b.afterBoot({ ok: false, reason: "crashed" }), "rolling-back");
  assert.deepEqual(h.calls.spawn, [["old.exe", ["--updated", "/S", "--force-run", "/currentuser", "/D=C:\zevet"]]]);
  assert.equal(h.calls.opts.windowsVerbatimArguments, true);   // /D= must reach NSIS unquoted
  assert.equal(h.calls.stop, 1);
  assert.equal(h.calls.quit, 1);
  assert.equal(h.calls.report.length, 1);
  assert.equal(b.offerable("0.3.125"), false);
  // relaunched on the old version: settles, and the bad version stays withdrawn
  const c = h.mk("0.3.124");
  assert.equal(await c.afterBoot({ ok: true }), "settle");
  assert.equal(c.state().pending, null);
  assert.equal(c.offerable("0.3.125"), false);
  assert.equal(c.state().lastGood.file, "old.exe");
});

test("no usable previous installer: report, withdraw, stay put", async () => {
  for (const opts of [{ onDisk: false }, { signed: false }]) {
    const h = harness(opts);
    const b = await installedWithPrev(h);
    assert.equal(await b.afterBoot({ ok: false, reason: "crashed" }), "reported");
    assert.equal(h.calls.spawn.length, 0);
    assert.equal(h.calls.report.length, 1);
    assert.equal(b.offerable("0.3.125"), false);
    assert.equal(b.state().pending, null);
  }
});

test("no previous installer at all (first update on this machine) reports only", async () => {
  const h = harness();
  h.mk("0.3.124").beginInstall({ to: "0.3.125", entry: entry("new") });
  const b = h.mk("0.3.125");
  assert.equal(await b.afterBoot({ ok: false, reason: "crashed" }), "reported");
  assert.equal(h.calls.spawn.length, 0);
});

test("mac never spawns a rollback", async () => {
  const h = harness({ platform: "darwin" });
  const b = await installedWithPrev(h);
  assert.equal(await b.afterBoot({ ok: false, reason: "crashed" }), "reported");
  assert.equal(h.calls.spawn.length, 0);
});

test("a slow first boot is a strike, not a withdrawal; the second consecutive one rolls back (§9.1)", async () => {
  const h = harness();
  const b = await installedWithPrev(h);
  assert.equal(await b.afterBoot({ ok: false, reason: "timeout" }), "retry");
  assert.equal(h.calls.spawn.length, 0);
  assert.equal(b.offerable("0.3.125"), true);
  assert.equal(b.state().pending.strikes, 1);
  assert.equal(await h.mk("0.3.125").afterBoot({ ok: false, reason: "timeout" }), "rolling-back");
  assert.equal(h.calls.spawn.length, 1);
});

test("a slow boot followed by a healthy one confirms", async () => {
  const h = harness();
  const b = await installedWithPrev(h);
  await b.afterBoot({ ok: false, reason: "timeout" });
  assert.equal(await h.mk("0.3.125").afterBoot({ ok: true }), "confirm");
  assert.equal(b.offerable("0.3.125"), true);
});

test("never run the previous installer over a schema the new build advanced", async () => {
  const h = harness();
  const a = h.mk("0.3.123");
  a.beginInstall({ to: "0.3.124", entry: { file: "old.exe", bytes: 3, sha256: "a" } });
  await h.mk("0.3.124").afterBoot({ ok: true });
  h.mk("0.3.124").beginInstall({ to: "0.3.125", entry: entry("new") });   // head recorded: 5
  h.head.v = 6;                                                          // the new build migrated, then failed health
  const b = h.mk("0.3.125");
  assert.equal(await b.afterBoot({ ok: false, reason: "crashed" }), "reported");
  assert.equal(h.calls.spawn.length, 0);
  assert.equal(h.calls.stop, 0);
  assert.equal(h.calls.report.length, 1);
});

test("a rollback installer that fails to start cancels the quit instead of closing the app for nothing", async () => {
  const h = harness();
  const cleared = [];
  let fail;
  const mk = (running) => createRollback({
    dir: h.dir, running, platform: "win32",
    spawn: () => ({ unref() {}, on(ev, fn) { if (ev === "error") fail = fn; } }),
    verifyPublisher: async () => true, verifiedOnDisk: async () => true, stopRuntime: async () => {}, quit: () => { h.calls.quit++; },
    setTimeoutImpl: () => 42, clearTimeoutImpl: (t) => cleared.push(t),
  });
  h.mk("0.3.123").beginInstall({ to: "0.3.124", entry: { file: "old.exe", bytes: 3, sha256: "a" } });
  await h.mk("0.3.124").afterBoot({ ok: true });
  h.mk("0.3.124").beginInstall({ to: "0.3.125", entry: entry("new") });
  assert.equal(await mk("0.3.125").afterBoot({ ok: false, reason: "crashed" }), "rolling-back");
  fail(new Error("EPERM"));
  assert.deepEqual(cleared, [42]);
  assert.equal(h.calls.quit, 0);
});
