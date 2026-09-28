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

import { createRequire } from "node:module";
const { isSafeUrl, openSafe } = createRequire(import.meta.url)("../desktop/open-safe.js");

test("openSafe allows https and loopback http only", async () => {
  for (const ok of ["https://example.com/x", "http://127.0.0.1:3210/admin", "http://localhost/a", "http://[::1]:1/"]) {
    assert.equal(isSafeUrl(ok), true, ok);
  }
  for (const bad of ["file:///etc/passwd", "smb://host/share", "http://example.com/", "javascript:alert(1)", "ms-msdt:x", "nonsense", "", null]) {
    assert.equal(isSafeUrl(bad), false, String(bad));
  }
  const opened = [];
  const shell = { openExternal: (u) => (opened.push(u), Promise.resolve()) };
  await openSafe("https://example.com/", shell);
  await assert.rejects(openSafe("file:///etc/passwd", shell));
  assert.deepEqual(opened, ["https://example.com/"]);
});

test("no shell.openExternal call site in desktop/*.js bypasses openSafe", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = path.join(ROOT, "desktop");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "open-safe.js")) {
    const src = readFileSync(path.join(dir, f), "utf8");
    // the ZEVET_TEST_HOOKS override assigns to it; that is the only allowed mention in main.js
    const calls = src.split("\n").filter((l) => /shell\.openExternal\(/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    assert.deepEqual(calls.filter((l) => !/openSafe/.test(l)), [], `${f} calls shell.openExternal directly`);
  }
});
