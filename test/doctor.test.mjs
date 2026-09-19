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
//
// A third promise is asserted everywhere too, because it is what makes the
// output readable at all: ONE LINE PER CHECK. That is not eyeballed — the
// script prints its own tally, so the line count and the tally have to agree,
// which catches a check that printed twice, printed nothing, wrapped onto a
// second line, or died partway through the list.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { startHub, runScript, tempDir, TOKEN } from "./helpers.mjs";
import { deriveAuthToken } from "../client/secret.mjs";

/**
 * A token that is obvious in a haystack.
 *
 * Unusual enough that a substring of it cannot collide with a path, a hostname
 * or an error message, so `stdout.includes(...)` failing is a real leak rather
 * than a coincidence.
 */
const SECRET = "zzsecret-token-qqxv-8f3a1c7e9b2d";

/**
 * A MASTER secret, which is a different thing from the token above and is a
 * worse leak: it is also the document key (client/secret.mjs). It has to be
 * real hex of the real width or resolveAuth refuses it, so it is spelled out of
 * distinctive hex words instead — "beefca" appearing in this output is a leak
 * and not a coincidence with a port number or a temp path.
 */
const MASTER = "beefcafe0d15ea5e8badf00dfeedfacedead10ccabad1dea";
const DERIVED = deriveAuthToken(MASTER);

/**
 * Every ZEVET_* name blanked, so the developer's own shell cannot decide the
 * result. Empty rather than deleted because doctor.mjs reads these for
 * truthiness, and "" is the same falsy as absent on both platforms.
 *
 * ZEVET_SECRET is on this list for a sharper reason than the others: resolveAuth
 * lets a secret in the environment WIN over everything in the config file, so
 * one exported in the shell running this suite would replace the credential
 * every case below is built around — on one machine and nowhere else.
 */
const CLEAN = { ZEVET_HUB: "", ZEVET_TOKEN: "", ZEVET_SECRET: "", ZEVET_ACTOR: "", ZEVET_TIMEOUT_MS: "" };

/**
 * Somewhere nothing is listening, so "unreachable" is the finding under test.
 *
 * The port is ALLOCATED and released rather than hardcoded, so the refusal is a
 * real ECONNREFUSED off the loopback stack. This was `127.0.0.1:1`, and port 1
 * is on the WHATWG bad-port list: fetch() refuses it before opening a socket,
 * so the reachability check this case is named for never ran. MEASURED -- the
 * cause was `Error: bad port`, code undefined. See BAD_PORT below, which now
 * covers that condition deliberately instead of by accident.
 *
 * (A port can in principle be taken between release and use; ephemeral ports
 * are not handed straight back out, and a taken one would fail loudly here
 * rather than quietly pass.)
 */
const DEAD = `http://127.0.0.1:${await closedPort()}`;

/** Bind a port, learn its number, release it. */
async function closedPort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Escape a string for literal use inside a RegExp. */
const esc = (str) => str.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

/** A port fetch() will not dial at all -- someone will type one eventually. */
const BAD_PORT = "http://127.0.0.1:1";

/** Long enough that the network checks fail fast, short enough to be certain. */
const QUICK = "300";

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

/** `  [ok] label        detail` — the only shape a check is allowed to have. */
const CHECK = /^ {2}\[(ok|--)\] (\S+) +(\S.*)$/;
const lines = (stdout) => stdout.split(/\r?\n/);
const checkLines = (stdout) => lines(stdout).filter((l) => CHECK.test(l));
const lineFor = (stdout, label) =>
  lines(stdout).find((l) => CHECK.test(l) && CHECK.exec(l)[2] === label);

/** The `N ok, M not ok` line — the script's own count of how many checks it ran. */
function summary(stdout) {
  const m = /^ {2}(\d+) ok, (\d+) not ok$/m.exec(stdout);
  assert.ok(m, `no summary line — the doctor did not finish its list:\n${stdout}`);
  return { passed: Number(m[1]), failed: Number(m[2]) };
}

/**
 * The three promises, asserted on every single run below.
 *
 * Checking these once on a happy path would miss the cases that matter: the
 * crash risk and the leak risk both live in the failure branches.
 */
