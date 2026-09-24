// Private download authorization. This credential never authorizes the local
// workspace: it is scoped to one product on the fixed Masora download host.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const CLOUD_ORIGIN = "https://usemasora.com";
const REGISTER_URL = `${CLOUD_ORIGIN}/api/connector/register`;
const POLL_MS = 5000;
const DEADLINE_MS = 15 * 60 * 1000;

class UpdateAccessError extends Error {
  constructor(message, code = "update_access_failed") {
    super(message);
    this.code = code;
  }
}

function encryptionAvailable(storage, platform) {
  try {
    if (!storage || !storage.isEncryptionAvailable()) return false;
    // Electron can report encryption available while using a plaintext-equivalent
    // fallback on Linux. We never persist an update bearer with that backend.
    return platform !== "linux" || (
      typeof storage.getSelectedStorageBackend === "function" &&
      ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(storage.getSelectedStorageBackend())
    );
  } catch { return false; }
}

function validToken(token) {
  return typeof token === "string" && /^paup_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/.test(token);
}

class UpdateAccess {
  constructor({ product, file, storage, platform = process.platform, fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
    if (!["context", "zevet", "voice"].includes(product)) throw new Error("Unknown update product");
    this.product = product;
    this.file = file;
    this.storage = storage;
    this.platform = platform;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.connecting = null;
    this.checking = null;
    this.invalidated = false;
  }

  readToken() {
    if (this.invalidated || !encryptionAvailable(this.storage, this.platform)) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.version !== 1 || saved.origin !== CLOUD_ORIGIN || saved.product !== this.product ||
          typeof saved.token_enc !== "string") return null;
      const token = this.storage.decryptString(Buffer.from(saved.token_enc, "base64"));
      return validToken(token) ? token : null;
    } catch {
      // Missing, corrupt, or encrypted for another OS account means sign in
      // again. Never fall back to an unencrypted token or local workspace key.
      return null;
    }
  }

  saveToken(token, deviceId) {
    if (!encryptionAvailable(this.storage, this.platform)) {
      throw new UpdateAccessError("The OS keychain is unavailable. Updates could not be authorized.");
    }
    const tokenEnc = this.storage.encryptString(token).toString("base64");
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, origin: CLOUD_ORIGIN,
        product: this.product, device_id: deviceId, token_enc: tokenEnc }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
      this.invalidated = false;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  clear() {
    this.invalidated = true;
    try { fs.rmSync(this.file, { force: true }); } catch { /* Still fail closed in this process. */ }
  }

  async fetch(url, options = {}) {
    let target;
    try { target = new URL(url); }
    catch { throw new UpdateAccessError("Updates must come directly from Masora's download host."); }
    if (target.origin !== CLOUD_ORIGIN || target.username || target.password || target.search || target.hash ||
        !/^\/download\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.pathname)) {
      throw new UpdateAccessError("Updates must come directly from Masora's download host.");
    }
    const token = this.readToken();
    if (!token) throw new UpdateAccessError("Sign in to Masora to enable updates.", "update_access_required");
    const headers = new Headers(options.headers);
    headers.delete("cookie");
    headers.set("authorization", `Bearer ${token}`);
    let response;
    try {
      response = await this.fetchImpl(target.href, { ...options, headers, redirect: "error", credentials: "omit" });
    } catch {
      // Do not propagate network error strings: a transport implementation may
      // include request headers in them. A temporary failure retains the grant.
      throw new UpdateAccessError("Could not reach Masora's download host. Try again.");
    }
    if (response.status === 401 || response.status === 403) {
      this.clear();
      throw new UpdateAccessError("Update access is no longer valid. Sign in to Masora again.", "update_access_required");
    }
    return response;
  }

  async post(body) {
    try {
      return await this.fetchImpl(REGISTER_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), redirect: "error", credentials: "omit",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new UpdateAccessError("Could not reach Masora to authorize updates. Try again.");
    }
  }

  async json(response) {
    try { return await response.json(); }
    catch { throw new UpdateAccessError("Masora returned an invalid update authorization response."); }
  }

  connect(options) {
    // Repeated clicks share one approval; timers never call connect().
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce(options).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  manualCheck({ check, setError, approve, name }) {
    // Manual actions may offer one browser approval and retry the check once.
    // A rejected replacement grant never starts another approval automatically.
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const state = await check();
      if (!state.authRequired) return state;
      try {
        if (!await this.connect({ approve, name })) return state;
        return await check();
      } catch (error) {
        return setError(error instanceof UpdateAccessError ? error.message : "Update sign-in could not be opened. Try again.");
      }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  async connectOnce({ name, platform = this.platform, approve }) {
    if (!encryptionAvailable(this.storage, this.platform)) {
      throw new UpdateAccessError("The OS keychain is unavailable. Updates could not be authorized.");
    }
    const start = await this.post({ kind: "updates", product: this.product, name, platform });
    if (start.status !== 200) throw new UpdateAccessError("Masora could not start update authorization. Try again.");
    const code = await this.json(start);
    let approval;
    try { approval = new URL(code.verify_url); } catch { /* rejected below */ }
    if (typeof code.device_code !== "string" || !code.device_code ||
        typeof code.user_code !== "string" || !/^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(code.user_code) || !approval ||
        approval.origin !== CLOUD_ORIGIN || approval.pathname !== "/access" ||
        approval.username || approval.password || approval.hash ||
        approval.searchParams.size !== 1 || approval.searchParams.get("device_code") !== code.user_code) {
      throw new UpdateAccessError("Masora returned an invalid update approval address.");
    }
    const deadline = this.now() + DEADLINE_MS;
    if (!await approve({ userCode: code.user_code, verifyUrl: approval.href })) return false;
    while (this.now() < deadline) {
      await this.sleep(POLL_MS);
      if (this.now() >= deadline) break;
      const result = await this.post({ device_code: code.device_code });
      if (result.status === 428) continue;
      if (result.status === 403) throw new UpdateAccessError("Update authorization was denied. Try again when you have access.");
      if (result.status === 404) throw new UpdateAccessError("The update approval code expired or was already used. Try again.");
      if (result.status !== 200) throw new UpdateAccessError("Masora could not finish update authorization. Try again.");
      const grant = await this.json(result);
      if (grant.kind !== "updates" || grant.product !== this.product || !validToken(grant.token) ||
          typeof grant.device_id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(grant.device_id)) {
        throw new UpdateAccessError("Masora returned a grant for the wrong update product.");
      }
      try { this.saveToken(grant.token, grant.device_id); }
      catch { throw new UpdateAccessError("Update access could not be saved securely. Try again."); }
      return true;
    }
    throw new UpdateAccessError("Update authorization timed out. Try again for a new code.");
  }
}

module.exports = { UpdateAccess, UpdateAccessError, CLOUD_ORIGIN, encryptionAvailable };
