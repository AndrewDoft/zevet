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
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { startHub, ROOT, NO_DRIVE } from "./helpers.mjs";

const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");
const SECRET = randomBytes(24).toString("hex");
/** What a person must never see: a hub, its address, or its host. */
const HUB_COPY = /\bhub\b|sslip|https?:\/\//i;

test("setup window polls its configured hub build and keeps the same reload guard", () => {
  const setup = readFileSync(path.join(ROOT, "desktop", "setup.html"), "utf8");
  assert.match(setup, /fetch\(String\(c\.hub\)[\s\S]{0,120}\/version/);
  assert.match(setup, /setInterval\(checkHubBuild, 60000\)/);
  assert.match(setup, /Date\.now\(\) - lastInput >= 120000/);
  assert.match(setup, /holdsSetupWork\(\)/);
});

function drive(...args) {
  const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: "utf8", timeout: 90000 });
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
  if (NO_DRIVE) return;
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
  // The app resolves the hub itself (desktop/hub-target.js); this is how the
  // driven one is pointed at the test hub, since setup has no field for it.
  process.env.ZEVET_HUB = hub.base;
  // The driven app's real updater checks its feed 25s after launch. Left at the
  // default that is the LIVE usemasora.com feed, so this file's first test was
  // asserting on whatever production happened to publish (a feed the app rejects,
  // e.g. an unsigned one, paints "Update failed"). The hub answers 404 here,
  // which the updater treats as "nothing published": a hermetic "current".
  process.env.ZEVET_APP_FEED = `${hub.base}/download/zevet-latest.json`;
  // A file of its own, not scripts/drive/.state.json's fixed default — see
  // drive.mjs's own comment. Without this, this file collides with any other
  // drive-based test file `node --test` happens to run concurrently.
  process.env.ZEVET_DRIVE_STATE = path.join(accountsDir, "drive-state.json");
  drive("launch");
});
after(async () => {
  if (NO_DRIVE) return;
  try {
    drive("close");
  } catch {
    // best effort
  }
  await hub?.stop();
  if (accountsDir) rmSync(accountsDir, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 });
});

describe("a fresh install's setup window", { skip: NO_DRIVE }, () => {
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

  test("Join mode leads with the invite key; Create mode does not show it", () => {
    // modeJoin is still the active mode from the previous test.
    assert.match(drive("snapshot").outline, /div#joinKeyRow(?!.*hidden)/);
    assert.match(drive("snapshot").outline, /input#inviteKey/);
    assert.match(drive("snapshot").outline, /button#joinKey[^\n]*"Join"/);
    // GitHub/Google are still present in Join mode, just demoted.
    const joinClasses = drive("eval", `["google","gh"].map(function (id) { return document.getElementById(id).classList.contains("primary"); })`);
    assert.deepEqual(joinClasses.result ?? joinClasses.value ?? joinClasses, [false, false]);

    drive("click", "#modeCreate");
    assert.match(drive("snapshot").outline, /div#joinKeyRow[^\n]*hidden/);
    const createClasses = drive("eval", `["google","gh"].map(function (id) { return document.getElementById(id).classList.contains("primary"); })`);
    assert.deepEqual(createClasses.result ?? createClasses.value ?? createClasses, [true, true]);

    drive("click", "#modeJoin"); // leave it in Join mode for the tests that follow
  });

  test("Join: an empty or malformed key says Key? without reaching the hub", () => {
    drive("type", "#teamName", "Acme Platform");
    drive("type", "#inviteKey", "");
    drive("click", "#joinKey");
    assert.match(drive("snapshot").outline, /div#msg(?!.*hidden)[^\n]*"Key\?"/);
  });

  test("Join: a wrong key against a real team is refused with the hub's own terse error", async () => {
    drive("type", "#teamName", "Acme Platform");
    drive("type", "#actor", "trevor");
    drive("type", "#inviteKey", "ZZZZ-ZZZZ");
    drive("click", "#joinKey");
    // "bad key" is short enough that setup.html's own `short()` shows it
    // verbatim rather than falling back to a generic "Failed".
    const outline = await waitFor((o) => !/#joinKey[^\n]*disabled/.test(o) && /div#msg(?!.*hidden)[^\n]*"bad key"/.test(o));
    assert.match(outline, /"bad key"/);
    assert.match(outline, /button#finish[^\n]*disabled[^\n]*"Open"/); // Open stays disabled
  });

  test("there is nothing to type a hub into, and no hub text is rendered", () => {
    const html = drive("eval", `(function () {
      var c = document.body.cloneNode(true);
      c.querySelectorAll("script,style").forEach(function (n) { n.remove(); });
      return c.outerHTML + " " + document.title;
    })()`);
    assert.doesNotMatch(String(html.result ?? html.value ?? html), HUB_COPY);
    assert.doesNotMatch(drive("snapshot").outline, /input#hub|details#other/);
  });

  // BUG-2026-09-28, Andrew verbatim: "there are two spaces for the key, we
  // only need the top ones." The master-secret "Other" fallback (id="token",
  // id="manual", id="check") is removed outright — GitHub/Google sign-in and
  // the invite key above (input#inviteKey) are the only two ways in now.
  test("there is no second key field: no 'Other' fallback, no manual secret", () => {
    const outline = drive("snapshot").outline;
    assert.doesNotMatch(outline, /input#token|details#manual|button#check/);
    assert.doesNotMatch(outline, /summary[^\n]*"Other"/);
  });

  // signedIn() is what a completed GitHub/Google sign-in OR a redeemed
  // invite key both call (setup.html's own click handlers) — its DOM effects
  // are exercised directly here, the same established pattern this file
  // already uses for paintUpdate above, because every sign-in path in THIS
  // file's single hub instance either has no real OAuth app (GitHub/Google)
  // or needs an owner session that only a real sign-in can create (the
  // invite-key success path is proven at the HTTP layer in
  // test/team.test.mjs's "/team/join" describe; this proves the UI WIRING
  // signedIn() drives once any of those paths reports success).
  test("a completed sign-in enables Open and reveals Folder", () => {
    drive("eval", `window.signedIn({ teamName: "Acme Platform", login: "trevor", owner: false })`);
    const outline = drive("snapshot").outline;
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
