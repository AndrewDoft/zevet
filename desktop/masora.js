// Pairing zevet with Masora (T5, docs/contracts/cross_app_context.md C1/C4).
//
// Three things live here, all Masora-side rather than workspace-side:
//
//   1. `~/.zevet/masora.json` — the paired hub's URL and its device token.
//      The token is the one thing in this file worth protecting, so it is
//      never written in the clear. zevet has no keychain helper of its own
//      (grepped: no keytar, no safeStorage anywhere before this file) — so
//      this uses Electron's `safeStorage`, which is itself backed by the OS
//      keychain (DPAPI on Windows, Keychain on macOS) and needs no new
//      dependency. `encrypt`/`decrypt` are injected rather than required at
//      the top, so this module loads and is testable under plain `node --test`
//      with no Electron app running (main.js is the only caller that passes
//      the real `safeStorage`).
//
//   2. `MasoraPair` — the device-code flow against POST /api/connector/register,
//      same protocol masora2's own Go connector uses (apps/connector/internal/
//      register/register.go, read in this session): step 1 gets
//      {device_code, user_code, verify_url}; the person approves verify_url in
//      the Masora web app; step 2 polls {device_code, name, platform} until
//      200 {token} (428 means "not yet"). Constants below (5s interval, 15min
//      deadline) match the Go connector's own flag defaults exactly, not a
//      guess at what "reasonable" is.
//
//   3. `briefFor()` and `mcpServerEntry()` — C2/C4: the "Context from Masora"
//      fetch at agent start, and the http MCP server entry mcpConfigFor() adds
//      when paired. Both fail open: a brief that cannot be fetched in 2s is no
//      brief, never a blocked agent start.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CONFIG_PATH = path.join(HOME, "masora.json");

const DEFAULT_URL = "https://usemasora.com";

/** Matches apps/connector/main.go's own `-poll-interval`/`-poll-deadline` defaults. */
const POLL_INTERVAL_MS = 5000;
const POLL_DEADLINE_MS = 15 * 60 * 1000;

const BRIEF_TIMEOUT_MS = 2000;

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRaw(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows uses ACLs; the token in this file is encrypted either way.
  }
}

/**
 * The config a renderer may see: url, whether a token is stored, and the
 * per-directory repo opt-in map. Never the token itself, encrypted or not —
 * same rule `zevet:config` already follows for the hub secret.
 */
function readConfig() {
  const raw = readRaw();
  return {
    url: typeof raw.url === "string" && raw.url ? raw.url : DEFAULT_URL,
    paired: typeof raw.tokenEnc === "string" && raw.tokenEnc.length > 0,
    repos: raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos) ? raw.repos : {},
  };
}

function saveUrl(url) {
  const raw = readRaw();
  writeRaw({ ...raw, url: String(url || "").trim() || DEFAULT_URL });
  return readConfig();
}

/** `encrypt`/`decrypt` are `Buffer -> Buffer` / `Buffer -> string`, i.e.
 *  `electron.safeStorage.encryptString`/`decryptString` bound by the caller. */
function saveToken(token, encrypt) {
  const raw = readRaw();
  writeRaw({ ...raw, tokenEnc: encrypt(String(token)).toString("base64") });
}

function loadToken(decrypt) {
  const raw = readRaw();
  if (typeof raw.tokenEnc !== "string" || !raw.tokenEnc) return null;
  try {
    return decrypt(Buffer.from(raw.tokenEnc, "base64"));
  } catch {
    // Encrypted on a different machine/user, or safeStorage is unavailable
    // (Linux with no keyring). Treated as "not paired" -- there is nothing
    // safe to fall back to for a bearer token.
    return null;
  }
}

function unpair() {
  const raw = readRaw();
  delete raw.tokenEnc;
  writeRaw(raw);
}

/** `dir` is the resolved workspace path used elsewhere in main.js (`knownRoot`). */
function reposFor() {
  return readRaw().repos || {};
}

function setRepoOpted(dir, on) {
  const raw = readRaw();
  const repos = { ...(raw.repos || {}) };
  const key = path.resolve(dir);
  if (on) repos[key] = true;
  else delete repos[key];
  writeRaw({ ...raw, repos });
  return repos;
}

class MasoraPairError extends Error {}

/**
 * The device-code flow, same two-call shape as GithubSignIn (github-signin.js)
 * for the same reason: `start()` paints a code immediately, `wait()` then sits
 * for up to fifteen minutes. `fetchImpl`/`sleep`/`now` are injectable so the
 * poll loop is testable without real seconds or a real network.
 */
class MasoraPair {
  constructor({ baseUrl, fetchImpl, sleep, now = () => Date.now() } = {}) {
    if (!baseUrl) throw new MasoraPairError("Enter a Masora URL.");
    this.base = String(baseUrl).replace(/\/+$/, "");
    this.fetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
    this.sleep = typeof sleep === "function" ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
    this.now = now;
    this.cancelled = false;
    this.deviceCode = null;
  }

