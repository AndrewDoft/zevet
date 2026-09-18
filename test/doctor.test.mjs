// The doctor, under the conditions it exists for.
//
// doctor.mjs is the thing a teammate runs when something is already wrong, and
// it makes two promises of its own (see the header of client/doctor.mjs):
//
//   1. EXIT 0, always — a broken install must not also produce a broken run.
//   2. NO SECRETS ON SCREEN — this output gets pasted into a group chat.
//
// Both are promises about the worst case, so almost everything here is a
// deliberately broken install: no config, unparseable config, a hub that is not
// a URL, a hub that is not listening, a hub that is listening and says 401.
// Each one is a real child process reading a real ZEVET_HOME, because a doctor
// that only behaves when imported is not evidence about the one people run.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { startHub, runScript, tempDir, TOKEN } from "./helpers.mjs";

/**
 * A token that is obvious in a haystack.
 *
 * Unusual enough that a substring of it cannot collide with a path, a hostname
 * or an error message, so `stdout.includes(...)` failing is a real leak rather
 * than a coincidence.
 */
const SECRET = "zzsecret-token-qqxv-8f3a1c7e9b2d";

/**
 * Every ZEVET_* name blanked, so the developer's own shell cannot decide the
 * result. Empty is used rather than deleting the key because doctor.mjs reads
 * these for truthiness, and "" is the same falsy as absent on both platforms.
 */
const CLEAN = { ZEVET_HUB: "", ZEVET_TOKEN: "", ZEVET_ACTOR: "", ZEVET_TIMEOUT_MS: "" };

/** Somewhere nothing is listening, so "unreachable" is the finding under test. */
const DEAD_HUB = "http://127.0.0.1:1";

let hub;
before(async () => {
  hub = await startHub();
});
after(async () => {
  await hub?.stop();
});

/** One doctor run against a throwaway ZEVET_HOME, optionally seeded with config.json. */
async function doctor({ config, env = {} } = {}) {
  const home = tempDir("zevet-doctor-home-");
  try {
    if (config !== undefined) {
      writeFileSync(
        path.join(home.dir, "config.json"),
        typeof config === "string" ? config : JSON.stringify(config),
        "utf8",
      );
    }
    return await runScript("doctor.mjs", { env: { ...CLEAN, ZEVET_HOME: home.dir, ...env } });
  } finally {
    home.cleanup();
  }
}

const CHECK = /^ {2}\[(ok|--)\] (\S+) +(\S.*)$/;
const lines = (stdout) => stdout.split(/\r?\n/);
const checkLines = (stdout) => lines(stdout).filter((l) => CHECK.test(l));

/** The `N ok, M not ok` line — the script's own count of how many checks it ran. */
function summary(stdout) {
  const m = /^ {2}(\d+) ok, (\d+) not ok$/m.exec(stdout);
  assert.ok(m, `no summary line in:\n${stdout}`);
  return { passed: Number(m[1]), failed: Number(m[2]) };
}

/**
 * The three promises, asserted on every single run below.
 *
 * Checking these once on a happy path would miss the cases that matter: the
 * leak risk and the crash risk both live in the failure branches.
 */
function assertContract(r, label) {
  assert.equal(r.code, 0, `${label}: must exit 0, got ${r.code}. stderr:\n${r.stderr}`);

  // One line per check: the script's own tally must equal the lines it printed.
  // A check that printed twice, printed nothing, or spilled onto a second line
  // shows up here as a mismatch — including the 30s-timeout and crash nets,
  // which print a `[--] doctor` line that no tally accounts for.
  const checks = checkLines(r.stdout);
  const { passed, failed } = summary(r.stdout);
  assert.equal(
    checks.length,
    passed + failed,
    `${label}: ${checks.length} check lines but the summary counts ${passed + failed}:\n${r.stdout}`,
  );
  assert.ok(passed + failed >= 5, `${label}: expected at least the five fixed checks, got:\n${r.stdout}`);

  // Every check line is one label and one finding, and no label reports twice.
  const seen = new Set();
  for (const line of checks) {
    const [, , name] = CHECK.exec(line);
    assert.ok(!seen.has(name), `${label}: ${name} reported more than once:\n${r.stdout}`);
    seen.add(name);
  }
  for (const name of ["config", "settings", "hub", "token", "client"]) {
    assert.ok(seen.has(name), `${label}: no ${name} check in:\n${r.stdout}`);
  }

  // Nothing is printed that is not the banner, a check, or the trailer — so a
  // check cannot smuggle extra output past the line-per-check count above.
  for (const line of lines(r.stdout)) {
    if (line === "" || line === "zevet doctor" || CHECK.test(line)) continue;
    assert.match(
      line,
      /^ {2}(?:\d+ ok, \d+ not ok|zevet will watch: .+|zevet has nothing to watch here.*|this does not check whether a repo is wired.*)$/,
      `${label}: unexpected line ${JSON.stringify(line)} in:\n${r.stdout}`,
    );
  }

  // Rule 2, on stderr as well: a token leaked to the other stream is still a
  // token on the screen of whoever ran this.
  for (const secret of [SECRET, TOKEN]) {
    for (const [what, piece] of [
      ["the token", secret],
      ["a prefix of the token", secret.slice(0, 6)],
      ["a suffix of the token", secret.slice(-6)],
    ]) {
      assert.ok(!r.stdout.includes(piece), `${label}: printed ${what} on stdout:\n${r.stdout}`);
      assert.ok(!r.stderr.includes(piece), `${label}: printed ${what} on stderr:\n${r.stderr}`);
    }
  }
}

