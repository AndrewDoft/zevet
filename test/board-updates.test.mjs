// Execute the board's real update handlers against a small DOM and the same
// bridge calls exposed by preload.js. No separate renderer implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { ROOT, tempDir } from "./helpers.mjs";

const html = readFileSync(path.join(ROOT, "hub", "public", "index.html"), "utf8");
const { AppUpdater } = createRequire(import.meta.url)(path.join(ROOT, "desktop", "app-update.js"));
function between(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `board function boundary moved: ${start}`);
  return html.slice(a, b);
}
const source = [
  between("  function srow(", "  function renderSheet("),
  between("  function versionSection()", "  function credentialLabel()"),
  between("  var updateState = null;", "  function renderStreams("),
].join("\n");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.parentNode = null;
    this.disabled = false;
    this._text = "";
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChild(next, prev) {
    const i = this.children.indexOf(prev);
    assert.ok(i >= 0);
    this.children[i] = next;
    next.parentNode = this;
    prev.parentNode = null;
    return prev;
  }
  set textContent(value) {
    this._text = String(value);
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(" "); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
function button(root, label) { return find(root, (n) => n.tag === "button" && n.textContent === label); }
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setImmediate(r));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("update did not reach the expected state");
}

function board(overrides = {}, { local = true } = {}) {
  const root = new Element("body");
  const rail = root.appendChild(new Element("div"));
  rail.id = "updateRow";
  const sheet = root.appendChild(new Element("div"));
  const invitation = sheet.appendChild(new Element("input"));
  invitation.value = "partly typed username";
  const bridge = {
    updateStatus: async () => ({ current: "0.2.0", phase: "idle" }),
    updateCheck: async () => ({ current: "0.2.0", phase: "current" }),
    updateInstall: async () => ({ ok: true, manual: true }),
    ...overrides,
  };
  const context = vm.createContext({
    LOCAL: local,
    sheetOpen: true,
    window: { zevetLocal: bridge },
    $: (id) => find(root, (n) => n.id === id),
    el: (tag, className) => Object.assign(new Element(tag), { className }),
    tx: (node, text) => { node.textContent = text; return node; },
  });
  new vm.Script(source, { filename: "board-update-controls" }).runInContext(context);
  sheet.appendChild(context.versionSection());
  return { context, rail, sheet, invitation, bridge, version: () => context.$("versionSection") };
}

const ready = { current: "0.2.0", phase: "ready", version: "0.2.1", canInstall: true, manual: true };

test("a real update check refreshes open Settings through checking, download progress and install", async (t) => {
  const tmp = tempDir("zevet-ui-update-");
  t.after(tmp.cleanup);
  const body = Buffer.from("new app fixture!");
  const file = "zevet-0.2.1-macos-arm64.dmg";
  let controller;
  let installCalls = 0;
  const ui = board({
    updateCheck: () => updater.check(),
    updateInstall: async () => { installCalls++; return { ok: true, manual: true }; },
  });
  const updater = new AppUpdater({
    currentVersion: "0.2.0", platformKey: "darwin-arm64", dir: tmp.dir,
    onStatus: (s) => ui.context.receiveUpdate({ ...s, manual: true }),
    fetchImpl: async (url) => String(url).endsWith(".json")
      ? new Response(JSON.stringify({ version: "0.2.1", platforms: { "darwin-arm64": {
        file, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"),
      } } }))
      : new Response(new ReadableStream({ start(c) { controller = c; } })),
  });
  ui.context.receiveUpdate({ current: "0.2.0", phase: "idle", manual: true });
  assert.match(ui.version().textContent, /Not checked yet/);
  const checking = button(ui.version(), "Check now").click();
  assert.equal(button(ui.version(), "Checking…").disabled, true);
  await until(() => controller);
  controller.enqueue(body.subarray(0, 8));
  await until(() => updater.status().percent === 50);
  assert.match(ui.version().textContent, /Downloading 0.2.1 · 50%/);
  assert.equal(find(ui.version(), (n) => n.attributes.role === "progressbar").attributes["aria-valuenow"], "50");
  assert.equal(ui.invitation.parentNode, ui.sheet);
  assert.equal(ui.invitation.value, "partly typed username");
  controller.enqueue(body.subarray(8));
  controller.close();
  await checking;
  assert.ok(button(ui.version(), "Open installer"), "Settings must offer the installation where the check happened");
  assert.ok(button(ui.rail, "Open installer"));
  await button(ui.version(), "Open installer").click();
  assert.equal(installCalls, 1);
  assert.match(ui.version().textContent, /Installer opened/);
  assert.match(ui.version().textContent, /replace it in Applications/);
});

