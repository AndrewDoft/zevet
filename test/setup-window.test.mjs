// The setup/onboarding window, driven end-to-end in the real Electron app via
// scripts/drive/drive.mjs — the P0 fixes for a).b).c).d) in one file because
// they share one fresh app instance (launching Electron is the expensive
// part) and because (a) and (b) are the same root cause from two ends: a
// first-run person had no team address to type, and no way to get one.
//
// Network-dependent, like the existing google-routes.test.mjs/hub.test.mjs
// pattern: a local hub is spawned per test file and some calls are real HTTP
// to it. Nothing here calls github.com or google.com — the OAuth device/web
// flows are exercised in github-signin.test.mjs and google-signin.test.mjs
// against a fake fetch instead, for the same reason those files give: there
// is nowhere to inject a fake GitHub inside a spawned hub process.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { startHub, ROOT } from "./helpers.mjs";

const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");
const SECRET = randomBytes(24).toString("hex");

function drive(...args) {
  const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a snapshot until `pred` is true or the budget runs out. */
async function waitFor(pred, { tries = 30, everyMs = 150 } = {}) {
  let outline = "";
  for (let i = 0; i < tries; i++) {
    outline = drive("snapshot").outline;
    if (pred(outline)) return outline;
    await sleep(everyMs);
  }
  return outline;
}

let hub;
let accountsDir;
before(async () => {
  // ZEVET_SECRET, and ZEVET_TOKEN cleared to "" rather than left at helpers'
  // default: the manual "Team key" field in setup.html is the master secret,
  // and this hub's shared token must be DERIVED from it (matching what a
  // real teammate types) rather than an unrelated literal — the two
  // disagreeing is exactly the refusal-to-start case hub/server.mjs guards
  // (§ "ZEVET_TOKEN STILL WINS WHEN IT IS SET"). ZEVET_GITHUB_CLIENT_ID turns
  // on /team/create without needing a real GitHub app.
  //
  // ⚠️ ZEVET_ACCOUNTS IS NOT OPTIONAL HERE. Without it, a hub with any OAuth
  // client id configured persists to the REAL hub/var/accounts.json, and
  // Accounts#load ADOPTS THAT FILE'S secret over ZEVET_SECRET when one already
  // exists on disk from an earlier run — so the token typed below would be
  // checked against a stale secret from a previous test run, not this one.
  // Caught by running this file twice in a row.
  accountsDir = mkdtempSync(path.join(tmpdir(), "zevet-setup-window-accounts-"));
  hub = await startHub({
    ZEVET_SECRET: SECRET,
    ZEVET_TOKEN: "",
    ZEVET_GITHUB_CLIENT_ID: "test-client-id",
    ZEVET_ACCOUNTS: path.join(accountsDir, "accounts.json"),
  });
  drive("launch");
});
after(async () => {
  try {
    drive("close");
  } catch {
    // best effort
  }
  await hub?.stop();
  if (accountsDir) rmSync(accountsDir, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 });
});

