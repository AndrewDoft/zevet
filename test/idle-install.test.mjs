// The idle silent install. decideIdleInstall is ported from masora2; createIdleInstaller is Zevet's: its `busy` is
// payload-swap.js's busyReason, and the consoles are saved before the installer runs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { decideIdleInstall, createIdleInstaller, IDLE_SECONDS, RETRY_GAP_MS, MAX_ATTEMPTS } = require(path.join(ROOT, "desktop", "idle-install.js"));
const { AGENT_QUIET_MS, INPUT_QUIET_MS } = require(path.join(ROOT, "desktop", "payload-swap.js"));

const base = { phase: "ready", systemIdleSeconds: 0, windowsAway: false, rendererIdle: true, busy: false, attempted: false };
const d = (o) => decideIdleInstall({ ...base, ...o });

describe("decideIdleInstall", () => {
  test("machine idle 3 minutes installs", () => {
    assert.deepEqual(d({ systemIdleSeconds: IDLE_SECONDS }), { install: true, hidden: false });
    assert.equal(IDLE_SECONDS, 180);
    assert.equal(d({ systemIdleSeconds: IDLE_SECONDS - 1 }).install, false);
  });
  test("all windows hidden or minimised installs", () => {
    assert.deepEqual(d({ windowsAway: true }), { install: true, hidden: true });
  });
  test("waking from sleep installs", () => {
    assert.deepEqual(d({ resumed: true }), { install: true, hidden: true });
    assert.equal(d({ resumed: true, busy: true }).install, false, "but never over a busy gate");
  });
  test("never interrupts, whatever else says away", () => {
    assert.equal(d({ windowsAway: true, rendererIdle: false }).install, false);
    assert.equal(d({ windowsAway: true, rendererIdle: undefined }).install, false);
  });
  test("only a ready update, once, when nothing else is running", () => {
    for (const o of [{ phase: "downloading" }, { phase: "checking" }, { busy: true }, { attempted: true }]) {
      assert.equal(d({ windowsAway: true, ...o }).install, false, JSON.stringify(o));
    }
  });
});

