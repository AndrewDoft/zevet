// board/src/lib/notify.mjs and keybindings.mjs: which agent events become an OS
// notification, how a burst is folded, and the editable shortcut table.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const lib = (f) => import(pathToFileURL(path.join(ROOT, "board", "src", "lib", f)).href);
const N = await lib("notify.mjs");
const K = await lib("keybindings.mjs");

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)) };
}

function rig(prefs = { finished: true, attention: true }, extra = {}) {
  const shown = [];
  const timers = [];
  let t = 1000;
  const n = N.createNotifier({
    prefs: () => prefs,
    now: () => t,
    schedule: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    show: (x) => shown.push(x),
    ...extra,
  });
  return { n, shown, timers, tick: (ms) => (t += ms), prefs };
}
const item = (kind, key = "1", label = "claude") => ({ kind, label, reason: kind, key });

describe("event to notification", () => {
  test("clean result and exit 0 are finished", () => {
    assert.equal(N.classifyAgentEvent({ type: "agent", payload: { type: "result" } }).kind, "finished");
    assert.equal(N.classifyAgentEvent({ type: "exit", code: 0 }).kind, "finished");
  });
  test("errors and non-zero exits need attention", () => {
    assert.equal(N.classifyAgentEvent({ type: "agent", payload: { type: "result", is_error: true } }).kind, "attention");
    assert.deepEqual(N.classifyAgentEvent({ type: "exit", code: 2 }), { kind: "attention", reason: "Exited 2" });
  });
  test("a signal exit, text and tool output are nothing", () => {
    assert.equal(N.classifyAgentEvent({ type: "exit", code: null, signal: "SIGTERM" }), null);
    assert.equal(N.classifyAgentEvent({ type: "agent", payload: { type: "assistant" } }), null);
    assert.equal(N.classifyAgentEvent({ type: "stderr", text: "x" }), null);
    assert.equal(N.classifyAgentEvent(null), null);
  });
  test("permits and asks are attention", () => {
    assert.deepEqual(N.classifyRequest("ask"), { kind: "attention", reason: "Question" });
    assert.deepEqual(N.classifyRequest("permit"), { kind: "attention", reason: "Permission" });
  });
});

describe("toggles", () => {
  test("defaults: attention on, finished off", () => {
    assert.deepEqual(N.readNotifyPrefs(store()), { finished: false, attention: true });
  });
  test("saved prefs round-trip and junk falls back", () => {
    const s = store();
    N.writeNotifyPrefs(s, { finished: true, attention: false });
    assert.deepEqual(N.readNotifyPrefs(s), { finished: true, attention: false });
    assert.deepEqual(N.readNotifyPrefs(store({ [N.NOTIFY_KEY]: "{nope" })), N.NOTIFY_DEFAULTS);
  });
  test("an off kind is not shown, an on kind is", () => {
    const r = rig({ finished: false, attention: true });
    assert.equal(r.n.notify(item("finished")), false);
    assert.equal(r.n.notify(item("attention")), true);
    assert.equal(r.shown.length, 1);
  });
  test("the toggle is read per event", () => {
    const r = rig({ finished: false, attention: true });
    r.n.notify(item("finished"));
    r.prefs.finished = true;
    r.tick(5000);
    r.n.notify(item("finished"));
    assert.equal(r.shown.length, 1);
  });
  test("the agent you are looking at stays quiet", () => {
    const r = rig(undefined, { viewing: (k) => k === "7" });
    assert.equal(r.n.notify(item("attention", "7")), false);
    assert.equal(r.n.notify(item("attention", "8")), true);
  });
});

