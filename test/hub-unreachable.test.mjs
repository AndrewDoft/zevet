// The board window's own network-failure path (main.js's openBoard ->
// did-fail-load -> unreachablePage), driven end-to-end against a hub that
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
import { ROOT } from "./helpers.mjs";

const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");

function drive(...args) {
  const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: "utf8", timeout: 30000 });
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
  drive("launch");
});

after(() => {
  try {
    drive("close");
  } catch {
    // best effort
  }
  delete process.env.ZEVET_HOME;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 });
});

describe("a hub nobody answers on", () => {
  test("the board names the host and gives an actionable reason, not a bare error code", async () => {
    // main.js retries once (a fresh network interface can lose the very first
    // request) before it gives up, so this has to outlast that retry.
    const text = await waitForBodyText((t) => /Offline/.test(t));
    assert.match(text, /Offline/);
    assert.match(text, /127\.0\.0\.1/); // the host is named, not just "Offline"
    assert.match(text, /firewall|VPN|DNS/i); // an actionable hint, not a bare error code
  });
});
