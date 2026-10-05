// reconnect.js: the way back from a failed board load. Fake clock, fake window; no Electron.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
const { delayFor, createReconnect, CAP_MS } = createRequire(import.meta.url)("../desktop/reconnect.js");

function rig({ online = () => true } = {}) {
  const log = [];
  let now = 0, id = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; };
  const clearTimer = (i) => timers.delete(i);
  const ticks = new Map();
  const setTick = (fn, ms) => { ticks.set(++id, { ms, fn }); return id; };
  const clearTick = (i) => ticks.delete(i);
  const r = createReconnect({ load: () => log.push(`load@${now}`), showPage: () => log.push(`page@${now}`), isOnline: () => online(), setTimer, clearTimer, setTick, clearTick });
  const advance = (ms) => { const end = now + ms; for (;;) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].fn(); } now = end; };
  return { r, log, advance, ticks, timers, runTicks: () => ticks.forEach((t) => t.fn()) };
}

describe("reconnect", () => {
  test("the backoff is short and capped, never longer than 5 s", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(delayFor), [400, 800, 1500, 3000, 5000, 5000, 5000]);
    assert.equal(CAP_MS, 5000);
  });
  test("our page shows on the first failure, then it retries on the schedule, with no end", () => {
    const { r, log, advance } = rig();
    r.failed();
    assert.deepEqual(log, ["page@0"]);
    advance(400); assert.deepEqual(log, ["page@0", "load@400"]);
    r.failed(); // the retry failed too: no second page flash, next wait is 800
    advance(799); assert.equal(log.length, 2);
    advance(1); assert.equal(log.at(-1), "load@1200");
    for (let i = 0; i < 20; i++) { r.failed(); advance(CAP_MS); }
    assert.equal(log.filter((l) => l.startsWith("page")).length, 1);
    assert.ok(log.length > 20, "retries never stop");
  });
  test("a wake or the network coming back retries now, not at the end of the wait", () => {
    const state = { on: false };
    const { r, log, advance, runTicks } = rig({ online: () => state.on });
    r.failed(); r.failed(); r.failed(); // deep into the backoff
    advance(100);
    const before = log.length;
    r.nudge();
    assert.equal(log.length, before + 1, "nudge loads immediately");
    state.on = true; runTicks(); // offline -> online while failing
    assert.equal(log.length, before + 2, "the online poll nudges too");
  });
  test("a nudge with nothing failing does nothing; a good load ends it all", () => {
    const { r, log, advance, ticks, timers } = rig();
    r.nudge(); assert.deepEqual(log, []);
    r.failed(); r.loaded();
    assert.equal(timers.size + ticks.size, 0);
    advance(60000); assert.deepEqual(log, ["page@0"]);
    assert.equal(r.failing, false);
  });
});

describe("wiring in main.js", () => {
  const main = fs.readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
  test("a failed main-frame load goes through the reconnect controller; there is no single-retry or host page left", () => {
    assert.match(main, /createReconnect\(\{/);
    assert.match(main, /did-fail-load[\s\S]{0,300}reconnect\.failed\(\)/);
    assert.match(main, /powerMonitor\.on\("resume", nudge\)/);
    assert.doesNotMatch(main, /unreachablePage|boardLoadAttempts/);
  });
  test("the waiting page never names the hub", () => {
    const page = main.slice(main.indexOf("function reconnectingPage"), main.indexOf("function credentialPage") > 0 ? main.indexOf("/**\n * The page shown when this machine cannot prove") : undefined);
    assert.doesNotMatch(page, /hub|cfg\.|host/i);
  });
  test("the board keeps its state and says Reconnecting before it says Offline, and retries when the network returns", () => {
    const board = fs.readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
    const conn = board.slice(board.indexOf("export function connect"), board.indexOf("BOOT"));
    assert.match(conn, /setConn\("init"\)/);
    assert.match(conn, /addEventListener\("online"/);
    assert.match(conn, /OFFLINE_AFTER_MS/);
  });
  test("the hub asks the browser to retry within a second", () => {
    assert.ok(fs.readFileSync(path.join(ROOT, "hub", "server.mjs"), "utf8").includes("retry: 1000\\nevent: hello"));
  });
});
