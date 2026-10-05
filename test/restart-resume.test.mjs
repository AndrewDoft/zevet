// Restart now (installer) is a relaunch too: the Claude consoles it closes
// are saved first, so the new build resumes them (masora2-09, 2026-09-30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the installer's Restart now saves the running consoles before it exits", () => {
  const main = readFileSync(new URL("../desktop/main.js", import.meta.url), "utf8");
  const quit = main.slice(main.indexOf("quitImpl: () => {"), main.indexOf("quitImpl: () => {") + 900);
  assert.ok(quit.indexOf("releaseForRelaunch();") > 0 && quit.indexOf("releaseForRelaunch();") < quit.indexOf("app.exit(0);"), "saved before exit");
  const release = main.slice(main.indexOf("function releaseForRelaunch() {"), main.indexOf("function releaseForRelaunch() {") + 300);
  assert.match(release, /persistResumableConsoles\(\);/);
});
