// The idle gate for a payload swap, and the trial confirmation after it. payload-swap.js takes everything
// it touches as arguments, so these run outside Electron with a fake client and a fake app.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createSwapper, confirmWhenHealthy, awaitHealthy, busyReason, AGENT_QUIET_MS, INPUT_QUIET_MS } = createRequire(import.meta.url)(path.join(ROOT, "desktop", "payload-swap.js"));

const NOW = 10_000_000;
const MIN = 60_000;
/** Every gate open, so each test closes exactly one. */
const idle = (over = {}) => ({
  now: NOW,
  activity: () => ({ running: 0, lastAt: NOW - AGENT_QUIET_MS - 1 }),
  chatBusy: () => false,
  lastInputAt: () => NOW - INPUT_QUIET_MS - 1,
  windows: () => 1,
  ...over,
});

describe("busyReason: a swap never happens under work", () => {
  test("all quiet: it may go", () => assert.equal(busyReason(idle()), null));
  test("a running agent blocks it, however long ago it last spoke", () => {
    assert.match(busyReason(idle({ activity: () => ({ running: 1, lastAt: 0 }) })), /agent is running/);
  });
  test("resumable running consoles do not block a quiet swap", () => {
    assert.equal(busyReason(idle({ activity: () => ({ running: 1, resumable: true, nonResumable: 0, lastAt: NOW }) })), null);
  });
  test("one non-resumable running console still blocks", () => {
    assert.match(busyReason(idle({ activity: () => ({ running: 2, resumable: true, nonResumable: 1, lastAt: NOW }) })), /non-resumable/);
  });
  test("an agent that spoke 4m59s ago blocks it; at 5m it is over", () => {
    assert.match(busyReason(idle({ activity: () => ({ running: 0, lastAt: NOW - 5 * MIN + 1000 }) })), /last 5 minutes/);
    assert.equal(busyReason(idle({ activity: () => ({ running: 0, lastAt: NOW - 5 * MIN }) })), null);
  });
  test("a chat turn in flight blocks it", () => {
    assert.match(busyReason(idle({ chatBusy: () => true })), /chat turn/);
  });
  test("input 1m59s ago blocks it; at 2m it is over", () => {
    assert.match(busyReason(idle({ lastInputAt: () => NOW - 2 * MIN + 1000 })), /last 2 minutes/);
    assert.equal(busyReason(idle({ lastInputAt: () => NOW - 2 * MIN })), null);
  });
  test("the input window is configurable for the packaged proof, and 0 means input never blocks", () => {
    assert.equal(busyReason(idle({ lastInputAt: () => NOW, inputQuietMs: 0 })), null);
    assert.match(busyReason(idle({ lastInputAt: () => NOW - 1000, inputQuietMs: 5000 })), /last 2 minutes/);
  });
  test("no window (a macOS app in the dock) blocks it: a relaunch would open one", () => {
    assert.match(busyReason(idle({ windows: () => 0 })), /no window/);
  });
});

function fakes({ staged = { build: "0.2.90", seq: 2090 }, ...over } = {}) {
  const calls = [];
  const handlers = {};
  const payload = {
    staged: () => staged,
    activate: async () => { calls.push("activate"); return { build: staged.build, dir: "d", previous: "0.2.89" }; },
    on: (ev, fn) => { handlers[ev] = fn; },
  };
  const app = { relaunch: () => calls.push("relaunch"), exit: (c) => calls.push(`exit ${c}`) };
  const swapper = createSwapper({
    payload, app, release: () => calls.push("release"), log: () => {},
    ...idle(), now: () => NOW, setIntervalImpl: () => ({}), clearIntervalImpl: () => {},
    ...over,
  });
  return { swapper, calls, handlers };
}

