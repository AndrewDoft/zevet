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
const path = require("node:path");
const { zevetHome, atomicWriteJson } = require("./zevet-home.js");
const { cloudOrigin } = require("./hub-target.js");

const HOME = zevetHome();
const CONFIG_PATH = path.join(HOME, "masora.json");

// Masora is the cloud app. ZEVET_MASORA_URL overrides; else the family descriptor's `cloud` (https only), else the
// cloud origin. Read per call: Masora may write the descriptor later.
function defaultUrl() {
  if (process.env.ZEVET_MASORA_URL) return process.env.ZEVET_MASORA_URL;
  try {
    const kit = require("@masora/desktop-kit");
    const cloud = (kit.readJson(path.join(kit.familyDir(), "masora.json")) || {}).cloud;
    if (typeof cloud === "string" && /^https:\/\/[^\s/]+/i.test(cloud.trim())) return cloud.trim().replace(/\/+$/, "");
  } catch {
    // no kit, no descriptor: the cloud
  }
  return cloudOrigin();
}

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
  atomicWriteJson(CONFIG_PATH, cfg);
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
  // `canonical` (added alongside the pair response's `token`) is the real
  // identity of the paired owner and, when Masora sends one, replaces the
  // older `member` (member_email) for display. An older Masora that has not
  // shipped `canonical` yet never sends it, so this falls back to `member`
  // unchanged -- that's what keeps pairing against one of those working.
  const canonical = raw.canonical && typeof raw.canonical === "object" && !Array.isArray(raw.canonical) ? raw.canonical : null;
  const canonicalName = canonical && typeof canonical.name === "string" && canonical.name ? canonical.name : "";
  const canonicalEmail = canonical && typeof canonical.email === "string" && canonical.email ? canonical.email : "";
  const legacyMember = typeof raw.member === "string" ? raw.member : "";
  return {
    url: typeof raw.url === "string" && raw.url ? raw.url : defaultUrl(),
    paired: typeof raw.tokenEnc === "string" && raw.tokenEnc.length > 0,
    repos: raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos) ? raw.repos : {},
    // Zevet Chat push (C1 `zevet_chat`). Off unless the person turned it on:
    // the per-repo opt-in above says nothing about chats, which have no repo.
    chat: raw.chat === true,
    // Claim and run Masora's queued agent runs here (masora-runs.js). Off until the person turns it on.
    runs: raw.runs === true,
    member: canonicalName || canonicalEmail || legacyMember,
    // The true account email of the stored credential (heartbeat `masora.account_email`).
    account_email: canonicalEmail || (legacyMember.includes("@") ? legacyMember : ""),
  };
}

function setChatPush(on) {
  writeRaw({ ...readRaw(), chat: on === true });
  return readConfig();
}

function setRunsPoll(on) {
  writeRaw({ ...readRaw(), runs: on === true });
  return readConfig();
}

function saveUrl(url) {
  const raw = readRaw();
  writeRaw({ ...raw, url: String(url || "").trim() || defaultUrl() });
  return readConfig();
}

/** `encrypt`/`decrypt` are `Buffer -> Buffer` / `Buffer -> string`, i.e.
 *  `electron.safeStorage.encryptString`/`decryptString` bound by the caller.
 *  `canonical`, when the pair response carried one, is `{name, email}` and
 *  takes over the display in `readConfig()`'s `member` -- see there. */
function saveToken(token, encrypt, member, canonical) {
  const raw = readRaw();
  writeRaw({
    ...raw,
    tokenEnc: encrypt(String(token)).toString("base64"),
    member: member || "",
    canonical: canonical && typeof canonical === "object" && !Array.isArray(canonical) ? canonical : null,
  });
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
  delete raw.member;
  delete raw.canonical;
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
 * The one POST to Masora (briefFor, the agent-run client). https only, except loopback; no redirects (a Bearer
 * token must not follow one); its own ref'd timer, not AbortSignal.timeout: that one's internal timer is unref'd
 * by design, so it never fires in an otherwise-idle process -- reproduced on Node 22 (what CI runs) with
 * `node --test` on this file alone (a still-pending promise reported as cancelled, every run, at 2000ms and
 * 50ms alike). Node 24 does not show it, which is why it was invisible locally. The timer also covers the body
 * read. Resolves {status, ok, body} (body = parsed JSON or null); rejects on network error, timeout, bad base.
 */
async function postJson(base, route, token, body, timeoutMs, fetchImpl) {
  const root = String(base || "").replace(/\/+$/, "");
  let u;
  try {
    u = new URL(root);
  } catch {
    throw new Error("the Masora address is not a URL");
  }
  const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127\./.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("the Masora address must be https");
  const f = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), typeof timeoutMs === "number" ? timeoutMs : BRIEF_TIMEOUT_MS);
  try {
    const res = await f(`${root}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    const parsed = res.status !== 204 && typeof res.json === "function" ? await res.json().catch(() => null) : null;
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * C2/C4: the deterministic, no-LLM brief. Fails open on any error or on the
 * 2s timeout the contract specifies -- a brief that cannot be fetched is no
 * brief, never a blocked agent start.
 */
async function briefFor({ baseUrl, token, prompt, repository, fetchImpl, timeoutMs } = {}) {
  if (!baseUrl || !token) return null;
  try {
    const res = await postJson(baseUrl, "/api/v2/context/brief", token, {
      prompt: String(prompt || "").slice(0, 8000),
      surface: "zevet",
      ...(repository ? { repository } : {}),
    }, timeoutMs, fetchImpl);
    const body = res.body;
    if (!res.ok || !body || typeof body.brief !== "string" || !body.brief.trim()) return null;
    return body;
  } catch {
    return null; // timeout, network error, bad JSON -- all the same: no brief.
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
  defaultUrl,
  CONFIG_PATH,
  readConfig,
  saveUrl,
  saveToken,
  loadToken,
  unpair,
  reposFor,
  setRepoOpted,
  setChatPush,
  setRunsPoll,
  MasoraPair,
  MasoraPairError,
  postJson,
  briefFor,
  withBrief,
  BRIEF_SYSTEM_PROMPT_MAX,
  mcpServerEntry,
};
