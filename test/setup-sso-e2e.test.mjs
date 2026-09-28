// Proves the FULL desktop GitHub/Google sign-in mechanism end to end: a real
// Electron app, driven by scripts/drive/drive.mjs, against a real hub
// subprocess — with the one thing neither of those can supply in CI, a human
// clicking "Authorize" in a real browser, replaced by hub/test-fake-idp.mjs.
//
// What this proves that github-signin.test.mjs/google-signin-desktop.test.mjs
// (a fake `fetch` against the desktop-side class, no Electron) and
// setup-window.test.mjs (a real Electron app, but sign-in always fails
// because there is no real GitHub/Google to answer) do not: that clicking
// the button in the real renderer reaches the real main-process IPC, opens
// the real (captured, never shown) browser URL, the real hub polls a real
// upstream to completion, and the result actually lands the setup window on
// "signed in, Open enabled" — the seam between all those pieces, not any one
// of them in isolation.
//
// ⚠️ NEVER RUN THIS FILE'S OWN NODE PROCESS LOCALLY ON A DEVELOPER MACHINE
// (CLAUDE.md-equivalent project rule: no headed Electron locally). It spawns
// a real, visible Electron window — CI runners have a desktop session but
// nobody watching it; a person's own machine does not. Run it only in CI
// (build.yml's `npm test`, dispatched or on push) or under a virtual display.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, ROOT } from "./helpers.mjs";

const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");

function drive(...args) {
  const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, { tries = 60, everyMs = 250 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = pred();
    if (await last) return;
    await sleep(everyMs);
  }
  throw new Error("waitFor timed out");
}

async function outline() {
  return drive("snapshot").outline;
}

let hub;
let accountsDir;
before(async () => {
  accountsDir = mkdtempSync(path.join(tmpdir(), "zevet-sso-e2e-accounts-"));
  hub = await startHub({
    ZEVET_ACCOUNTS: path.join(accountsDir, "accounts.json"),
    ZEVET_TOKEN: "",
    ZEVET_GITHUB_CLIENT_ID: "fake-gh-client-id",
    ZEVET_GOOGLE_CLIENT_ID: "fake-google-client-id",
    ZEVET_GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    // Query-string-only in this hub's own authorizeUrl/exchangeCode calls;
    // hub/test-fake-idp.mjs answers the token exchange unconditionally, so
    // this never has to match anything Google would actually check.
    ZEVET_GOOGLE_REDIRECT: "http://127.0.0.1/auth/google/callback",
    // The ONE flag that turns hub/test-fake-idp.mjs on (server.mjs's own
    // top-level TEST_IDP_FETCH) — never set outside this file's own hub.
    ZEVET_TEST_HOOKS: "1",
  });
  process.env.ZEVET_HUB = hub.base;
});
after(async () => {
  try {
    drive("close");
  } catch {
    // best effort — the per-test blocks below already close on their own path
  }
  await hub?.stop();
  if (accountsDir) rmSync(accountsDir, { recursive: true, force: true, maxRetries: 120, retryDelay: 250 });
});

describe("GitHub sign-in, real Electron app + real hub + faked GitHub", () => {
  test("Create + GitHub: browser URL captured, poll completes, board is reachable as owner", async () => {
    drive("launch");
    try {
      drive("type", "#teamName", "Acme SSO Co");
      assert.deepEqual(drive("opened"), [], "no browser before anything is clicked");

      drive("click", "#gh");
      await waitFor(async () => (await drive("opened")).length > 0);
      const opened = drive("opened");
      assert.equal(opened.length, 1);
      assert.match(opened[0].url, /^https:\/\/github\.com\/login\/device\?user_code=FAKE-CODE$/);

      // github-auth.mjs's own device flow: the fake answers
      // authorization_pending once before approving, so this also proves
      // desktop/github-signin.js's poll LOOP runs, not just its first call.
      await waitFor(async () => /Owner/.test(await outline()) || /Sign-in failed/.test(await outline()), { tries: 80 });
      const o = await outline();
      assert.doesNotMatch(o, /Sign-in failed/, `github sign-in failed: ${o}`);
      assert.match(o, /Acme SSO Co/);
      assert.match(o, /Owner/, "the first person into a brand-new team is its owner");
      assert.doesNotMatch(o, /button#finish[^\n]*disabled/, "Open must be enabled once signed in");
      assert.match(o, /button#pick[^\n]*"Folder"/);
    } finally {
      drive("close");
    }
  });
});

describe("Google sign-in, real Electron app + real hub + faked Google", () => {
  // Create, not Join: a plain Google identity joining a team GitHub already
  // claimed (test A) would be refused by accounts.mjs's mayEnter — it is
  // allowlist-gated once a team has an owner, and that allowlist path
  // (an invited email, admitted cross-provider) is already proven at the
  // HTTP layer in test/team.test.mjs. Create's trust-on-first-use lets THIS
  // test prove the Google mechanism itself — start, captured authUrl,
  // simulated callback, poll, completion — without also depending on it.
  test("Create + Google: pairCode captured, the (simulated) browser completes the callback, poll completes, board is reachable as owner", async () => {
    // A fresh, unconfigured profile — drive("launch") makes a new tmp
    // ZEVET_HOME automatically when the caller has not set one (see its own
    // comment), which is exactly "a second machine" for this purpose.
    drive("launch");
    try {
      drive("type", "#teamName", "Acme SSO Google Co");

      drive("click", "#google");
      await waitFor(async () => (await drive("opened")).length > 0);
      const opened = drive("opened");
      assert.equal(opened.length, 1);
      const authUrl = new URL(opened[0].url);
      assert.equal(authUrl.origin, "https://accounts.google.com");
      const state = authUrl.searchParams.get("state");
      assert.ok(state, "authUrl must carry the pairing code as `state`");

      // Stand-in for "the person's browser lands back on the hub" — the one
      // step this harness cannot itself drive because there is no real
      // Google to redirect it. Everything from here is the REAL hub route.
      const cb = await fetch(`${hub.base}/auth/google/callback?state=${state}&code=fake-google-auth-code`);
      assert.equal(cb.status, 200);

      await waitFor(async () => /zevet-e2e-google/.test(await outline()) || /Sign-in failed/.test(await outline()), { tries: 80 });
      const o = await outline();
      assert.doesNotMatch(o, /Sign-in failed/, `google sign-in failed: ${o}`);
      assert.match(o, /Acme SSO Google Co/);
      assert.match(o, /zevet-e2e-google/);
      assert.match(o, /Owner/, "the first person into a brand-new team is its owner");
      assert.doesNotMatch(o, /button#finish[^\n]*disabled/, "Open must be enabled once signed in");
      assert.match(o, /button#pick[^\n]*"Folder"/);
    } finally {
      drive("close");
    }
  });
});
