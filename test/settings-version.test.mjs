// Settings' Version shows the BUILD that is running, and the installer beside
// it when they differ: after a payload swap the installer stays at (say)
// 0.2.89 while 0.2.91 runs. The updater's `current` stays the installer's,
// because that is what the feed is compared against. A staged build shows as
// "Next". Both roads to the board carry it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers.mjs";

const main = fs.readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
const boardMain = fs.readFileSync(path.join(ROOT, "board", "src", "main.tsx"), "utf8");
const settings = fs.readFileSync(path.join(ROOT, "board", "src", "components", "settings.tsx"), "utf8");

function helper(bootShell) {
  const src = main.slice(main.indexOf("function withRunningBuild("), main.indexOf("const appUpdater = new AppUpdater({"));
  // `shell` is Electron's in main.js; a helper that reached for it would read this, not the payload.
  const ctx = { APP_VERSION: "0.2.91", bootShell, shell: { build: "WRONG", payload: { staged: () => ({ build: "WRONG" }) } } };
  vm.runInNewContext(src + ";this.f = withRunningBuild;", ctx);
  return ctx.f;
}

test("running is the payload build; current stays the installer's", () => {
  const f = helper({ payload: { staged: () => null }, log() {} });
  const out = f({ current: "0.2.89", phase: "current" });
  assert.equal(out.running, "0.2.91");
  assert.equal(out.current, "0.2.89");
  assert.equal(out.next, undefined);
  assert.equal(f(null), null);
});

test("a staged build shows as Next, and an unreadable one is logged, not thrown", () => {
  assert.deepEqual({ ...helper({ payload: { staged: () => ({ build: "0.2.94" }) }, log() {} })({ current: "0.2.89" }).next }, { build: "0.2.94", when: "on restart" });
  const logged = [];
  const out = helper({ payload: { staged: () => { throw new Error("bad json"); } }, log: (m) => logged.push(m) })({ current: "0.2.89" });
  assert.equal(out.next, undefined);
  assert.match(logged[0], /bad json/);
});

test("the status poll and the pushed status both carry it", () => {
  assert.match(main, /bridge\.handle\("app:updateStatus", \(\) => withRunningBuild\(appUpdater\.status\(\)\)\)/);
  assert.match(main, /onStatus: \(raw\) => \{\s*const s = withRunningBuild\(raw\);/);
});

test("Settings shows only the running build, never the installer beside it, and Next", () => {
  // Andrew, 2026-10-01: "settings should only show 2.105 or whatever the new version is, not the app thing".
  assert.match(settings, /summary=\{bridge\.cfg\?\.version \|\| \(s && s\.running\) \|\| "unknown"\}/);
  assert.doesNotMatch(settings, /\(app \$\{s\.current\}\)/);
  assert.match(settings, /k="Next" v=\{`\$\{s\.next\.build\} \(\$\{s\.next\.when\}\)`\}/);
});

test("the first Settings render has the running build synchronously and cannot fall back to current", () => {
  assert.match(main, /build=\$\{encodeURIComponent\(APP_VERSION\)\}/);
  assert.match(boardMain, /window\.__zevetCfg = \{ version: bootstrapBuild \}/);
  assert.match(settings, /bridge\.cfg\?\.version \|\| \(s && s\.running\)/);
  assert.doesNotMatch(settings, /s\.current/);
});