function assertContract(r, label) {
  // Promise 1. The findings are the output; the exit code is not a verdict.
  assert.equal(r.code, 0, `${label}: must exit 0, got ${r.code}. stderr:\n${r.stderr}`);

  // Promise 3. The tally and the lines must agree. The 30s-timeout net and the
  // crash net both print a `[--] doctor` line that no tally accounts for, so a
  // doctor that died partway through fails here rather than passing quietly.
  const checks = checkLines(r.stdout);
  const { passed, failed } = summary(r.stdout);
  assert.equal(
    checks.length,
    passed + failed,
    `${label}: ${checks.length} check lines but the summary counts ${passed + failed}:\n${r.stdout}`,
  );
  assert.ok(passed + failed >= 5, `${label}: expected at least the five fixed checks:\n${r.stdout}`);

  // One line per check means one line per LABEL, too: a second opinion about
  // the same thing is how a diagnosis stops being readable.
  const seen = new Set();
  for (const line of checks) {
    const name = CHECK.exec(line)[2];
    assert.ok(!seen.has(name), `${label}: ${name} reported more than once:\n${r.stdout}`);
    seen.add(name);
  }
  for (const name of ["config", "settings", "credential", "hub", "token", "client"]) {
    assert.ok(seen.has(name), `${label}: no ${name} check in:\n${r.stdout}`);
  }

  // Nothing is printed that is not the banner, a check, or the trailer — so a
  // check cannot smuggle extra output past the count above.
  for (const line of lines(r.stdout)) {
    if (line === "" || line === "zevet doctor" || CHECK.test(line)) continue;
    assert.match(
      line,
      /^ {2}(?:\d+ ok, \d+ not ok|zevet will watch: .+|zevet has nothing to watch here.*|this does not check whether a repo is wired.*)$/,
      `${label}: unexpected line ${JSON.stringify(line)} in:\n${r.stdout}`,
    );
  }

  // Promise 2, on stderr as well: a token on the other stream is still a token
  // on the screen of whoever ran this. A prefix and a suffix are checked
  // separately because both narrow a brute force even when the whole string
  // never appears — which is exactly what a truncated "helpful" hint does.
  // MASTER and DERIVED are in this list for the reason redact() grew a second
  // parameter: a file that redacted only the hub token would have kept the
  // lesser secret off the screen and printed the greater one.
  for (const secret of [SECRET, TOKEN, MASTER, DERIVED]) {
    for (const [what, piece] of [
      ["the token", secret],
      ["the first six characters of the token", secret.slice(0, 6)],
      ["the last six characters of the token", secret.slice(-6)],
    ]) {
      assert.ok(!r.stdout.includes(piece), `${label}: printed ${what} on stdout:\n${r.stdout}`);
      assert.ok(!r.stderr.includes(piece), `${label}: printed ${what} on stderr:\n${r.stderr}`);
    }
  }
}

/**
 * The installs a doctor actually gets run on.
 *
 * Every one is diagnosed rather than merely survived: the contract above plus,
 * where the finding is deterministic, the finding itself. A doctor that exits 0
 * while saying nothing useful would satisfy rule 1 and be worthless.
 */
