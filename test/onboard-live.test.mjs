// A brand-new external user's exact first move (see BUG-2026-09-27: Tommaso,
// "the hub couldn't be reached, none of it worked"), driven against the REAL
// production hub -- not the disposable one test/helpers.mjs spins up. That is
// the point of this file: setup-window.test.mjs proves the code is internally
// consistent against a hub it controls; only a run against the real address
// baked into desktop/hub-target.js's hostedHub can catch "that address is
// stale" or "that address is not actually reachable from a normal network".
//
// Opt-in only (ZEVET_LIVE_HUB_TEST=1): it talks to production and must never
// run on a contributor's plain `npm test`. It stops short of finishing a
// GitHub sign-in -- there is no bot account that can drive GitHub's real
// consent screen headlessly, and inventing one is its own security decision,
// not this test's to make -- so the team it creates is never claimed. The
// hub's own sweepUnclaimedTeams() (hub/server.mjs) deletes any team with no
// owner after ZEVET_TEAM_EXPIRY_MS (24h by default): nothing is left behind
// on production for a human to clean up by hand.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const RUN = process.env.ZEVET_LIVE_HUB_TEST === "1";
const DRIVE = path.join(ROOT, "scripts", "drive", "drive.mjs");
const TEAM_NAME = `ci-onboard-${randomBytes(4).toString("hex")}`;

const require = createRequire(import.meta.url);
const { hostedHub } = require(path.join(ROOT, "desktop", "hub-target.js"));

function drive(...args) {
  const out = execFileSync(process.execPath, [DRIVE, ...args], { encoding: "utf8", timeout: 30000 });
  return JSON.parse(out);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, { tries = 40, everyMs = 250 } = {}) {
  let outline = "";
  for (let i = 0; i < tries; i++) {
    outline = drive("snapshot").outline;
    if (pred(outline)) return outline;
    await sleep(everyMs);
  }
  return outline;
}

describe(
  "a fresh install's first move against the real hub",
  { skip: !RUN && "set ZEVET_LIVE_HUB_TEST=1 to run this against production" },
  () => {
    before(() => {
      // No ZEVET_HUB override -- this is the one test in the suite that must
      // exercise the address the shipped app actually resolves to.
      delete process.env.ZEVET_HUB;
      drive("launch");
    });

    after(() => {
      try {
        drive("close");
      } catch {
        // best effort
      }
    });

    test("there is nothing to type a hub into", () => {
      const { outline } = drive("snapshot");
      assert.match(outline, /input#teamName/);
      assert.doesNotMatch(outline, /input#hub/);
    });

    test(`Create makes "${TEAM_NAME}" on the real hub, and GitHub sign-in starts for real`, async () => {
      drive("type", "#teamName", TEAM_NAME);
      drive("click", "#gh");
      // A real device code means /team/create AND /auth/github/start both
      // answered for real -- the exact path a first-run person is on, up to
      // the point only a human can complete (approving the code on GitHub).
      const outline = await waitFor((o) => /div#ghCode/.test(o) || /div#msg(?!.*hidden)[^\n]*"(bad|Failed)/.test(o));
      assert.match(outline, /div#ghCode/, `expected a GitHub device code; got: ${outline}`);
      // Never completed: cancelling leaves the team unclaimed, so the hub's
      // own sweep deletes it -- see the file header.
      drive("click", "#ghCancel");
    });

    test("the real hub now knows this team by name", async () => {
      const res = await fetch(`${hostedHub()}/team/resolve?name=${encodeURIComponent(TEAM_NAME)}`);
      const body = await res.json();
      assert.equal(body.exists, true);
    });
  },
);