describe("createIdleInstaller", () => {
  const NOW = 50_000_000;
  /** Every gate open, so each test closes exactly one. */
  function rig(over = {}) {
    const events = [];
    const updater = {
      state: { phase: "ready", canInstall: true, version: "0.2.100" },
      install: async () => { events.push("install"); return { ok: true, restarting: true }; },
    };
    const tick = createIdleInstaller({
      updater,
      gate: {
        activity: () => ({ running: 0, lastAt: NOW - AGENT_QUIET_MS - 1, resumable: false, nonResumable: 0 }),
        chatBusy: () => false,
        lastInputAt: () => NOW - INPUT_QUIET_MS - 1,
        windows: () => 1,
        working: () => 0,
        ...over.gate,
      },
      systemIdleSeconds: () => 900,
      windowsAway: () => over.away ?? false,
      persist: () => events.push("persist"),
      log: () => {},
      now: () => NOW,
      ...over.deps,
    });
    return { tick, events, updater };
  }

  test("an idle machine saves the consoles, THEN runs the installer", async () => {
    const r = rig();
    assert.equal(await r.tick(), true);
    assert.deepEqual(r.events, ["persist", "install"]);
  });

  test("a non-resumable console running means no install and nothing persisted", async () => {
    const r = rig({ gate: { activity: () => ({ running: 1, resumable: true, nonResumable: 1, lastAt: NOW }) } });
    assert.equal(await r.tick(), false);
    assert.deepEqual(r.events, []);
  });

  test("an agent that spoke a minute ago, a chat turn and recent input each block it (busyReason, not a copy)", async () => {
    for (const gate of [
      { activity: () => ({ running: 0, lastAt: NOW - 60_000 }) },
      { chatBusy: () => true },
      { lastInputAt: () => NOW - 30_000 },
      { windows: () => 0 },
    ]) {
      const r = rig({ gate });
      assert.equal(await r.tick(), false, JSON.stringify(Object.keys(gate)));
      assert.deepEqual(r.events, []);
    }
  });

  test("resumable claude consoles do not block it: the relaunch restores them", async () => {
    const r = rig({ gate: { activity: () => ({ running: 2, resumable: true, nonResumable: 0, lastAt: NOW }) } });
    assert.equal(await r.tick(), true);
    assert.deepEqual(r.events, ["persist", "install"]);
  });

  test("a console mid-turn blocks it, resumable or not", async () => {
    const r = rig({ gate: { working: () => 1, activity: () => ({ running: 1, resumable: true, nonResumable: 0, lastAt: NOW }) } });
    assert.equal(await r.tick(), false);
    assert.deepEqual(r.events, []);
  });

  test("a deferred install says why, and clears it once the install is allowed (retried by the next tick)", async () => {
    let working = 1;
    const seen = [];
    const r = rig({ gate: { working: () => working, activity: () => ({ running: 1, resumable: true, nonResumable: 0, lastAt: NOW }) }, deps: { onWaiting: (w) => seen.push(w) } });
    assert.equal(await r.tick(), false);
    assert.match(seen.at(-1), /mid-turn/);
    working = 0;
    assert.equal(await r.tick(), true);
    assert.equal(seen.at(-1), null);
  });

  test("idle (not working) resumable consoles of any agent are saved and do not block", async () => {
    const r = rig({ gate: { working: () => 0, activity: () => ({ running: 3, resumable: true, nonResumable: 0, lastAt: NOW }) } });
    assert.equal(await r.tick(), true);
    assert.deepEqual(r.events, ["persist", "install"]);
  });

  test("an unfocused window installs only after IDLE_SECONDS of it, and focus resets the clock", async () => {
    let t = NOW, away = true;
    const r = rig({ away, deps: { now: () => t, windowsAway: () => away, systemIdleSeconds: () => 5 }, gate: { lastInputAt: () => 0 } });
    assert.equal(await r.tick(), false, "just lost focus");
    t += IDLE_SECONDS * 1000 - 1000;
    assert.equal(await r.tick(), false, "not yet");
    away = false; t += 1000;
    assert.equal(await r.tick(), false, "focus came back");
    away = true; t += 1000;
    assert.equal(await r.tick(), false, "the clock restarted");
    t += IDLE_SECONDS * 1000;
    assert.equal(await r.tick(), true);
  });

  test("resume from sleep installs at once, though the person was 'here' a moment ago", async () => {
    const r = rig({ deps: { systemIdleSeconds: () => 1 } });
    assert.equal(await r.tick(), false);
    assert.equal(await r.tick({ resumed: true }), true);
    assert.deepEqual(r.events, ["persist", "install"]);
  });

  test("a failed install is retried after the gap, at most MAX_ATTEMPTS times, so a version is neither spammed nor stranded", async () => {
    let t = NOW;
    const r = rig({ deps: { now: () => t } });
    r.updater.install = async () => { r.events.push("install"); return { ok: false, error: "spawn failed" }; };
    const installs = () => r.events.filter((e) => e === "install").length;
    await r.tick();
    assert.equal(installs(), 1);
    await r.tick();
    assert.equal(installs(), 1, "not again inside the gap");
    for (let i = 0; i < 5; i++) { t += RETRY_GAP_MS + 1; await r.tick(); }
    assert.equal(installs(), MAX_ATTEMPTS, "bounded");
    r.updater.state.version = "0.2.101";
    assert.equal(await r.tick(), false);
    assert.equal(installs(), MAX_ATTEMPTS + 1, "a newer version starts fresh");
  });

  test("a failed save of the consoles cancels the install", async () => {
    const r = rig({ deps: { persist: () => { throw new Error("disk full"); } } });
    assert.equal(await r.tick(), false);
    assert.deepEqual(r.events, []);
  });

  test("not where the install would only open a disk image", async () => {
    const r = rig({ deps: { canSilent: () => false } });
    assert.equal(await r.tick(), false);
    assert.deepEqual(r.events, []);
  });

  test("the person is here (not idle, windows up): nothing", async () => {
    const r = rig({ deps: { systemIdleSeconds: () => 5 } });
    assert.equal(await r.tick(), false);
  });

  test("nothing ready, nothing to do", async () => {
    const r = rig();
    r.updater.state.phase = "downloading";
    assert.equal(await r.tick(), false);
  });
});

// main.js cannot be loaded outside Electron, so its wiring is asserted from source.
describe("main.js wires the idle install and the rollback", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  test("the consoles are persisted before the idle install, from the one persist function", () => {
    assert.match(main, /createIdleInstaller\(\{[\s\S]{0,800}persist: persistResumableConsoles/);
  });
  test("sleep-resume triggers an attempt; mid-turn consoles gate it; restore resumes the saved agent, not just claude", () => {
    assert.match(main, /powerMonitor\.on\("resume", \(\) => run\(\{ resumed: true \}\)\)/);
    assert.match(main, /working: \(\) => consoleLog\.snapshot\(\)\.consoles\.filter\(\(e\) => e\.running && e\.state === "working"\)/);
    assert.match(main, /agent: s\.agent, cwd: s\.cwd, trusted: true, resumeFrom: s\.sessionId/);
    assert.match(main, /every\(\(w\) => w\.isMinimized\(\) \|\| !w\.isVisible\(\) \|\| !w\.isFocused\(\)\)/);
  });
  test("the rollback gets the updater, is started on boot, and relaunches through releaseForRelaunch on a first strike", () => {
    assert.match(main, /const appUpdater = new AppUpdater\(\{\s*rollback,/);
    assert.match(main, /watchShellInstall\(\);/);
    assert.match(main, /did === "retry"[\s\S]{0,200}releaseForRelaunch\(\);[\s\S]{0,60}app\.relaunch\(\)/);
  });
  test("the rollback installer runs with INSTALL_ARGS and the running install's own scope", () => {
    assert.match(main, /installArgs: \(\) => winInstallArgs\(INSTALL_ARGS, process\.execPath\)/);
  });
  test("the rollback quits through the updater's own quit, which saves the consoles", () => {
    assert.match(main, /quit: \(\) => appUpdater\.quitImpl\(\)/);
  });
});