const INSTALLS = {
  "no config at all": {
    env: { ZEVET_HUB: DEAD, ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[--\] config {7}not found at .*config\.json/],
  },
  "config that will not parse": {
    config: "{not json at all",
    env: { ZEVET_HUB: DEAD, ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[--\] config {7}.*will not parse \(.+\) — fix or delete it/],
  },
  "config that is valid JSON but not an object": {
    config: '"just a string"',
    env: { ZEVET_HUB: DEAD, ZEVET_TIMEOUT_MS: QUICK },
    expect: [/will not parse \(not a JSON object\)/],
  },
  "config with no hub and no token": {
    config: {},
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [/parses, but has no hub and no token/, /\[--\] token {8}no token configured/],
  },
  "config with a hub but no token": {
    config: { hub: DEAD },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [/parses, but has no token/, /\[--\] settings {5}.*token MISSING/],
  },
  "a hub that is not a usable URL": {
    config: { hub: "not-a-url-at-all", token: SECRET },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[--\] hub {10}the configured hub is not a usable URL/, /\[--\] token {8}not checked/],
  },
  "a hub that is not listening": {
    config: { hub: DEAD, token: SECRET },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    // The errno, not "fetch failed": reachability is the whole finding here.
    expect: [/\[--\] hub {10}\S+ unreachable \(ECONNREFUSED\)/, /\[--\] token {8}not checked/],
  },
  "a hub on a port that cannot be dialled at all": {
    config: { hub: BAD_PORT, token: SECRET },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    // Not ECONNREFUSED -- nothing was refused, because nothing was attempted.
    // What must not appear is the bare "fetch failed" this used to print.
    expect: [/\[--\] hub {10}\S+ unreachable \(bad port\)/],
  },
  "a config with a BOM, as PowerShell 5.1 writes it": {
    config: `﻿${JSON.stringify({ hub: DEAD, token: SECRET })}`,
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[ok\] config {7}.*parses$/m],
  },
  "settings that come from the environment, not the file": {
    env: { ZEVET_HUB: DEAD, ZEVET_TOKEN: SECRET, ZEVET_ACTOR: "tester", ZEVET_TIMEOUT_MS: QUICK },
    // Built from DEAD rather than retyped: the port is allocated at startup.
    expect: [new RegExp(`\\[ok\\] settings {5}hub ${esc(DEAD)}, actor tester, token set`)],
  },

  // ---- the four credential states --------------------------------------
  //
  // These are the reason the `credential` check exists at all. Three of the
  // four are indistinguishable from every other line of this output: `settings`
  // says "token set" for a modern config and a legacy one alike, and a
  // malformed secret produces no token, which reads exactly like having
  // configured nothing. A teammate on a legacy install is told the board works
  // and is not told the editor will never appear.
  "(a) a modern config, with a master secret": {
    config: { hub: DEAD, secret: MASTER, actor: "tester" },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [
      /\[ok\] credential {3}master secret configured; the hub is sent a derived token, never the secret/,
      /\[ok\] settings {5}.*token set/,
    ],
  },
  "(b) a legacy config, with only a raw token": {
    config: { hub: DEAD, token: SECRET, actor: "tester" },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [
      /\[--\] credential {3}LEGACY: a raw token, no master secret/,
      // The two things a person on a legacy install has to be told, in words,
      // not implied by the absence of something.
      /editor is unavailable/,
      /Re-running setup\.ps1 \/ setup\.sh fixes both/,
    ],
  },
  "(c) a malformed master secret": {
    config: { hub: DEAD, secret: "not hex at all", actor: "tester" },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [
      /\[--\] credential {3}the master secret is UNUSABLE \(.+\)/,
      /the board will stay empty/,
      // No credential is derived, and nothing falls back. The `token` check has
      // to agree with that rather than reporting a token it does not have.
      /\[--\] token {8}no token configured/,
      /\[--\] settings {5}.*token MISSING/,
    ],
  },
  "(c) a master secret truncated by a bad paste": {
    // The likeliest real version of (c): valid hex, wrong length. Silently
    // deriving from it would produce a credential that is wrong in a way
    // nothing on the board could ever explain.
    config: { hub: DEAD, secret: MASTER.slice(0, 40), actor: "tester" },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[--\] credential {3}the master secret is UNUSABLE \(.*at least.*\)/],
  },
  "(c) a broken secret does not quietly fall back to a stale token": {
    // resolveAuth refuses the fallback on purpose: swapping credentials behind
    // a typo is the "empty board and nobody knows why" failure this project
    // treats as its worst. Asserted here because the config that has BOTH is
    // exactly what a half-finished cutover leaves on disk.
    config: { hub: DEAD, secret: "zzz", token: SECRET, actor: "tester" },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[--\] credential {3}the master secret is UNUSABLE/, /\[--\] token {8}no token configured/],
  },
  "(d) nothing configured at all": {
    config: { hub: DEAD, actor: "tester" },
    env: { ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[--\] credential {3}nothing configured — no secret and no token\. Run setup\.ps1 \/ setup\.sh/],
  },
  "a secret in the environment beats a token in the file": {
    // The precedence resolveAuth actually implements, asserted where somebody
    // debugging a machine will look for it.
    config: { hub: DEAD, token: SECRET, actor: "tester" },
    env: { ZEVET_SECRET: MASTER, ZEVET_TIMEOUT_MS: QUICK },
    expect: [/\[ok\] credential {3}master secret configured/],
  },
};

describe("a broken install still gets a diagnosis", () => {
  for (const [label, { expect = [], ...opts }] of Object.entries(INSTALLS)) {
    test(label, async () => {
      const r = await doctor(opts);
      assertContract(r, label);
      for (const re of expect) assert.match(r.stdout, re, `${label}: in\n${r.stdout}`);
    });
  }
});

