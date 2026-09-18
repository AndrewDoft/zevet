// zevet doctor — is this install actually going to work?
//
//   node client/doctor.mjs
//
// One line per check, `[ok]` or `[--]`, and nothing else. This exists because
// every failure mode in this client is silent by design: the hook never writes
// to stdout, never fails a turn, and exits 0 whether the hub answered or not
// (see hook.mjs, rules 1 and 2). That is the right behaviour for something
// running in front of somebody's tool call, and it means a teammate who is not
// showing up on the board has no way at all to find out why. This is that way.
//
// TWO RULES OF ITS OWN:
//
//   1. EXIT 0, always. A doctor is run by someone who already has a problem;
//      exiting non-zero hands them a second one — a red step in setup.sh, a
//      failed CI line — on top of the thing they came here to diagnose. The
//      findings are the output, not the exit code.
//   2. NO SECRETS ON SCREEN. The token is reported as set or not set and never
//      printed, not even a prefix or a length: both narrow a brute force, and
//      this output is exactly the thing someone pastes into a group chat when
//      they are stuck. The hub URL is printed with any userinfo and query
//      string removed, because the documented way to open the board is
//      `?token=...` and a URL that has been pasted into config once will be
//      pasted into it again.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { detectAgents } from "./detect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CONFIG = path.join(HOME, "config.json");
const TIMEOUT_MS = Number(process.env.ZEVET_TIMEOUT_MS || 3000);

/**
 * The files the hub ships and the updater maintains.
 *
 * Mirrors CLIENT_FILES in hub/server.mjs. Kept as a literal rather than read
 * from the manifest on purpose: a doctor that asks a possibly-broken install
 * what it should contain cannot detect the case where the answer is missing.
 */
const CLIENT_FILES = ["hook.mjs", "install.mjs", "updater.mjs", "detect.mjs", "install-codex.mjs"];

let passed = 0;
let failed = 0;

/** Print as each check finishes, not in a batch at the end: the hub check waits on a network. */
function report(pass, label, detail) {
  if (pass) passed++;
  else failed++;
  console.log(`  [${pass ? "ok" : "--"}] ${label.padEnd(12)} ${detail}`);
}

/**
 * A URL safe to put on screen: no credentials, no query string.
 *
 * Rule 2. `http://user:pass@hub` and `http://hub/?token=...` are both things
 * that end up in config.json, and both would otherwise be echoed back here.
 */
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "(not a usable URL)";
  }
}

/**
 * Anything that could carry a secret, with the secret taken out.
 *
 * FOUND BY THIS FILE'S OWN TEST, which is the best possible way to find it.
 * A hub URL may legally carry credentials (`http://user:token@host`), and when
 * it does, Node's own error text quotes the whole URL back:
 *
 *   Request cannot be constructed from a URL that includes credentials:
 *   http://someone:zzsecret-token-...@127.0.0.1:1/healthz
 *
 * A doctor exists to be pasted into a chat window when something is wrong.
 * Printing a live credential there is worse than any problem it was run to
 * diagnose. The token is also redacted wherever it appears verbatim, because
 * an error message is not the only thing that can quote it back.
 */
function redact(text, token) {
  let out = String(text == null ? "" : text);
  // userinfo in any URL, whatever the scheme.
  out = out.replace(new RegExp("([a-z][a-z0-9+.-]*://)[^/\\s@]*@", "gi"), "$1[redacted]@");
  if (token && token.length >= 8) out = out.split(token).join("[redacted]");
  return out;
}

/** "fetch failed" tells nobody anything; the cause's errno is the actual finding. */
function why(err, token) {
  if (err && err.name === "AbortError") return `no answer in ${TIMEOUT_MS}ms`;
  const code = err && err.cause && err.cause.code;
  return redact(code || (err && err.message) || "unknown error", token);
}

async function get(url, headers) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers,
      signal: ac.signal,
      // Same reasoning as hook.mjs: a custom header survives a cross-origin
      // redirect, so a hub that 302s elsewhere would collect the team's shared
      // token. The hub never redirects; refusing costs nothing.
      redirect: "error",
    });
    // Drain, never inspect. /api/state answers with the whole board.
    await res.arrayBuffer().catch(() => {});
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---- check 1: config -------------------------------------------------------

