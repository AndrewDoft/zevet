// D-NEXT-NOPOPUP: automated runs never put a window on a person's screen. Launches the real app (fresh
// profile => the sign-in/setup window) through the harness and reads desktop/main.js's windows.jsonl:
// every window must be created hidden, must never become visible, and show/focus must be blocked.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT, NO_DRIVE } from "./helpers.mjs";

const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");
const drive = (...a) => JSON.parse(execFileSync(process.execPath, [DRIVE, ...a], { encoding: "utf8", timeout: 90000, env: { ...process.env, ZEVET_DRIVE_STATE: STATE } }));
let dir, STATE, home;
before(() => {
  if (NO_DRIVE) return;
  dir = mkdtempSync(path.join(tmpdir(), "zevet-novisible-"));
  STATE = path.join(dir, "state.json");
  home = drive("launch").home;
});
after(() => {
  if (NO_DRIVE) return;
  try { drive("close"); } catch { /* best effort */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
});

describe("no visible windows under the harness", { skip: NO_DRIVE }, () => {
  test("the sign-in/setup window is created hidden and never becomes visible", () => {
    const log = path.join(home, "windows.jsonl");
    assert.ok(existsSync(log), "no windows.jsonl: the app made no window, so this test would be vacuous");
    const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.kind === "setup" && r.event === "created"), "expected the first-run setup window");
    const visible = rows.filter((r) => r.visible || r.event === "shown" || !r.hidden);
    assert.deepEqual(visible, [], "a window was visible under the test runner");
    drive("windows"); // the page still loads and is drivable while hidden
  });
});