describe("against a hub that is really running", () => {
  test("a good token is reported accepted", async () => {
    const r = await doctor({ config: { hub: hub.base, token: TOKEN, actor: "tester" } });
    assertContract(r, "good token");
    assert.match(r.stdout, /\[ok\] hub {10}\S+ answered$/m);
    assert.match(r.stdout, /\[ok\] token {8}accepted by the hub$/m);
  });

  test("a wrong token is reported rejected, and is still not printed", async () => {
    const r = await doctor({ config: { hub: hub.base, token: SECRET, actor: "tester" } });
    assertContract(r, "wrong token");
    // Reachability and authorisation stay two findings: a teammate whose token
    // is wrong needs a different person than one whose hub is down.
    assert.match(r.stdout, /\[ok\] hub {10}/);
    assert.match(r.stdout, /\[--\] token {8}rejected \(401\)/);
  });

  test("a master secret derives a token the hub actually accepts", async () => {
    // The end-to-end claim, against a hub started with the derived value —
    // which is what the cutover puts in ZEVET_TOKEN. Everything else in this
    // file checks what the doctor SAYS; this checks that what it says is true.
    const cut = await startHub({ ZEVET_TOKEN: DERIVED });
    try {
      const r = await doctor({ config: { hub: cut.base, secret: MASTER, actor: "tester" } });
      assertContract(r, "modern against a cut-over hub");
      assert.match(r.stdout, /\[ok\] credential {3}master secret configured/);
      assert.match(r.stdout, /\[ok\] token {8}accepted by the hub$/m);
    } finally {
      await cut.stop();
    }
  });

  test("a legacy install against a cut-over hub is told what to do about it", async () => {
    // THE CUTOVER FAILURE, exactly as a teammate will meet it: their install
    // was fine yesterday, the hub's env changed overnight, and a bare
    // "rejected (401)" would send them looking for a new token when what they
    // need is to re-run setup with the master secret.
    const cut = await startHub({ ZEVET_TOKEN: DERIVED });
    try {
      const r = await doctor({ config: { hub: cut.base, token: TOKEN, actor: "tester" } });
      assertContract(r, "legacy against a cut-over hub");
      assert.match(r.stdout, /\[--\] credential {3}LEGACY/);
      assert.match(r.stdout, /\[--\] token {8}rejected \(401\).*Re-run setup\.ps1 \/ setup\.sh with the master secret/);
    } finally {
      await cut.stop();
    }
  });

  test("a legacy install against a pre-cutover hub still works", async () => {
    // The other half of "the fallback buys an ordering, not a coexistence": up
    // until the hub's env changes, a legacy config is a working config, and the
    // doctor must not cry wolf about the token while it does.
    const r = await doctor({ config: { hub: hub.base, token: TOKEN, actor: "tester" } });
    assertContract(r, "legacy against a pre-cutover hub");
    assert.match(r.stdout, /\[ok\] token {8}accepted by the hub$/m);
    assert.match(r.stdout, /\[--\] credential {3}LEGACY/, "accepted today, and still the thing to fix");
  });

  test("something that answers but is not a hub is told apart from a dead one", async () => {
    // /nope/healthz is a 404 from a live server: reachable, but not a hub.
    const r = await doctor({ config: { hub: `${hub.base}/nope`, token: TOKEN } });
    assertContract(r, "not a hub");
    assert.match(r.stdout, /\[--\] hub {10}.*answered 404 on \/healthz/);
    assert.match(r.stdout, /\[--\] token {8}not checked/);
  });
});

describe("rule 2: the token never reaches the screen", () => {
  test("a token in the hub URL's query string is stripped", async () => {
    // The documented way to open the board is `?token=...`, so this is a URL
    // people really do paste into config.json.
    const r = await doctor({
      config: { hub: `${DEAD}/?token=${SECRET}`, token: SECRET },
      env: { ZEVET_TIMEOUT_MS: QUICK },
    });
    assertContract(r, "token in query string");
    assert.ok(!r.stdout.includes("token="), `the query string survived:\n${r.stdout}`);
  });

  test("credentials in the hub URL are stripped from the settings line", async () => {
    const r = await doctor({
      config: { hub: `http://someone:${SECRET}@127.0.0.1:1`, token: SECRET },
      env: { ZEVET_TIMEOUT_MS: QUICK },
    });
    assertContract(r, "credentials in URL");
    assert.match(
      lineFor(r.stdout, "settings"),
      /hub http:\/\/127\.0\.0\.1:1, /,
      "the userinfo must not survive into the reported hub URL",
    );
  });

  test("the environment-variable hint names ZEVET_TOKEN without printing it", async () => {
    // No config file, but the vars are set in this shell. Which NAMES are set
    // is the finding — an agent-spawned hook will not inherit them — and the
    // name is safe to say out loud in a way the value never is.
    const r = await doctor({ env: { ZEVET_HUB: DEAD, ZEVET_TOKEN: SECRET, ZEVET_TIMEOUT_MS: QUICK } });
    assertContract(r, "env hint");
    assert.match(r.stdout, /ZEVET_TOKEN/, "the name is useful and safe");
    assert.match(r.stdout, /token set/, "set or MISSING, never the value");
  });

  test("the token's length is not disclosed either", async () => {
    // Two tokens of very different lengths must produce a byte-identical
    // settings line: a disclosed length narrows a brute force as a prefix does.
    const short = await doctor({ config: { hub: DEAD, token: "x" }, env: { ZEVET_TIMEOUT_MS: QUICK } });
    const long = await doctor({
      config: { hub: DEAD, token: `${SECRET}${SECRET}${SECRET}` },
      env: { ZEVET_TIMEOUT_MS: QUICK },
    });
    assertContract(short, "short token");
    assertContract(long, "long token");
    assert.equal(
      lineFor(short.stdout, "settings"),
      lineFor(long.stdout, "settings"),
      "the settings line must not vary with the token it is describing",
    );
  });
});