/**
 * The installs a doctor actually gets run on. Every one of them is diagnosed,
 * never merely survived — assertContract is applied to each.
 */
const INSTALLS = {
  "no config at all": { env: { ZEVET_HUB: DEAD_HUB, ZEVET_TIMEOUT_MS: "300" } },
  "config that will not parse": {
    config: "{not json at all",
    env: { ZEVET_HUB: DEAD_HUB, ZEVET_TIMEOUT_MS: "300" },
  },
  "config that is valid JSON but not an object": {
    config: '"just a string"',
    env: { ZEVET_HUB: DEAD_HUB, ZEVET_TIMEOUT_MS: "300" },
  },
  "config with no hub and no token": { config: {}, env: { ZEVET_TIMEOUT_MS: "300" } },
  "config with a hub but no token": {
    config: { hub: DEAD_HUB },
    env: { ZEVET_TIMEOUT_MS: "300" },
  },
  "a hub that is not a usable URL": {
    config: { hub: "not-a-url-at-all", token: SECRET },
    env: { ZEVET_TIMEOUT_MS: "300" },
  },
  "a hub that is not listening": {
    config: { hub: DEAD_HUB, token: SECRET },
    env: { ZEVET_TIMEOUT_MS: "300" },
  },
  "a config with a BOM, as PowerShell 5.1 writes it": {
    config: `﻿${JSON.stringify({ hub: DEAD_HUB, token: SECRET })}`,
    env: { ZEVET_TIMEOUT_MS: "300" },
  },
  "settings that come from the environment, not the file": {
    env: { ZEVET_HUB: DEAD_HUB, ZEVET_TOKEN: SECRET, ZEVET_ACTOR: "tester", ZEVET_TIMEOUT_MS: "300" },
  },
};

describe("a broken install still gets a diagnosis", () => {
  for (const [label, opts] of Object.entries(INSTALLS)) {
    test(label, async () => {
      assertContract(await doctor(opts), label);
    });
  }
});

describe("against a hub that is really running", () => {
  test("a good token is reported accepted", async () => {
    const r = await doctor({ config: { hub: hub.base, token: TOKEN, actor: "tester" } });
    assertContract(r, "good token");
    assert.match(r.stdout, /\[ok\] hub {10}\S+ answered/);
    assert.match(r.stdout, /\[ok\] token {8}accepted by the hub/);
  });

  test("a wrong token is reported rejected, and is not printed", async () => {
    const r = await doctor({ config: { hub: hub.base, token: SECRET, actor: "tester" } });
    assertContract(r, "wrong token");
    assert.match(r.stdout, /\[ok\] hub/, "the hub is up; that is a separate finding from the token");
    assert.match(r.stdout, /\[--\] token {8}rejected \(401\)/);
  });

  test("something that answers but is not a hub is told apart from a dead one", async () => {
    // /nope/healthz is a 404 from a live server: reachable, but not a hub.
    const r = await doctor({ config: { hub: `${hub.base}/nope`, token: TOKEN } });
    assertContract(r, "not a hub");
    assert.match(r.stdout, /\[--\] hub {10}.*404 on \/healthz/);
    assert.match(r.stdout, /\[--\] token {8}not checked/);
  });
});

describe("rule 2: the token never reaches the screen", () => {
  test("a token in the hub URL's query string is stripped", async () => {
    // The documented way to open the board is `?token=...`, so this is a URL
    // people really do paste into config.json.
    const r = await doctor({
      config: { hub: `http://127.0.0.1:1/?token=${SECRET}`, token: SECRET },
      env: { ZEVET_TIMEOUT_MS: "300" },
    });
    assertContract(r, "token in query string");
    assert.ok(!r.stdout.includes("token="), `query string survived:\n${r.stdout}`);
  });

  test("credentials in the hub URL are stripped", async () => {
    const r = await doctor({
      config: { hub: `http://someone:${SECRET}@127.0.0.1:1`, token: SECRET },
      env: { ZEVET_TIMEOUT_MS: "300" },
    });
    assertContract(r, "credentials in URL");
    assert.ok(!r.stdout.includes("someone"), `userinfo survived:\n${r.stdout}`);
  });

  test("the environment-variable hint names ZEVET_TOKEN without printing it", async () => {
    // No config file, but the vars are set in this shell: doctor says which
    // names are set, because that is the finding, and never what they hold.
    const r = await doctor({
      env: { ZEVET_HUB: DEAD_HUB, ZEVET_TOKEN: SECRET, ZEVET_TIMEOUT_MS: "300" },
    });
    assertContract(r, "env hint");
    assert.match(r.stdout, /ZEVET_TOKEN/, "the name is useful and safe");
    assert.match(r.stdout, /token set/, "set or MISSING, never the value");
  });

  test("the token's length is not disclosed either", async () => {
    // Two tokens of very different lengths must produce byte-identical token
    // reporting: a printed length narrows a brute force just as a prefix does.
    const short = await doctor({ config: { hub: DEAD_HUB, token: "x" }, env: { ZEVET_TIMEOUT_MS: "300" } });
    const long = await doctor({
      config: { hub: DEAD_HUB, token: `${SECRET}${SECRET}${SECRET}` },
      env: { ZEVET_TIMEOUT_MS: "300" },
    });
    assertContract(short, "short token");
    assertContract(long, "long token");
    const settingsLine = (r) => lines(r.stdout).find((l) => /\[(?:ok|--)\] settings/.test(l));
    assert.equal(settingsLine(short), settingsLine(long), "the settings line must not vary with token length");
  });
});