  async #post(body) {
    let res;
    try {
      res = await this.fetch(`${this.base}/api/connector/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new MasoraPairError(`Could not reach Masora: ${err && err.message ? err.message : String(err)}`);
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      // A 428 with no body is expected and handled by the caller on status
      // alone; anything else with no JSON body is the error path below.
    }
    return { status: res.status, body: parsed };
  }

  async start() {
    const { status, body } = await this.#post({});
    if (status !== 200 || !body || !body.device_code || !body.user_code) {
      throw new MasoraPairError("Masora did not return a pairing code.");
    }
    this.deviceCode = body.device_code;
    this.deadline = this.now() + POLL_DEADLINE_MS;
    return { userCode: body.user_code, verifyUrl: String(body.verify_url || `${this.base}/settings#pair-device`) };
  }

  cancel() {
    this.cancelled = true;
  }

  /** Resolves `{ token }` once approved. Rejects with a MasoraPairError. */
  async wait(name, platform) {
    if (!this.deviceCode) throw new MasoraPairError("Start pairing first.");
    while (!this.cancelled) {
      await this.sleep(POLL_INTERVAL_MS);
      if (this.cancelled) break;
      if (this.now() > this.deadline) {
        throw new MasoraPairError("Pairing expired. Try again for a new code.");
      }
      const { status, body } = await this.#post({ device_code: this.deviceCode, name, platform });
      if (status === 428) continue; // authorization_pending
      if (status === 200 && body && body.token) return { token: body.token };
      throw new MasoraPairError(
        (body && (body.detail || body.error)) || `Masora returned HTTP ${status}.`,
      );
    }
    throw new MasoraPairError("cancelled");
  }
}

/**
 * C2/C4: the deterministic, no-LLM brief. Fails open on any error or on the
 * 2s timeout the contract specifies -- a brief that cannot be fetched is no
 * brief, never a blocked agent start.
 */
async function briefFor({ baseUrl, token, prompt, repository, fetchImpl, timeoutMs } = {}) {
  if (!baseUrl || !token) return null;
  const f = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
  // A ref'd timer, not AbortSignal.timeout(): that one is unref'd by design,
  // so a pending brief kept nothing alive and Node 22's test runner drained
  // the loop and cancelled the test (and every test queued after it) before
  // the deadline fired. A pending brief should hold the process open anyway.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), typeof timeoutMs === "number" ? timeoutMs : BRIEF_TIMEOUT_MS);
  try {
    const res = await f(`${String(baseUrl).replace(/\/+$/, "")}/api/v2/context/brief`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        prompt: String(prompt || "").slice(0, 8000),
        surface: "zevet",
        ...(repository ? { repository } : {}),
      }),
      // Injectable, same as fetchImpl/sleep/now elsewhere in this file: a
      // real 2000ms wall-clock wait here raced the test runner's own
      // per-file process teardown under CI's constrained cores (~260
      // concurrent suites on a 2-core runner), cancelling this test and
      // everything queued after it before the real timer ever fired --
      // reproduced on both CI OSes, never locally. The production path is
      // unaffected: no caller passes timeoutMs, so it still defaults to
      // BRIEF_TIMEOUT_MS.
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.brief !== "string" || !body.brief.trim()) return null;
    return body;
  } catch {
    return null; // timeout, network error, bad JSON -- all the same: no brief.
  } finally {
    clearTimeout(timer);
  }
}

/** Its own budget, separate from the 8000-char cap on the user's standing
 *  instructions (settings.tsx PermissionSection / agentSettingsFor). */
const BRIEF_SYSTEM_PROMPT_MAX = 4000;

function withBrief(systemPrompt, brief) {
  if (!brief) return systemPrompt;
  const trimmed = brief.length > BRIEF_SYSTEM_PROMPT_MAX
    ? `${brief.slice(0, BRIEF_SYSTEM_PROMPT_MAX)}\n… [truncated]`
    : brief;
  const block = `# Context from Masora (cited)\n\n${trimmed}`;
  return systemPrompt ? `${systemPrompt}\n\n${block}` : block;
}

function mcpServerEntry(baseUrl) {
  return { masora: { type: "http", url: `${String(baseUrl).replace(/\/+$/, "")}/mcp` } };
}

module.exports = {
  DEFAULT_URL,
  CONFIG_PATH,
  readConfig,
  saveUrl,
  saveToken,
  loadToken,
  unpair,
  reposFor,
  setRepoOpted,
  MasoraPair,
  MasoraPairError,
  briefFor,
  withBrief,
  BRIEF_SYSTEM_PROMPT_MAX,
  mcpServerEntry,
};