describe("a fresh install's setup window", () => {
  test("shows the controls a first-run person needs, with Open disabled", () => {
    const { outline } = drive("snapshot");
    assert.match(outline, /input#teamName/);
    assert.match(outline, /button#modeCreate[^\n]*"Create"/);
    assert.match(outline, /button#modeJoin[^\n]*"Join"/);
    assert.match(outline, /button#google[^\n]*"Google"/);
    assert.match(outline, /button#gh[^\n]*"GitHub"/);
    assert.match(outline, /button#finish[^\n]*disabled[^\n]*"Open"/);
  });

  test("the sign-in buttons carry the provider mark and an accessible name", () => {
    const r = drive("eval", `["google","gh"].map(function (id) {
      var b = document.getElementById(id);
      return [b.getAttribute("aria-label"), !!b.querySelector("svg[data-brand]"), b.textContent.trim()];
    })`);
    assert.deepEqual(r.result ?? r.value ?? r, [["Sign in with Google", true, "Google"], ["Sign in with GitHub", true, "GitHub"]]);
  });

  test("the window is frameless: a drag bar sits where the caption was", () => {
    const r = drive("eval", `getComputedStyle(document.querySelector(".titlebar")).webkitAppRegion`);
    assert.equal(r.result ?? r.value ?? r, "drag");
  });

  // Run early, deliberately: main.js's real appUpdater fires its first check
  // FIRST_CHECK_MS (25s) after launch; see the note this replaced.
  test("the update banner paints from a status the app pushes, before any sign-in", () => {
    assert.match(drive("snapshot").outline, /div#updateNote[^\n]*hidden/);
    drive("eval", `window.paintUpdate({ phase: "ready", version: "9.9.9", canInstall: true, manual: false })`);
    const ready = drive("snapshot").outline;
    assert.match(ready, /div#updateNote(?!.*hidden)[^\n]*"v9.9.9/);
    assert.match(ready, /button#updateBtn(?!.*hidden)[^\n]*"Restart"/);
    drive("eval", `window.paintUpdate({ phase: "current" })`);
    assert.match(drive("snapshot").outline, /div#updateNote[^\n]*hidden/);
  });

  test("signing in with no team name opens no browser and says Name?", () => {
    drive("click", "#google");
    assert.deepEqual(drive("opened"), []);
    assert.match(drive("snapshot").outline, /div#msg(?!.*hidden)[^\n]*"Name\?"/);
  });

  test("Create makes the team on the hub, named by what was typed", async () => {
    drive("eval", `window.HOSTED_HUB = ${JSON.stringify(hub.base)}`);
    drive("type", "#teamName", "Acme platform");
    drive("click", "#google");
    // The hub has no Google client, so sign-in itself fails; the team is made first.
    await waitFor((o) => /div#msg(?!.*hidden)[^\n]*"Sign-in failed"/.test(o));
    const r = await (await fetch(`${hub.base}/team/resolve?name=acme-platform`)).json();
    assert.deepEqual(r, { exists: true, team: "acme-platform" });
    assert.deepEqual(drive("opened"), []);
  });

  test("a taken name says Taken and offers name-2", async () => {
    await fetch(`${hub.base}/team/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Taken Co" }) });
    drive("type", "#teamName", "taken co");
    drive("click", "#gh");
    const outline = await waitFor((o) => /button#suggest/.test(o));
    assert.match(outline, /div#msg[^\n]*"Taken/);
    assert.match(outline, /button#suggest[^\n]*"taken-co-2"/);
    drive("click", "#suggest");
    assert.match(drive("snapshot").outline, /input#teamName[^\n]*"taken-co-2"/);
  });

  test("Join: an unknown team says No team; a known one goes on to sign-in", async () => {
    drive("click", "#modeJoin");
    drive("type", "#teamName", "nobody-here");
    drive("click", "#google");
    let outline = await waitFor((o) => /div#msg(?!.*hidden)[^\n]*"No team"/.test(o));
    assert.match(outline, /"No team"/);
    drive("type", "#teamName", "Acme Platform");
    drive("click", "#google");
    outline = await waitFor((o) => /div#msg(?!.*hidden)[^\n]*"Sign-in failed"/.test(o));
    assert.doesNotMatch(outline, /No team/);
  });

  test("Other hub is folded away, and a typed one wins over the hosted default", async () => {
    assert.match(drive("snapshot").outline, /details#other(?!.*open)/);
    drive("eval", `window.HOSTED_HUB = "http://127.0.0.1:1"`);
    drive("click", "#modeCreate");
    drive("click", "#other summary");
    drive("type", "#hub", hub.base);
    drive("type", "#teamName", "Elsewhere");
    drive("click", "#gh");
    await waitFor((o) => /div#msg(?!.*hidden)[^\n]*"Sign-in failed"/.test(o));
    const r = await (await fetch(`${hub.base}/team/resolve?name=elsewhere`)).json();
    assert.equal(r.exists, true);
  });

  test("the team-key path connects, enables Open, and reveals Folder", async () => {
    drive("click", "#manual summary");
    drive("type", "#hub", hub.base);
    drive("type", "#token", SECRET);
    drive("type", "#actor", "trevor");
    drive("click", "#check");
    const outline = await waitFor((o) => !/#check[^\n]*disabled/.test(o) && /div#msg[^\n]*"Connected"/.test(o));
    assert.match(outline, /div#msg[^\n]*"Connected"/);
    assert.doesNotMatch(outline, /button#finish[^\n]*disabled/);
    assert.match(outline, /button#pick[^\n]*"Folder"/);
  });

  test("the Cancel buttons reset the window without a live sign-in", () => {
    drive("eval", `document.getElementById("ghStep").hidden = false`);
    drive("click", "#ghCancel");
    assert.match(drive("snapshot").outline, /div#ghStep[^\n]*hidden/);
    drive("eval", `document.getElementById("googleStep").hidden = false`);
    drive("click", "#googleCancel");
    assert.match(drive("snapshot").outline, /div#googleStep[^\n]*hidden/);
  });
});
