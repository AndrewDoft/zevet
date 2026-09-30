// The board window's own network-failure path (main.js's openBoard ->
// did-fail-load -> reconnectingPage), driven end-to-end against a hub that
// answers nobody: deterministic on every OS this suite runs on, unlike an
// actually-blocked DNS name, which would make this flaky by depending on
// whatever the runner's network happens to do that day.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT, NO_DRIVE } from "./helpers.mjs";

const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");

// Launch starts Electron: 30 s ran out on a loaded box (2026-09-30, ship gate ETIMEDOUT
// while other agents ran), so it gets 120 s — CLAUDE.md §9.1's 3.3-4.8x slow-hardware margin.
function drive(...args) {
  const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: "utf8", timeout: args[0] === "launch" ? 120000 : 30000 });
  return JSON.parse(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the board's rendered text until `pred` is true or the budget runs out. */
async function waitForBodyText(pred, { tries = 40, everyMs = 250 } = {}) {
  let text = "";
  for (let i = 0; i < tries; i++) {
    const r = drive("eval", "document.body.textContent");
    text = String(r.result ?? "");
    if (pred(text)) return text;
    await sleep(everyMs);
  }
  return text;
}

// A privileged loopback port a normal process cannot bind: the connection is
// refused immediately on Windows, macOS and Linux alike, rather than timing
// out the way an unroutable address would.
const DEAD_HUB = "http://127.0.0.1:1";

let homeDir;
before(() => {
  if (NO_DRIVE) return;
  // A pre-seeded config, not a fresh profile: this is a test of the BOARD
  // window's failure path, which only runs once setup is already done. See
  // scripts/drive/drive.mjs's "launch" -- it respects an already-set
  // ZEVET_HOME rather than always handing the app an empty one.
  homeDir = mkdtempSync(path.join(tmpdir(), "zevet-unreachable-home-"));
  writeFileSync(
    path.join(homeDir, "config.json"),
    JSON.stringify({ hub: DEAD_HUB, secret: randomBytes(24).toString("hex"), actor: "citest" }, null, 2),
  );
  process.env.ZEVET_HOME = homeDir;
  // A file of its own — see drive.mjs's own comment on ZEVET_DRIVE_STATE.
  // Without this, this file collides with any other drive-based test file
  // `node --test` happens to run concurrently (BUG-2026-09-28).
  process.env.ZEVET_DRIVE_STATE = path.join(homeDir, "drive-state.json");
  drive("launch");
});

after(() => {
  if (NO_DRIVE) return;
  try {
    drive("close");
  } catch {
    // best effort
  }
  delete process.env.ZEVET_HOME;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 });
});

describe("a hub nobody answers on", { skip: NO_DRIVE }, () => {
  test("the board says Reconnecting in Zevet's words, with no address and no error code, and keeps trying", async () => {
    const text = await waitForBodyText((t) => /Reconnecting/.test(t));
    assert.match(text, /Reconnecting/);
    assert.match(text, /Your work is safe/);
    assert.doesNotMatch(text, /127\.0\.0\.1|hub|ERR_|\(-\d+\)/i);
  });
});