describe("createSwapper", () => {
  test("idle and staged: activate, release the app's children, relaunch, exit 0 — in that order", async () => {
    const { swapper, calls } = fakes();
    assert.equal(await swapper.tick(), "swapped");
    assert.deepEqual(calls, ["activate", "release", "relaunch", "exit 0"]);
  });
  test("busy: nothing is activated, and the reason is reported", async () => {
    const { swapper, calls } = fakes({ activity: () => ({ running: 2, lastAt: NOW }) });
    assert.match(await swapper.tick(), /agent is running/);
    assert.deepEqual(calls, []);
  });
  test("nothing staged: nothing happens", async () => {
    const { swapper, calls } = fakes({ staged: null });
    assert.equal(await swapper.tick(), "idle");
    assert.deepEqual(calls, []);
  });
  test("a second tick after the swap started does not activate twice", async () => {
    const { swapper, calls } = fakes();
    await swapper.tick();
    await swapper.tick();
    assert.equal(calls.filter((c) => c === "activate").length, 1);
  });
  test("an activate that throws leaves the app running and the gate retryable", async () => {
    const { swapper, calls } = fakes();
    let n = 0;
    const payload = { staged: () => ({ build: "x" }), activate: async () => { if (n++ === 0) throw new Error("disk full"); return { build: "x" }; }, on() {} };
    const s = createSwapper({ payload, app: { relaunch: () => calls.push("relaunch"), exit: () => calls.push("exit") }, release() {}, log: () => {}, ...idle(), now: () => NOW });
    assert.equal(await s.tick(), "failed");
    assert.deepEqual(calls, []);
    assert.equal(await s.tick(), "swapped");
  });
  test("the staged event ticks immediately: an idle app swaps at once, a busy one waits", async () => {
    const a = fakes();
    a.swapper.start();
    await a.handlers.staged(); await new Promise((r) => setImmediate(r));
    assert.deepEqual(a.calls, ["activate", "release", "relaunch", "exit 0"]);
    const b = fakes({ chatBusy: () => true });
    b.swapper.start();
    await b.handlers.staged(); await new Promise((r) => setImmediate(r));
    assert.deepEqual(b.calls, []);
  });
  test("the interval retries promptly after agents stop and input goes quiet", async () => {
    let now = NOW;
    let running = 1;
    let lastInput = NOW;
    let check;
    const a = fakes({
      activity: () => ({ running, lastAt: running ? now : now - AGENT_QUIET_MS }),
      lastInputAt: () => lastInput,
      now: () => now,
      setIntervalImpl: (fn) => { check = fn; return {}; },
    });
    a.swapper.start();
    await check();
    assert.deepEqual(a.calls, []);
    now += AGENT_QUIET_MS;
    running = 0;
    lastInput = now - INPUT_QUIET_MS;
    await check();
    assert.deepEqual(a.calls, ["activate", "release", "relaunch", "exit 0"]);
  });
  test("input arriving after the agent stops resets the gate", async () => {
    let now = NOW;
    let lastInput = NOW - INPUT_QUIET_MS;
    let check;
    const a = fakes({ now: () => now, lastInputAt: () => lastInput, setIntervalImpl: (fn) => { check = fn; return {}; } });
    a.swapper.start();
    lastInput = now;
    await check();
    assert.deepEqual(a.calls, []);
    now += INPUT_QUIET_MS;
    await check();
    assert.deepEqual(a.calls, ["activate", "release", "relaunch", "exit 0"]);
  });
  test("quit applies the staged build without relaunching, and does nothing when none is staged", async () => {
    const a = fakes();
    assert.equal(await a.swapper.applyOnQuit(), true);
    assert.deepEqual(a.calls, ["activate"]);
    const b = fakes({ staged: null });
    assert.equal(await b.swapper.applyOnQuit(), false);
    assert.deepEqual(b.calls, []);
  });
});

describe("confirmWhenHealthy", () => {
  const trial = () => {
    const calls = [];
    return {
      calls,
      payload: { confirm: () => calls.push("confirm"), bootFailed: (why) => { calls.push(`bootFailed ${why}`); return { reverted: false }; } },
      app: { relaunch: () => calls.push("relaunch"), exit: (c) => calls.push(`exit ${c}`) },
    };
  };
  // A clock the fake sleep advances, so a 120 s timeout takes no time.
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

  test("window loaded and the agent API answers: the trial is confirmed, nothing relaunches", async () => {
    const t = trial();
    const ok = await confirmWhenHealthy({ ...t, loaded: Promise.resolve(), apiAnswers: async () => true, log() {}, ...clock() });
    assert.equal(ok, true);
    assert.deepEqual(t.calls, ["confirm"]);
  });
  test("the API answers only on the third try: still confirmed", async () => {
    const t = trial();
    let n = 0;
    await confirmWhenHealthy({ ...t, loaded: Promise.resolve(), apiAnswers: async () => ++n >= 3, log() {}, ...clock() });
    assert.deepEqual(t.calls, ["confirm"]);
  });
  test("a gc failure (EPERM on an old versions/ dir) after the verdict is written does not crash the confirm", async () => {
    const t = trial();
    const logs = [];
    t.payload.confirm = () => { t.calls.push("confirm"); throw Object.assign(new Error("EPERM: operation not permitted, rmdir versions/0.2.100"), { code: "EPERM" }); };
    const ok = await confirmWhenHealthy({ ...t, loaded: Promise.resolve(), apiAnswers: async () => true, log: (m) => logs.push(m), ...clock() });
    assert.equal(ok, true, "still confirmed");
    assert.deepEqual(t.calls, ["confirm"], "no strike, no relaunch");
    assert.match(logs.join(" "), /cleanup of old versions failed.*EPERM/);
  });
  test("the API never answers: a strike is counted and the app relaunches with exit 1", async () => {
    const t = trial();
    const ok = await confirmWhenHealthy({ ...t, loaded: Promise.resolve(), apiAnswers: async () => false, log() {}, ...clock() });
    assert.equal(ok, false);
    assert.deepEqual(t.calls, ["bootFailed no healthy signal within 120s", "relaunch", "exit 1"]);
  });
  test("an API check that throws counts as not answering", async () => {
    const t = trial();
    await confirmWhenHealthy({ ...t, loaded: Promise.resolve(), apiAnswers: async () => { throw new Error("ECONNREFUSED"); }, log() {}, ...clock() });
    assert.equal(t.calls[0].startsWith("bootFailed"), true);
  });
  test("no window ever finishes loading: the same strike", async () => {
    const t = trial();
    await confirmWhenHealthy({ ...t, loaded: new Promise(() => {}), apiAnswers: async () => true, log() {}, ...clock() });
    assert.equal(t.calls[0].startsWith("bootFailed"), true);
    assert.equal(t.calls.includes("confirm"), false);
  });
});