/**
 * Settings exactly as hook.mjs resolves them — file first, environment wins.
 *
 * Reading it any other way would make the doctor able to disagree with the
 * thing it is diagnosing, which is worse than not having a doctor.
 */
function checkConfig() {
  const envNames = ["ZEVET_HUB", "ZEVET_TOKEN", "ZEVET_ACTOR"].filter((n) => process.env[n]);

  let file = {};
  if (!existsSync(CONFIG)) {
    report(
      false,
      "config",
      `not found at ${CONFIG} — run setup.ps1 / setup.sh` +
        // Names only. Never a value, and ZEVET_TOKEN is one of these.
        (envNames.length
          ? `. ${envNames.join(", ")} are set in this shell, but an agent-spawned hook will not inherit them`
          : ""),
    );
  } else {
    try {
      // Strip a UTF-8 BOM, as hook.mjs does: PowerShell 5.1 writes one and
      // JSON.parse rejects it. Stripping here keeps this honest about whether
      // the real client can read the file, rather than about JSON pedantry.
      const raw = readFileSync(CONFIG, "utf8").replace(/^﻿/, "");
      file = JSON.parse(raw);
      if (!file || typeof file !== "object") throw new Error("not a JSON object");
      const missing = ["hub", "token"].filter((k) => !file[k]);
      report(
        missing.length === 0,
        "config",
        missing.length === 0
          ? `${CONFIG} parses`
          : `${CONFIG} parses, but has no ${missing.join(" and no ")}`,
      );
    } catch (err) {
      report(false, "config", `${CONFIG} will not parse (${err.message}) — fix or delete it and re-run setup`);
      file = {};
    }
  }

  let username = "";
  try {
    username = os.userInfo().username || "";
  } catch {
    // os.userInfo() throws where the OS has no passwd entry for this uid.
    username = "";
  }

  const settings = {
    hub: (process.env.ZEVET_HUB || file.hub || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    token: process.env.ZEVET_TOKEN || file.token || "",
    actor: process.env.ZEVET_ACTOR || file.actor || username || "unknown",
  };

  // What the hook will actually use, which is not always what is in the file.
  report(
    Boolean(settings.token),
    "settings",
    `hub ${safeUrl(settings.hub)}, actor ${settings.actor}, token ${settings.token ? "set" : "MISSING"}`,
  );

  return settings;
}

// ---- checks 2 and 3: hub, token --------------------------------------------

async function checkHub(settings) {
  const base = safeUrl(settings.hub);
  if (base === "(not a usable URL)") {
    report(false, "hub", "the configured hub is not a usable URL");
    return false;
  }

  // /healthz is deliberately unauthenticated, so reachability and authorisation
  // are two findings rather than one ambiguous one. "401" and "nothing is
  // listening" need different fixes from different people.
  try {
    const res = await get(`${settings.hub}/healthz`);
    if (res.ok) {
      report(true, "hub", `${base} answered`);
      return true;
    }
    report(false, "hub", `${base} answered ${res.status} on /healthz — is that really a zevet hub?`);
    return false;
  } catch (err) {
    report(false, "hub", `${redact(base, settings.token)} unreachable (${why(err, settings.token)}) — is the hub running, and is this the right address?`);
    return false;
  }
}

async function checkToken(settings, hubUp) {
  if (!settings.token) {
    report(false, "token", "no token configured — nothing to check, and the hub will refuse every event");
    return;
  }
  if (!hubUp) {
    report(false, "token", "not checked — the hub did not answer");
    return;
  }
  try {
    const res = await get(`${settings.hub}/api/state`, { "x-zevet-token": settings.token });
    if (res.ok) {
      report(true, "token", "accepted by the hub");
    } else if (res.status === 401) {
      report(false, "token", "rejected (401) — this machine's token is not the string the hub was started with");
    } else if (res.status === 429) {
      report(false, "token", "rate limited (429) — too many failed attempts from this address; wait a few minutes");
    } else {
      report(false, "token", `the hub answered ${res.status} on /api/state`);
    }
  } catch (err) {
    report(false, "token", `could not ask the hub (${why(err, settings.token)})`);
  }
}

// ---- check 4: client files -------------------------------------------------

/**
 * The install this doctor is part of — its own directory, not ZEVET_HOME.
 *
 * Someone running `node client/doctor.mjs` from a checkout is asking about that
 * checkout; someone running `~/.zevet/client/doctor.mjs` is asking about the
 * installed copy. Hard-coding ZEVET_HOME would answer the wrong question for
 * one of them, and the two can genuinely differ.
 */
function checkClientFiles() {
  const missing = [];
  const empty = [];
  for (const name of CLIENT_FILES) {
    const p = path.join(HERE, name);
    try {
      if (!existsSync(p)) missing.push(name);
      // A zero-byte file is what a half-finished update leaves behind, and it
      // imports without error, so presence alone is not enough of a check.
      else if (statSync(p).size === 0) empty.push(name);
    } catch {
      missing.push(name);
    }
  }
  const ok = missing.length === 0 && empty.length === 0;
  const trouble = [
    missing.length ? `missing ${missing.join(", ")}` : "",
    empty.length ? `empty ${empty.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  report(ok, "client", ok ? `all ${CLIENT_FILES.length} files present in ${HERE}` : `${trouble} in ${HERE}`);
}

// ---- check 5: agents -------------------------------------------------------

function checkAgents() {
  const found = detectAgents();
  for (const a of found) {
    let detail;
    if (!a.installed) detail = "not installed";
    else if (!a.wireable) detail = "installed, but zevet has no hook contract for it";
    else if (!a.signedIn) detail = `installed (${a.foundVia}), but no account file found`;
    else detail = `installed (${a.foundVia}), signed in`;
    if (a.installed && a.hooks === "unverified") detail += "; hooks install but have never been seen to fire";
    // [ok] means zevet can watch it. Installed-but-unwatchable is reported as
    // [--] because from the board's point of view it is the same as absent.
    report(Boolean(a.installed && a.wireable), a.label.toLowerCase().replace(/\s+/g, "-"), detail);
  }

  const watchable = found.filter((a) => a.installed && a.wireable);
  return watchable;
}

// ---- main ------------------------------------------------------------------

async function main() {
  console.log("zevet doctor");
  console.log("");

  const settings = checkConfig();
  const hubUp = await checkHub(settings);
  await checkToken(settings, hubUp);
  checkClientFiles();
  const watchable = checkAgents();

  console.log("");
  console.log(`  ${passed} ok, ${failed} not ok`);
  console.log(
    watchable.length
      ? `  zevet will watch: ${watchable.map((a) => a.label).join(", ")}`
      : "  zevet has nothing to watch here — install Claude Code or Codex.",
  );
  // What this deliberately does not check, said out loud rather than left to be
  // discovered: everything above can pass while no repo is wired at all.
  console.log("  this does not check whether a repo is wired — that is `node client/install.mjs <repo>`");
}

// A safety net, not the normal exit — and the same fix updater.mjs already
// carries, rediscovered here because an agent writing this file had no way to
// know that lesson. MEASURED: `process.exit(0)` in a finally() after fetch()
// races undici's socket teardown and trips a libuv assertion on Windows,
// "!(handle->flags & UV_HANDLE_CLOSING)", AFTER every check has printed. So
// the diagnosis was complete and the process still died loudly, which is
// precisely the thing a doctor must not do. Letting the loop drain is the
// correct exit; this unref'd timer only fires if something is genuinely stuck.
setTimeout(() => {
  console.log("  [--] doctor       still running after 30s — giving up");
  process.exit(0);
}, 30000).unref();

main().catch((err) => {
  // Including our own bugs: a doctor that crashes has diagnosed nothing and
  // told you less than it knew.
  console.log(`  [--] doctor       crashed before finishing: ${redact(err && err.message, process.env.ZEVET_TOKEN)}`);
  process.exitCode = 0;
});
