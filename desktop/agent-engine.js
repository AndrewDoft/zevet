// Per-launch engine choice: which of Andrew's two Claude Max accounts an
// agent spawns on. "auto" no longer reads plan utilization: that needed the
// login's OAuth token POSTed to api.anthropic.com, which Anthropic's terms
// forbid for third-party apps (D-recorded, 2026-10-11). The only token this
// module touches is engine2's own, handed to the unmodified claude binary as
// CLAUDE_CODE_OAUTH_TOKEN (the setup-token flow).
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const DPAPI_FILE = path.join(CLAUDE_HOME, "secrets", "engine2.dpapi");

const CREDENTIAL_ENV_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** Every knob a caller may override, for tests -- production callers pass
 *  none of these and get the real machine. */
function withDefaults(opts) {
  return {
    platform: process.platform,
    dpapiFile: DPAPI_FILE,
    execFileImpl: execFile,
    ...opts,
  };
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

  // "auto" has no usage reading to rotate on, so it is the machine's default
  // login; the claude CLI reports its own limits and the router rolls on those.
  if (want === "auto") return resolveEngine("engine1", baseEnv, o);

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
  engine2Token,
  engine2Available,
  _internals: { envWithout, CREDENTIAL_ENV_VARS },
};