// The same signal without the payload's consequences: what the installer rollback waits on (main.js watchShellInstall).
describe("awaitHealthy", () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
  test("true once a window has loaded and the API answers", async () => {
    assert.equal(await awaitHealthy({ loaded: Promise.resolve(), apiAnswers: async () => true, ...clock() }), true);
  });
  test("false, with no side effect, when the API never answers within the budget", async () => {
    assert.equal(await awaitHealthy({ loaded: Promise.resolve(), apiAnswers: async () => false, ...clock() }), false);
  });
  test("false when no window ever finishes loading, and an API that throws is not answering", async () => {
    assert.equal(await awaitHealthy({ loaded: new Promise(() => {}), apiAnswers: async () => true, ...clock() }), false);
    assert.equal(await awaitHealthy({ loaded: Promise.resolve(), apiAnswers: async () => { throw new Error("x"); }, ...clock() }), false);
  });
});

// main.js cannot be loaded outside Electron (see desktop-bridges.test.mjs), so its wiring is asserted from source.
describe("main.js hands the gate real state and the swap real teardown", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  // The gate's inputs are one object, useGate, shared by the swapper and the idle installer.
  const wiring = main.slice(main.indexOf("const useGate = {"), main.indexOf("const useGate = {") + 900);
  const release = main.slice(main.indexOf("function releaseForRelaunch"), main.indexOf("function releaseForRelaunch") + 300);

  test("agents come from the console log, chat from the chat run, windows from Electron", () => {
    assert.match(wiring, /activity: \(\) => \{[\s\S]{0,240}consoleLog\.activity\(\)/);
    assert.match(wiring, /chatBusy: \(\) => Boolean\(chatRun && chatRun\.turn\)/);
    assert.match(wiring, /windows: \(\) => BrowserWindow\.getAllWindows\(\)\.length/);
    assert.match(wiring, /lastInputAt: \(\) => lastInputAt/);
  });
  test("the swapper and the idle installer read the one gate", () => {
    assert.match(main, /createSwapper\(\{[\s\S]{0,200}\.\.\.useGate/);
    assert.match(main, /createIdleInstaller\(\{[\s\S]{0,200}gate: useGate/);
  });
  test("keyboard input on any web contents is what the input gate sees", () => {
    assert.match(main, /web-contents-created[\s\S]{0,300}before-input-event[\s\S]{0,400}lastInputAt = now;/);
  });
  test("pointer movement alone is not input: a window opening under a still cursor must not read as a person", () => {
    assert.match(main, /NOT_INPUT = new Set\(\["mouseMove", "mouseEnter", "mouseLeave"\]\)/);
    assert.match(main, /if \(input && NOT_INPUT\.has\(input\.type\)\) return;/);
  });
  test("quit applies a staged build", async () => {
    assert.match(main, /swapper\.applyOnQuit\(\)\.catch/);
  });
  test("a trial build is confirmed through the trial handle, once a window has stopped loading and the agent API answers", () => {
    assert.match(main, /const firstWindowLoaded = new Promise[\s\S]{0,200}did-stop-loading/);
    assert.match(main, /if \(bootShell\.trial\) \{[\s\S]{0,200}confirmWhenHealthy\(\{ payload: bootShell\.trial, loaded: firstWindowLoaded, apiAnswers: agentApiAnswers/);
  });
  test("the relaunch tidies what before-quit would, and never starts an installer", () => {
    assert.match(release, /stopChatRun\(\)/);
    assert.match(release, /rmSync\(AGENT_API_FILE/);
    assert.match(release, /family\.stop\(\)/);
    assert.doesNotMatch(release, /installOnQuit/);
  });
  test("the agent API probe presents the token the discovery file carries", () => {
    assert.match(main, /agentApiHandle\.url\}\/list[\s\S]{0,120}Bearer \$\{agentApiHandle\.token\}/);
  });
});
