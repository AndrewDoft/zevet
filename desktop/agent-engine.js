// Per-launch engine choice: which of Andrew's two Claude Max accounts an
// agent spawns on. Separate concern from credential-ladder.js/
// credential-usage.js's hub-shared "team credential" ladder — this is
// specifically the local engine1/engine2 split ~/.claude/bin/engine-pick.ps1
// already implements for terminal subagents. "auto" reuses that exact policy
// (engine1 <50% -> engine2 <80% -> engine1 <99% -> engine2) by feeding the
// same two-account usage into credential-ladder.js's own ladder walk, rather
// than re-deriving the arithmetic a second time.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const credentialLadder = require("./credential-ladder.js");
const credentialUsage = require("./credential-usage.js");

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CREDENTIALS_FILE = path.join(CLAUDE_HOME, ".credentials.json");
const DPAPI_FILE = path.join(CLAUDE_HOME, "secrets", "engine2.dpapi");

// The exact ladder ~/.claude/bin/engine-pick.ps1 encodes as an if/elif chain
// (Pick $u1 $u2): each step's own usage against its own ceiling, in order.
// credential-ladder.test.mjs already proves this shape against engine-pick's
// worked cases — this module reuses it rather than re-testing the math.
const AUTO_LADDER = [
  { credentialId: "engine1", untilPct: 50 },
  { credentialId: "engine2", untilPct: 80 },
  { credentialId: "engine1", untilPct: 99 },
  { credentialId: "engine2", untilPct: 100 },
];

const CREDENTIAL_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** Every knob a caller may override, for tests -- production callers pass
 *  none of these and get the real machine. */
function withDefaults(opts) {
  return {
    platform: process.platform,
    credentialsFile: CREDENTIALS_FILE,
    dpapiFile: DPAPI_FILE,
    execFileImpl: execFile,
    probeOpts: {},
    ...opts,
  };
}

/**
 * engine1's OAuth token, read from the default login's own credentials file
 * -- read-only, never logged, never returned to a caller outside this
 * module. Undefined if not signed in or the file is unreadable/malformed.
 */
function engine1Token(opts) {
  const { credentialsFile } = withDefaults(opts);
  try {
    const tok = JSON.parse(fs.readFileSync(credentialsFile, "utf8"))?.claudeAiOauth?.accessToken;
    return typeof tok === "string" && tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

/** The 5h/7d windows of this machine's own Claude login — what its agents
 *  spend against by default. Same cache id as pickAuto, so the strip and the
 *  ladder share one probe. */
async function engine1Windows(opts) {
  const o = withDefaults(opts);
  const token = engine1Token(o);
  if (!token) return undefined;
  return credentialUsage.windowsFor("engine1", { provider: "anthropic", kind: "subscription_token", key: token }, o.probeOpts);
}

/** DPAPI is per-machine (see engine2.ps1's header), so "available" means
 *  both "this OS has DPAPI" and "this machine has done the one-time setup". */
function engine2Available(opts) {
  const { platform, dpapiFile } = withDefaults(opts);
  return platform === "win32" && fs.existsSync(dpapiFile);
}

/**
 * engine2's OAuth token, DPAPI-decrypted in-process via a hidden pwsh child
 * -- the same decrypt engine2.ps1 does by hand, just spawned instead of
 * typed, since Node has no DPAPI binding. windowsHide + no shell so nothing
 * flashes a console. The path travels through an env var, not string
 * interpolation into -Command, so a home directory with spaces or quotes in
 * it cannot break the invocation. Never logged; the token only ever lands in
 * a spawned agent's env.
 */
function engine2Token(opts) {
  const { dpapiFile, execFileImpl } = withDefaults(opts);
  if (!engine2Available(opts)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFileImpl(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$sec = Get-Content $env:ZEVET_DPAPI_FILE | ConvertTo-SecureString; [Net.NetworkCredential]::new('', $sec).Password",
      ],
      { windowsHide: true, timeout: 10_000, env: { ...process.env, ZEVET_DPAPI_FILE: dpapiFile } },
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const tok = String(stdout).trim();
        resolve(tok || undefined);
      },
    );
  });
}

/** `base` (defaulting to process.env) with every credential-selecting var
 *  stripped, so a chosen engine's env cannot be shadowed by whatever the
 *  app's own process happened to inherit. */
function envWithout(base) {
  const env = { ...(base || process.env) };
  for (const v of CREDENTIAL_ENV_VARS) delete env[v];
  return env;
}

/**
 * "auto"'s pick: engine-pick.ps1's policy, but the ladder is trimmed to
 * engine1-only steps when engine2 is not set up on this machine at all --
 * mirrors engine-pick.ps1's own short-circuit (`if (-not (Test-Path
 * engine2.dpapi)) { 'engine1'; exit }`) rather than letting the ladder's
 * "last step wins regardless" fallback land on an account that cannot work.
 */
async function pickAuto(opts) {
  const o = withDefaults(opts);
  const ladder = engine2Available(o) ? AUTO_LADDER : AUTO_LADDER.filter((s) => s.credentialId === "engine1");
  const ids = [...new Set(ladder.map((s) => s.credentialId))];
  const usageById = {};
  await Promise.all(
    ids.map(async (id) => {
      const token = id === "engine1" ? engine1Token(o) : await engine2Token(o);
      if (!token) return;
      const u = await credentialUsage.utilizationFor(id, { provider: "anthropic", kind: "subscription_token", key: token }, o.probeOpts);
      if (u !== undefined) usageById[id] = u;
    }),
  );
  return credentialLadder.choose(ladder, usageById) || "engine1";
}

/**
 * Resolve a per-launch engine request to a concrete engine and the env to
 * spawn with. `requested` is "engine1" | "engine2" | "auto" | falsy (falsy
 * and anything unrecognized behave as "engine1" -- the machine's default
 * login, i.e. exactly today's behavior when no engine is named).
 *
 * Returns `{ok: true, engine, env}` or `{ok: false, error}`. A failure is
 * only ever for an EXPLICIT engine2 request this machine cannot honor --
 * "auto" never fails, it falls back to engine1 the same way engine-pick.ps1
 * does.
 */
async function resolveEngine(requested, baseEnv, opts) {
  const o = withDefaults(opts);
  const want = requested === "engine2" || requested === "auto" ? requested : "engine1";

  if (want === "auto") {
    const chosen = await pickAuto(o);
    return resolveEngine(chosen, baseEnv, o);
  }

  if (want === "engine2") {
    if (o.platform !== "win32") {
      return { ok: false, error: "engine2 needs Windows (its token is DPAPI-encrypted); this platform cannot use it." };
    }
    const token = await engine2Token(o);
    if (!token) {
      return { ok: false, error: "engine2 is not set up on this machine (no ~/.claude/secrets/engine2.dpapi -- see engine2.ps1)." };
    }
    const env = envWithout(baseEnv);
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return { ok: true, engine: "engine2", env };
  }

  return { ok: true, engine: "engine1", env: envWithout(baseEnv) };
}

module.exports = {
  resolveEngine,
  engine1Token,
  engine1Windows,
  engine2Token,
  engine2Available,
  AUTO_LADDER,
  _internals: { pickAuto, envWithout, CREDENTIAL_ENV_VARS },
};
