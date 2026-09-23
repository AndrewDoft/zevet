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
  test("shows the controls a first-run person needs, with Finish disabled", () => {
    const { outline } = drive("snapshot");
    assert.match(outline, /button#createTeam[^\n]*"Create a team"/);
    assert.match(outline, /button#google[^\n]*"Sign in with Google"/);
    assert.match(outline, /button#gh[^\n]*"Sign in with GitHub"/);
    assert.match(outline, /button#finish[^\n]*disabled[^\n]*"Open zevet"/);
  });

  // Run early, deliberately: main.js's real appUpdater fires its first check
  // FIRST_CHECK_MS (25s) after launch, and a real push landing between this
  // test's own synthetic ones would show a real version rather than "9.9.9"
  // — a flake this test then has to explain rather than one anyone caused.
  test("c). the update banner paints from a status the app pushes, before any sign-in", () => {
    const before = drive("snapshot").outline;
    assert.match(before, /div#updateNote[^\n]*hidden/, "nothing to show yet on a version that is current");

    drive("eval", `window.paintUpdate({ phase: "ready", version: "9.9.9", canInstall: true, manual: false })`);
    const ready = drive("snapshot").outline;
    // div#updateNote's own captured text is the span's and the button's text
    // concatenated (it is the outer container's textContent) — no quote sits
    // between "ready." and "Restart", so the pattern must not require one.
    assert.match(ready, /div#updateNote(?!.*hidden)[^\n]*"v9\.9\.9 is ready\./);
    assert.match(ready, /button#updateBtn(?!.*hidden)[^\n]*"Restart to install"/);

    drive("eval", `window.paintUpdate({ phase: "current" })`);
    const gone = drive("snapshot").outline;
    assert.match(gone, /div#updateNote[^\n]*hidden/);
  });

  test("a). clicking a sign-in button with no team address opens no browser, and says why", () => {
    drive("click", "#google");
    const opened = drive("opened");
    assert.deepEqual(opened, [], "must not open a browser with nothing to open it to");
    const { outline } = drive("snapshot");
    assert.match(outline, /div#msg[^\n]*"Create a team, or paste your team address\."/);
  });

  test("b). Create a team mints one on the hosted hub's address and updates the buttons", async () => {
    // Point the page's own HOSTED_HUB at this test's local hub rather than
    // Andrew's production one — `var HOSTED_HUB` in a classic (non-module)
    // inline script is a `window` property, reassignable from here.
    drive("eval", `window.HOSTED_HUB = ${JSON.stringify(hub.base)}`);
    drive("click", "#createTeam");
    // teamCreate is a single awaited IPC round trip to a hub on localhost;
    // give it a moment rather than asserting on the very next tick.
    const outline = await waitFor((o) => /div#createNote(?!.*hidden)/.test(o));
    const hubValuePattern = new RegExp(`input#hub[^\\n]*"${hub.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
    assert.match(outline, hubValuePattern, "hub field is set to the hosted (here: test) hub address");
    assert.match(outline, /div#createNote(?!.*hidden)[^\n]*"Team created/);
    assert.match(outline, /button#google[^\n]*"Create with Google"/);
    assert.match(outline, /button#gh[^\n]*"Create with GitHub"/);
  });

  test("editing the hub by hand clears the created team and restores the button labels", () => {
    drive("type", "#hub", hub.base + "/extra");
    const { outline } = drive("snapshot");
    assert.match(outline, /button#google[^\n]*"Sign in with Google"/);
    assert.match(outline, /button#gh[^\n]*"Sign in with GitHub"/);
    assert.match(outline, /div#createNote[^\n]*hidden/);
  });

  test("d). the manual team-key path connects, enables Finish, and reveals Connect a folder", async () => {
    drive("click", "summary");
    drive("type", "#hub", hub.base);
    drive("type", "#token", SECRET);
    drive("type", "#actor", "trevor");
    drive("click", "#check");
    const outline = await waitFor((o) => !/#check[^\n]*disabled/.test(o) && /div#msg/.test(o));
    assert.match(outline, /div#msg[^\n]*"Connected\./);
    assert.doesNotMatch(outline, /button#finish[^\n]*disabled/);
    assert.match(outline, /button#finish[^\n]*"Open zevet"/);
    assert.match(outline, /div#repoStep[^\n]*"Connect a folder/);
    assert.match(outline, /button#pick[^\n]*"Connect a folder…"/);
  });

  test("d). the GitHub cancel button resets the window without needing a live sign-in", () => {
    // Simulate "a device flow is in progress" without a real GitHub round
    // trip: unhide the step the way `ghBusy(true)` does.
    drive("eval", `document.getElementById("ghStep").hidden = false`);
    drive("click", "#ghCancel");
    const { outline } = drive("snapshot");
    assert.match(outline, /div#ghStep[^\n]*hidden/);
    assert.match(outline, /div#msg[^\n]*"Sign-in cancelled\."/);
  });

  test("d). the Google cancel button resets the window the same way", () => {
    drive("eval", `document.getElementById("googleStep").hidden = false`);
    drive("click", "#googleCancel");
    const { outline } = drive("snapshot");
    assert.match(outline, /div#googleStep[^\n]*hidden/);
    assert.match(outline, /div#msg[^\n]*"Sign-in cancelled\."/);
  });

});