test("Windows offers a restart and blocks duplicate installation across both controls", async () => {
  const install = deferred();
  let calls = 0;
  const ui = board({ updateInstall: () => { calls++; return install.promise; } });
  ui.context.receiveUpdate({ ...ready, manual: false });
  const clicked = button(ui.version(), "Restart to install").click();
  assert.equal(button(ui.rail, "Restarting…").disabled, true);
  assert.equal(button(ui.version(), "Restarting…").disabled, true);
  ui.context.installUpdate();
  await flush();
  assert.equal(calls, 1);
  install.resolve({ ok: true, restarting: true });
  await clicked;
  assert.equal(button(ui.version(), "Restarting…").disabled, true);
});

test("a pushed download error is visible in Settings and the rail with a working retry", async () => {
  let retries = 0;
  const ui = board({ updateCheck: async () => { retries++; return ready; } });
  ui.context.receiveUpdate({ ...ready, phase: "error", canInstall: false, error: "Checksum mismatch" });
  assert.match(ui.version().textContent, /Checksum mismatch/);
  assert.match(ui.rail.textContent, /Checksum mismatch/);
  assert.equal(button(ui.version(), "Open installer"), null);
  await button(ui.version(), "Check now").click();
  assert.equal(retries, 1);
  assert.ok(button(ui.version(), "Open installer"));
});

test("a rejected check leaves a visible error and an enabled retry", async () => {
  const ui = board({ updateCheck: async () => { throw new Error("Connection lost"); } });
  await button(ui.version(), "Check now").click();
  assert.match(ui.version().textContent, /Connection lost/);
  assert.equal(button(ui.version(), "Check now").disabled, false);
});

test("both failed and rejected installer calls retain a usable install action", async () => {
  for (const result of [() => ({ ok: false, error: "Cannot open image" }), () => { throw new Error("Cannot open image"); }]) {
    const ui = board({ updateInstall: async () => result() });
    ui.context.receiveUpdate(ready);
    await button(ui.version(), "Open installer").click();
    assert.match(ui.version().textContent, /Cannot open image/);
    assert.match(ui.rail.textContent, /Cannot open image/);
    assert.equal(button(ui.version(), "Open installer").disabled, false);
  }
});

test("initial status cannot overwrite a newer update pushed from the app", async () => {
  const status = deferred();
  let push;
  const ui = board({ onUpdate: (callback) => { push = callback; }, updateStatus: () => status.promise });
  ui.context.startUpdates();
  await flush();
  push(ready);
  status.resolve({ current: "0.2.0", phase: "current" });
  await flush();
  assert.ok(button(ui.version(), "Open installer"));
});

test("ready without installation permission does not expose an install action", () => {
  const ui = board();
  ui.context.receiveUpdate({ ...ready, canInstall: false });
  assert.equal(button(ui.version(), "Open installer"), null);
  assert.equal(button(ui.rail, "Open installer"), null);
});

test("the update section degrades safely in browsers and old app builds", async () => {
  for (const ui of [board({}, { local: false }), board({ updateStatus: undefined, onUpdate: undefined })]) {
    ui.context.startUpdates();
    await flush();
    assert.match(ui.version().textContent, /Get the latest version/);
    assert.equal(button(ui.version(), "Check now"), null);
  }
});
