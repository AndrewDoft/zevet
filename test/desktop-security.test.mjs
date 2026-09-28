// Renderer-facing hardening in desktop/main.js. main.js cannot be require()d
// outside Electron, so these read the source (same approach as zoom.test.mjs)
// and pin the guards' presence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");

test("zevet:install refuses a path that is not a known workspace or the one just picked", () => {
  const at = main.indexOf('ipcMain.handle("zevet:install"');
  assert.ok(at > 0);
  const body = main.slice(at, main.indexOf("\n});", at));
  assert.match(body, /knownRoot\(repo\)/);
  assert.ok(body.indexOf("knownRoot(repo)") < body.indexOf("installHooks("), "guard must run before installHooks");
});