describe("coalescing", () => {
  test("20 in one burst show 2, then one summary", () => {
    const r = rig();
    for (let i = 0; i < 20; i++) r.n.notify(item("attention", String(i), "a" + i));
    assert.equal(r.shown.length, N.BURST_SHOWN);
    assert.equal(r.timers.length, 1);
    r.timers[0].fn();
    assert.equal(r.shown.length, N.BURST_SHOWN + 1);
    assert.equal(r.shown.at(-1).title, "18 more agents");
  });
  test("a lone event after the window shows again", () => {
    const r = rig();
    r.n.notify(item("attention"));
    r.timers[0].fn();
    r.tick(N.BURST_MS + 1);
    r.n.notify(item("attention"));
    assert.equal(r.shown.length, 2);
  });
  test("no summary when nothing was held", () => {
    const r = rig();
    r.n.notify(item("attention"));
    r.timers[0].fn();
    assert.equal(r.shown.length, 1);
  });
});

describe("keybindings", () => {
  const ev = (key, o = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

  test("defaults match Ctrl and Cmd alike", () => {
    const s = store();
    assert.ok(K.matches(ev("k", { ctrlKey: true }), "palette", s));
    assert.ok(K.matches(ev("K", { metaKey: true }), "palette", s));
    assert.ok(K.matches(ev("b", { ctrlKey: true }), "tree", s));
    assert.ok(!K.matches(ev("k"), "palette", s));
    assert.ok(!K.matches(ev("k", { ctrlKey: true, shiftKey: true }), "palette", s));
  });
  test("a rebind persists and replaces the old key", () => {
    const s = store();
    assert.deepEqual(K.setBinding(s, "palette", "CommandOrControl+Shift+P"), { ok: true });
    const again = store({ [K.KEYS_KEY]: s.getItem(K.KEYS_KEY) });
    assert.ok(K.matches(ev("p", { ctrlKey: true, shiftKey: true }), "palette", again));
    assert.ok(!K.matches(ev("k", { ctrlKey: true }), "palette", again));
  });
  test("a key another binding owns is refused and nothing is saved", () => {
    const s = store();
    const r = K.setBinding(s, "palette", "CommandOrControl+B");
    assert.equal(r.ok, false);
    assert.equal(r.conflict, "File tree");
    assert.equal(s.getItem(K.KEYS_KEY), null);
  });
  test("a moved binding frees its old key", () => {
    const s = store();
    K.setBinding(s, "tree", "CommandOrControl+J");
    assert.equal(K.setBinding(s, "palette", "CommandOrControl+B").ok, true);
  });
  test("menu zoom keys and bare keys are refused", () => {
    const s = store();
    assert.equal(K.setBinding(s, "tree", "CommandOrControl+=").conflict, "App menu");
    assert.equal(K.setBinding(s, "tree", "K").ok, false);
    assert.equal(K.setBinding(s, "nope", "CommandOrControl+J").ok, false);
  });
  test("reset restores the default, singly and all", () => {
    const s = store();
    K.setBinding(s, "palette", "CommandOrControl+J");
    K.setBinding(s, "tree", "CommandOrControl+L");
    K.resetBinding(s, "palette");
    assert.equal(K.resolveBindings(s).palette, "CommandOrControl+K");
    assert.equal(K.resolveBindings(s).tree, "CommandOrControl+L");
    K.resetAll(s);
    assert.equal(K.resolveBindings(s).tree, "CommandOrControl+B");
  });
  test("eventToAccel ignores bare modifiers and spells Space", () => {
    assert.equal(K.eventToAccel(ev("Control", { ctrlKey: true })), null);
    assert.equal(K.eventToAccel(ev(" ", { metaKey: true })), "CommandOrControl+Space");
  });
  test("every handler goes through matches()", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["App.tsx", "components/palette.tsx"]) {
      assert.match(readFileSync(path.join(ROOT, "board", "src", f), "utf8"), /matches\(/, f);
    }
  });
  test("garbage in storage falls back to defaults", () => {
    assert.equal(K.resolveBindings(store({ [K.KEYS_KEY]: "}{" })).palette, "CommandOrControl+K");
  });
  test("display follows the platform", () => {
    assert.equal(K.showAccel("CommandOrControl+K", true), "Cmd+K");
    assert.equal(K.showAccel("CommandOrControl+K", false), "Ctrl+K");
  });
});
