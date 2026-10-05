// Settings' Version shows the BUILD that is running, not the installer's.
// After a payload swap the installer stays at (say) 0.2.89 while 0.2.91 runs;
// the updater's `current` is the installer's, because that is what the feed is
// compared against. Both roads to the board must replace it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers.mjs";

const main = fs.readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");

test("the helper puts the running build in `current` and keeps the rest", () => {
  const src = main.slice(main.indexOf("function withRunningBuild("), main.indexOf("const appUpdater = new AppUpdater({"));
  const ctx = { APP_VERSION: "0.2.91" };
  vm.runInNewContext(src + ";this.f = withRunningBuild;", ctx);
  assert.deepEqual({ ...ctx.f({ current: "0.2.89", phase: "current" }) }, { current: "0.2.91", phase: "current" });
  assert.equal(ctx.f(null), null);
});

test("the status poll and the pushed status both carry it", () => {
  assert.match(main, /bridge\.handle\("app:updateStatus", \(\) => withRunningBuild\(appUpdater\.status\(\)\)\)/);
  assert.match(main, /onStatus: \(raw\) => \{\s*const s = withRunningBuild\(raw\);/);
});
