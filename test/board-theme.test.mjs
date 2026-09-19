import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT, startHub } from "./helpers.mjs";

const html = readFileSync(path.join(ROOT, "hub/public/index.html"), "utf8");
function tokens(selector) {
  const body = html.match(new RegExp(selector + "\\s*\\{([^}]+)"))?.[1];
  assert.ok(body, `missing theme ${selector}`);
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/g)].map((m) => [m[1], m[2]]));
}
const palettes = {
  light: tokens(":root"),
  dark: tokens(':root\\[data-theme="dark"\\]'),
};
function luminance(hex) {
  return hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
for (const [theme, colors] of Object.entries(palettes)) {
  test(`${theme} body, secondary, identity and fallback code text meet 4.5:1`, () => {
    for (const foreground of ["ink", "subtle", "cerulean", "alert", "success", "who-0", "who-1", "who-2", "who-3", "who-4", "syntax-string", "syntax-number", "syntax-function"]) {
      for (const background of ["paper", "fill", "raise-soft", "raise", "raise-line"]) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(ratio >= 4.5, `${theme} ${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
      }
    }
    // Muted copy appears on the paper and raised surfaces. Selected rows,
    // inline code and filled controls use ink/subtle instead.
    for (const background of ["paper", "raise-soft", "raise"]) {
      assert.ok(contrast(colors.muted, colors[background]) >= 4.5, `${theme} muted on ${background}`);
    }
  });
}

test("the hub serves the board's local fonts with intact bytes and rejects other files", async () => {
  const hub = await startHub();
  try {
    const names = [...html.matchAll(/src: url\("\/fonts\/([^"/]+)"\)/g)].map((m) => m[1]);
    assert.equal(names.length, 2);
    for (const name of names) {
      const response = await fetch(`${hub.base}/fonts/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("content-type"), "font/woff2");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
      assert.deepEqual(bytes, readFileSync(path.join(ROOT, "hub/public/fonts", name)));
    }
    for (const name of ["../server.mjs", "..%2fserver.mjs", "LICENSE", "space-grotesk-variable.woff2.bak"]) {
      const response = await fetch(`${hub.base}/fonts/${name}`);
      assert.equal(response.status, 404, name);
      await response.text();
    }
  } finally { await hub.stop(); }
});

function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing board functions: ${start}`);
  return html.slice(a, b);
}
const themeSource = between("  function pref(", "  /* ---- the settings sheet");
const settingsSource = between("  var sheetOpen = false;", "  function refreshIndexStatus()") +
  between("  function srow(", "  function versionSection()");

function board(storedTheme = "dark") {
  let doc;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; this.id = ""; this.scrollTop = 0; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this); this.parent = null; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    get isConnected() { return doc.body.contains(this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, fn) { this.listeners[key] = fn; }
    focus() { doc.activeElement = this; }
    getClientRects() { return [{}]; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    querySelectorAll() { return this.children.flatMap((n) => [n, ...n.querySelectorAll()]).filter((n) => ["button", "input", "select", "textarea"].includes(n.tag) && !n.disabled); }
  }
  doc = { body: new Element("body"), documentElement: new Element("html") };
  const shell = doc.body.appendChild(new Element("main"));
  const settings = shell.appendChild(Object.assign(new Element("button"), { id: "settingsLink" }));
  const themer = shell.appendChild(Object.assign(new Element("button"), { id: "themer" }));
  const label = shell.appendChild(Object.assign(new Element("span"), { id: "themeLabel" }));
  const find = (id, node = doc.body) => node.id === id ? node : node.children.map((n) => find(id, n)).find(Boolean);
  doc.querySelector = () => shell;
  settings.focus();
  const preferences = new Map([["zevet.theme", storedTheme]]);
  const editorThemes = [];
  const chrome = [];
  const context = vm.createContext({
    document: doc, window: {
      localStorage: { getItem: (key) => preferences.get(key), setItem: (key, value) => preferences.set(key, value) },
      zevetLocal: { chrome: (value) => chrome.push(value) },
    },
    getComputedStyle: () => ({ getPropertyValue: (name) => palettes[doc.documentElement.attributes["data-theme"]][name.slice(2)] }),
    $: find,
    el: (tag, className) => Object.assign(new Element(tag), { className }),
    tx: (node, text) => { node.textContent = text; return node; },
    LOCAL: true, localWorkspaces: [], myActor: "test", location: { origin: "http://local.test" },
    ed: { setDark: (value) => editorThemes.push(value) }, drawRiders() {}, render() {},
    refreshIndexStatus() {}, refreshWhoami() {}, credentialLabel: () => "test",
    accountSection: () => {
      const form = new Element("form");
      form.appendChild(Object.assign(new Element("input"), { id: "settingsInvite", value: "", selectionStart: 0, selectionEnd: 0 }));
      return form;
    },
    indexSection: () => new Element("div"), versionSection: () => new Element("div"),
  });
  vm.runInContext(themeSource + settingsSource, context);
  return { context, doc, find, preferences, editorThemes, chrome, settings, shell, themer, label };
}

test("saved theme and toggles update the existing editor and native chrome", () => {
  const b = board("dark");
  b.context.applyTheme();
  assert.equal(b.doc.documentElement.attributes["data-theme"], "dark");
  assert.equal(b.themer.attributes["aria-pressed"], "true");
  assert.equal(b.chrome.at(-1).paper, palettes.dark.paper);
  b.context.setTheme("light");
  assert.equal(b.preferences.get("zevet.theme"), "light");
  assert.equal(b.label.textContent, "Light");
  assert.equal(b.chrome.at(-1).paper, palettes.light.paper);
  assert.deepEqual(b.editorThemes, [false]);
});

test("Settings keeps focus and an invitation draft when the theme refreshes, then returns focus", () => {
  const b = board();
  b.context.openSettings();
  assert.equal(b.find("sheet").attributes["aria-modal"], "true");
  assert.equal(b.shell.inert, true);
  assert.equal(b.doc.activeElement.id, "settingsClose");
  const invite = b.find("settingsInvite");
  invite.value = "partly-typed-name";
  invite.setSelectionRange(3, 8);
  const theme = b.find("settingsTheme");
  theme.focus();
  theme.listeners.click();
  assert.equal(b.doc.activeElement.id, "settingsTheme");
  assert.equal(b.find("settingsInvite").value, "partly-typed-name");
  assert.equal(b.find("settingsInvite").selectionStart, 3);
  b.context.closeSettings();
  assert.equal(b.shell.inert, false);
  assert.equal(b.doc.activeElement, b.settings);
  assert.equal(b.find("sheet"), undefined);
});

test("Settings traps Tab in both directions and Escape closes it", () => {
  const b = board();
  b.context.openSettings();
  const sheet = b.find("sheet");
  const controls = sheet.querySelectorAll();
  let prevented = 0, stopped = 0;
  const event = (key, shiftKey = false) => ({ key, shiftKey, currentTarget: sheet, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  controls[0].focus();
  b.context.sheetKeydown(event("Tab", true));
  assert.equal(b.doc.activeElement, controls.at(-1));
  b.context.sheetKeydown(event("Tab"));
  assert.equal(b.doc.activeElement, controls[0]);
  assert.equal(prevented, 2);
  b.context.sheetKeydown(event("Escape"));
  assert.equal(b.find("sheet"), undefined);
  assert.equal(b.doc.activeElement, b.settings);
  assert.equal(stopped, 1);
});
