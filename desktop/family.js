// The Masora family: Masora, Zevet and Zevet Voice sense each other through a
// per-user directory of small files, and Zevet pairs itself with a Masora on
// this machine without a click.
//
//   <family dir>/masora.json  {web, api, runtime:"masora-desktop", version, ...}  (Masora writes)
//   <family dir>/family.key   the pairing secret                                (Masora writes)
//   <family dir>/zevet.json   heartbeat, every 60 s                             (we write)
//   <family dir>/zevet.request.json {"action":"update"|"connect"}               (others write; we delete)
//   <family dir>/zevet.credentials.json  cloud mode only (masora.json runtime "masora-cloud"): {cloud, token:"palct_…",
//                                        kind:"connector_device", member_email, issued_at}  (Masora writes; we consume + delete)
//
// Nothing here throws into the caller: every failure is a state, retried on
// the next tick. The token goes to the same safeStorage store the device-code
// flow uses (masora.js), never to a renderer.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const kit = require("@masora/desktop-kit");
const familyIndex = require("./family-index.js");

const TICK_MS = 60_000;
const REQUEST_POLL_MS = 3_000;
const FEED_TTL_MS = 60 * 60 * 1000;
const INDEX_FIRST_MS = 2 * 60 * 1000;
const INDEX_EVERY_MS = 60 * 60 * 1000;
/** One Zevet version the index names is acted on once per this long (a check that found nothing is not retried hourly). */
const INDEX_RENUDGE_MS = 6 * 60 * 60 * 1000;
const { STALE_MS, familyDir, readJson } = kit; // STALE_MS: a heartbeat older than this is not "running"
const CRED_MAX_AGE_MS = 10 * 60 * 1000;
const cloudKey = (u) => String(u || "").trim().replace(/\/+$/, "");
const DOWNLOADS = "https://usemasora.com/download/";

const APPS = {
  masora: {
    name: "Masora",
    page: "https://usemasora.com/context",
    feed: "https://usemasora.com/download/masora-context-latest.json",
    // "Masora Context" until 0.3.9; both install names are found.
    installed: ["Masora", "Masora Context"],
  },
  voice: {
    name: "Zevet Voice",
    page: "https://usemasora.com/voice",
    feed: "https://usemasora.com/download/zevet-voice-updates-canary.json",
    installed: "Zevet Voice",
  },
};

/** -1 / 0 / 1 for dotted numeric versions; unparseable parts count as 0. */
function cmpVersion(a, b) {
  const pa = String(a || "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Installed but never heard from: ask the OS. `{version}` or null. */
async function osDetect(displayName, platform = process.platform) {
  const { execFile } = require("node:child_process");
  if (platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      const out = await new Promise((resolve) =>
        execFile("reg", ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s"], { maxBuffer: 32 << 20, timeout: 20000 }, (e, so) => resolve(e ? "" : so)),
      );
      let name = "";
      let ver = "";
      for (const line of out.split(/\r?\n/)) {
        if (/^HKEY/i.test(line)) {
          if (name === displayName) return { version: ver || null };
          name = ver = "";
          continue;
        }
        const m = /^\s+(DisplayName|DisplayVersion)\s+REG_SZ\s+(.*)$/.exec(line);
        if (m) m[1] === "DisplayName" ? (name = m[2].trim()) : (ver = m[2].trim());
      }
      if (name === displayName) return { version: ver || null };
    }
    return null;
  }
  if (platform === "darwin") {
    for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
      try {
        const plist = fs.readFileSync(path.join(base, `${displayName}.app`, "Contents", "Info.plist"), "utf8");
        const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
        return { version: m ? m[1] : null };
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * usemasora.com refuses to be framed (X-Frame-Options: DENY, CSP frame-ancestors
 * 'none'). The Family card embeds its /context and /voice pages, so main.js
 * strips those two headers from exactly those sub-frame responses.
 */
const FRAME_URLS = ["https://usemasora.com/context*", "https://usemasora.com/voice*"];
function frameable(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key === "x-frame-options") continue;
    out[k] = key === "content-security-policy" ? v.map((x) => x.replace(/frame-ancestors[^;]*;?\s*/i, "")) : v;
  }
  return out;
}

class Family {
  constructor({
    dir,
    readMasora, // () => {url, paired, member}
    saveUrl, // (url) => void
    saveToken, // (token, memberEmail) => void  (may throw)
    clearToken, // () => void
    openExternal,
    runUpdate, // async () => void : the normal self-update
    // The signed family index (family-index.js): keys it may be signed with ({} = poll off) and what to do when
    // it names a newer Zevet -- main.js passes appUpdater.check(), never an install.
    indexKeys = {},
    onIndexNewer = () => {},
    fetchImpl,
    detect = osDetect,
    // D-603: this machine's Zevet TEAM name, e.g. main.js's `fetchTeamName`
    // cache -- never the hub URL behind it (Andrew's standing rule: the name
    // is the identity, the hub is never shown). async () => string, "" when
    // this machine has no team yet or the hub could not be reached; never
    // throws by contract, but a throw is still swallowed below since this is
    // a label, not something pairing may depend on.
    readTeam = async () => "",
    // D-615: joins a hub team by name+key on THIS machine's behalf, using no
    // session at all (there may be none yet) -- main.js's own zevet:teamJoin
    // handler, factored out so a relayed join and a typed one run identical
    // code. async (team, key) => {ok, error?, login?, owner?, teamName?}.
    joinTeam = async () => ({ ok: false, error: "not configured" }),
    joinHub = async () => ({ ok: false, error: "not configured" }), // (hubUrl, assertion) => {ok}: Masora's one-login hub sign-in (main.js)
    readHubAuth, // () => {hub, token} | null : this machine's OWN hub session (main.js's authFor)
    // What Zevet genuinely knows about the person, e.g. the GitHub login or
    // email their own hub sign-in used -- never guessed. () => {email?,
    // github_login?, google_email?} | null; null/empty means Zevet knows
    // nothing, and no `identity` is sent (see #identity below).
    readIdentity = () => null,
    version,
    installPath,
    allowLoopbackCloud = false, // tests only: lets a cloud of http://127.0.0.1 / localhost count as https
    host = os.hostname(),
    platform = process.platform,
    pid = process.pid,
    now = () => Date.now(),
    tickMs = TICK_MS,
    pollMs = REQUEST_POLL_MS,
  } = {}) {
    Object.assign(this, { dir, readMasora, saveUrl, saveToken, clearToken, openExternal, runUpdate, indexKeys, onIndexNewer, detect, readTeam, joinTeam, joinHub, readHubAuth, readIdentity, version, installPath, allowLoopbackCloud, host, platform, pid, now, tickMs, pollMs });
    this.fetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
    this.pairing = "idle"; // idle | pairing | no_owner | unreachable | error
    this.team = ""; // last-known team name; refreshed each tick, best-effort
    this.feeds = new Map(); // app -> {at, version, file}
    this.found = new Map(); // app -> {at, version}  (OS detection cache)
    this.roster = null; // cached {team_name, people} from /auth/whoami; see #refreshRoster
    this.timers = [];
    this.busy = false;
  }

  /** Best-effort refresh of `this.team`. Never throws: a team name is a
   *  label, and a stale or empty one must not block a heartbeat or a pair. */
  async refreshTeam() {
    try {
      this.team = String((await this.readTeam()) || "");
    } catch {
      /* keep the last-known value */
    }
    return this.team;
  }
  async detectAny(names) {
    for (const n of names) {
      const hit = await this.detect(n, this.platform).catch(() => null);
      if (hit) return hit;
    }
    return null;
  }

  /** `identity` for the pair POST: only string, non-empty fields, and never
   *  fabricated -- `readIdentity()` returning null/`{}` means Zevet knows
   *  nothing, and this returns null so the field is left off the wire
   *  entirely rather than sent as `{}` or with blank values. */
  #identity() {
    let raw;
    try {
      raw = this.readIdentity();
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const k of ["email", "github_login", "google_email"]) {
      if (typeof raw[k] === "string" && raw[k]) out[k] = raw[k];
    }
    return Object.keys(out).length ? out : null;
  }


  /* ── heartbeat ─────────────────────────────────────────────────────────── */

  heartbeat(running = true) {
    const m = this.readMasora();
    try {
      const body = {
        app: "zevet",
        version: this.version,
        pid: this.pid,
        updated_at: new Date(this.now()).toISOString(),
        install_path: this.installPath,
        running,
        // hub_email: whose hub session this machine holds, only while a whoami has resolved a team (this.roster) -- the
        // cloud shell reads it to know whether Zevet still needs its hub login from Masora's sign-in.
        masora: { connected: !!m.paired, member_email: m.member || null, account_email: (m.paired && m.account_email) || null, hub_email: (this.roster && (this.readIdentity() || {}).email) || null },
      };
      // `this.roster` is only ever set from a whoami that actually resolved a
      // team (see #refreshRoster) — never guessed, so signed-out and
      // not-yet-fetched both leave both keys off the wire entirely. This is
      // separate from `this.team` (readTeam/refreshTeam), which only labels
      // the D-603 pairing POST below, never the heartbeat.
      if (this.roster) {
        body.team_name = this.roster.team_name;
        body.people = this.roster.people;
      }
      kit.writeHeartbeat(this.dir, "zevet", body);
    } catch {
      /* an unwritable family dir must not hurt Zevet */
    }
  }

  /**
   * The hub team roster, cached for the heartbeat. `readHubAuth()` returns the
   * same `{hub, token}` the main process's own hub calls already use
   * (desktop/main.js's `authFor(readConfig())`) — Zevet's own session, never a
   * new credential. null (no session, or no team yet) clears the cache so
   * `heartbeat()` never fabricates a team. A failed or unreachable hub leaves
   * whatever roster was last cached (same "fail quiet" rule as #latest());
   * this never throws.
   */
  async #refreshRoster() {
    const auth = typeof this.readHubAuth === "function" ? this.readHubAuth() : null;
    if (!auth || !auth.hub || !auth.token) {
      this.roster = null;
      return;
    }
    try {
      const res = await this.fetch(`${auth.hub}/auth/whoami`, {
        headers: { "x-zevet-token": auth.token },
        signal: AbortSignal.timeout(8000),
      });
      const body = res.ok ? await res.json() : null;
      this.roster =
        body && body.ok && body.team
          ? { team_name: typeof body.teamName === "string" ? body.teamName : "", people: Array.isArray(body.people) ? body.people : [] }
          : null;
    } catch {
      /* hub down or unreachable: keep the roster we already had */
    }
  }

  /* ── auto-connect ──────────────────────────────────────────────────────── */

  /** One attempt. Resolves the pairing state; never throws. */
  async connect() {
    if (this.busy) return this.pairing;
    this.busy = true;
    try {
      const web = kit.masoraWeb(this.dir);
      if (!web) return (this.pairing = "unreachable");
      let health = null;
      try {
        const r = await this.fetch(`${web}/healthz`, { signal: AbortSignal.timeout(3000) });
        health = r.ok ? await r.json() : null;
      } catch {
        /* down */
      }
      if (!health || health.runtime !== "masora-desktop") return (this.pairing = "unreachable");
      const secret = kit.readKey(this.dir) || ""; // "" until Masora has written it
      if (!secret) return (this.pairing = "unreachable");
      this.pairing = "pairing";
      await this.refreshTeam();
      const identity = this.#identity();
      let res;
      try {
        res = await this.fetch(`${web}/api/family/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            app: "zevet", secret, device_name: this.host, platform: this.platform,
            ...(this.team ? { team_name: this.team } : {}),
            ...(identity ? { identity } : {}),
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        return (this.pairing = "unreachable");
      }
      if (res.status === 409) return (this.pairing = "no_owner");
      if (res.status !== 200) return (this.pairing = "error"); // 403: the next attempt re-reads the key
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* handled below */
      }
      if (!body || typeof body.token !== "string" || !body.token) return (this.pairing = "error");
      try {
        this.saveUrl(web);
        this.saveToken(
          body.token,
          typeof body.member_email === "string" ? body.member_email : "",
          // `canonical`: the real identity of the paired owner, replacing
          // `member_email` for display -- see masora.js's readConfig(). An
          // older Masora that hasn't shipped it omits the field, and null
          // here is what keeps that fallback working.
          body.canonical && typeof body.canonical === "object" ? body.canonical : null,
        );
      } catch {
        return (this.pairing = "error");
      }
      this.pairing = "idle";
      this.heartbeat();
      return "connected";
    } finally {
      this.busy = false;
    }
  }

  /**
   * Cloud mode: Masora's shell drops <dir>/zevet.credentials.json for the person it is signed in as. Stored exactly
   * as the loopback pair stores its token (saveUrl + saveToken), then the file is deleted. Never throws; the token
   * is never logged. Returns "connected" | "ignored" | "failed" | "none".
   */
  consumeCredentials() {
    const file = path.join(this.dir, "zevet.credentials.json");
    const drop = () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return "none";
    }
    const desc = readJson(path.join(this.dir, "masora.json")) || {};
    const cloud = cloudKey(desc.cloud);
    const httpsOk = /^https:\/\/[^\s/]+/i.test(cloud) || (this.allowLoopbackCloud && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(cloud));
    const upd = Date.parse(desc.updated_at);
    if (desc.runtime !== "masora-cloud" || !httpsOk || !(this.now() - upd <= STALE_MS)) return "ignored";
    let c = null;
    try {
      c = JSON.parse(raw);
    } catch {
      /* malformed: dropped below */
    }
    const age = c && typeof c === "object" ? this.now() - Date.parse(c.issued_at) : NaN;
    if (!c || typeof c !== "object" || typeof c.token !== "string" || !c.token.startsWith("palct_") || c.kind !== "connector_device" || !(age <= CRED_MAX_AGE_MS)) {
      drop();
      return "ignored";
    }
    if (cloudKey(c.cloud) !== cloud) return "ignored";
    const email = typeof c.member_email === "string" ? c.member_email : "";
    try {
      this.saveUrl(cloud);
      this.saveToken(c.token, email, email ? { email } : null);
    } catch {
      return "failed"; // file kept: retried on the next poll
    }
    drop();
    this.pairing = "idle";
    this.heartbeat();
    if (c.hub) void this.#signInHub(cloud, c.hub);
    return "connected";
  }

  /**
   * One login for everyone: the credentials file's `hub` block is Masora's signed statement that this person belongs
   * to a workspace, redeemed at the hub for a team session (main.js `joinHub`). The hub must be on the cloud's own
   * https origin, so the assertion never goes anywhere else. Fire-and-forget like every relayed action: the
   * assertion is single use, and a failure shows as a missing `hub_email`, which makes Masora issue a fresh one.
   */
  async #signInHub(cloud, hub) {
    let url = "";
    try {
      const h = new URL(hub.url);
      const same = h.origin === new URL(cloud).origin;
      if (same && (h.protocol === "https:" || this.allowLoopbackCloud) && typeof hub.assertion === "string" && hub.assertion) url = hub.url.replace(/\/+$/, "");
    } catch {
      /* malformed url: ignored below */
    }
    if (!url) return;
    try {
      const r = await this.joinHub(url, hub.assertion);
      if (!r || !r.ok) console.error(`zevet: hub sign-in from Masora failed (${(r && r.error) || "unknown"})`);
    } catch (err) {
      console.error(`zevet: hub sign-in from Masora threw (${err.message})`);
    }
    await this.#refreshRoster();
    this.heartbeat();
  }

  /** A 401 from Masora: the token is dead, so drop it and pair again. */
  repair() {
    try {
      this.clearToken();
    } catch {
      /* nothing stored */
    }
    this.heartbeat(); // connected:false now, so the shell can issue a fresh credential
    return this.connect();
  }

  /** One index pass: a newer Zevet than this one triggers the normal update check. Never throws. */
  async checkIndex() {
    const to = await familyIndex.newerZevet({ fetchImpl: this.fetch, keys: this.indexKeys, version: this.version, log: (m) => console.log(`[family] ${m}`) });
    if (!to) return null;
    if (this.indexNudged && this.indexNudged.to === to && this.now() - this.indexNudged.at < INDEX_RENUDGE_MS) return null;
    this.indexNudged = { to, at: this.now() };
    try {
      await Promise.resolve(this.onIndexNewer(to));
    } catch (err) {
      console.log(`[family] update check after the index failed: ${err.message}`);
    }
    return to;
  }

  /* ── requests from siblings ────────────────────────────────────────────── */

  async pollRequest() {
    this.consumeCredentials();
    const req = kit.takeRequest(this.dir, "zevet"); // read, then deleted: run once
    if (!req) return;
    if (req.action === "connect") await this.connect();
    else if (req.action === "update") await Promise.resolve(this.runUpdate()).catch(() => {});
    else if (req.action === "team.invite" || req.action === "team.revoke") await this.#relayTeamAction(req.action, req.login);
    else if (req.action === "team.domain") await this.#relayTeamDomain(req.value);
    else if (req.action === "team.join") await this.#relayTeamJoin(req.team, req.key);
  }

  /**
   * Masora's onboarding relays an invite it was given for a hub team --
   * {team, key} -- so a fresh machine can join with no separate Zevet setup.
   * Unlike team.invite/team.revoke this needs no existing hub session (there
   * may be none: Zevet has not joined ANY team yet), so it goes through
   * `joinTeam` (main.js), the exact function `zevet:teamJoin` already calls
   * for desktop/setup.html's own Join button -- a relayed join is
   * indistinguishable from a typed one. Fire-and-forget, same as every other
   * relayed action here: no reply channel, so a failure is only ever logged.
   */
  async #relayTeamJoin(team, key) {
    try {
      const r = await this.joinTeam(team, key);
      if (!r || !r.ok) console.error(`zevet: team.join relay failed (${(r && r.error) || "unknown"})`);
    } catch (err) {
      console.error(`zevet: team.join relay threw (${err.message})`);
    }
    await this.#refreshRoster();
    this.heartbeat();
  }

  /**
   * Masora asks for an invite or a revoke by dropping {action, login}; Zevet
   * is the only side that ever holds a hub credential or knows the hub's URL,
   * so it makes the call with its OWN session (readHubAuth, above) and neither
   * ever reaches Masora. Fire-and-forget: there is no reply channel, so a
   * failure (network down, or 403 because this session is not the team owner)
   * is only ever logged, never retried or queued.
   */
  async #relayTeamAction(action, login) {
    const auth = typeof this.readHubAuth === "function" ? this.readHubAuth() : null;
    if (auth && auth.hub && auth.token) {
      const route = action === "team.invite" ? "auth/allow" : "auth/revoke";
      try {
        const res = await this.fetch(`${auth.hub}/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zevet-token": auth.token },
          body: JSON.stringify({ login }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) console.error(`zevet: hub refused ${action} for ${login} (${res.status})`);
      } catch (err) {
        console.error(`zevet: could not reach the hub for ${action} (${err.message})`);
      }
    }
    // Whatever happened, show Masora the truth on its very next read rather
    // than waiting for the next 60s heartbeat tick.
    await this.#refreshRoster();
    this.heartbeat();
  }

  /**
   * Masora asks an owner to turn the Workspace domain door on (a domain) or
   * off ("" or absent) by dropping {action: "team.domain", value}. Same
   * shape as #relayTeamAction above and for the same reason: only Zevet
   * holds a hub credential, so it makes the call with its own session and
   * the hub itself is what actually refuses this to anyone but the owner
   * (hub/server.mjs's `/auth/domain`, and accounts.mjs's `setDomain` refuses
   * anything but the owner's own Workspace domain regardless of who asks).
   * Fire-and-forget, same as an invite or a revoke.
   */
  async #relayTeamDomain(value) {
    const auth = typeof this.readHubAuth === "function" ? this.readHubAuth() : null;
    if (auth && auth.hub && auth.token) {
      try {
        const res = await this.fetch(`${auth.hub}/auth/domain`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-zevet-token": auth.token },
          body: JSON.stringify({ domain: value || "" }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) console.error(`zevet: hub refused team.domain (${res.status})`);
      } catch (err) {
        console.error(`zevet: could not reach the hub for team.domain (${err.message})`);
      }
    }
    await this.#refreshRoster();
    this.heartbeat();
  }

  start() {
    const tick = async () => {
      await this.refreshTeam();
      this.heartbeat();
      if (!this.readMasora().paired) void this.connect();
      void this.#refreshRoster().then(() => this.heartbeat());
    };
    void tick();
    const add = (fn, ms) => {
      const t = setInterval(fn, ms);
      if (typeof t.unref === "function") t.unref();
      this.timers.push(t);
    };
    add(tick, this.tickMs);
    add(() => void this.pollRequest(), this.pollMs);
    const first = setTimeout(() => void this.checkIndex(), INDEX_FIRST_MS);
    if (typeof first.unref === "function") first.unref();
    this.timers.push(first);
    add(() => void this.checkIndex(), INDEX_EVERY_MS);
  }

  stop() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
    this.heartbeat(false);
  }

  /* ── the Family panel ──────────────────────────────────────────────────── */

  async #latest(app) {
    const hit = this.feeds.get(app);
    if (hit && this.now() - hit.at < FEED_TTL_MS) return hit;
    let out = { at: this.now(), version: null, file: null };
    try {
      const r = await this.fetch(APPS[app].feed, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        if (app === "voice") {
          const u = (j && j.update) || {};
          out = { ...out, version: j.target_version || u.version || null, file: (u.manifest && u.manifest.bundle && u.manifest.bundle.file) || null };
        } else {
          const p = (j && j.platforms && j.platforms[`${this.platform}-${process.arch}`]) || {};
          out = { ...out, version: (j && j.version) || null, file: p.file || null };
        }
      }
    } catch {
      /* fail quiet: the chip stays on its local state */
    }
    this.feeds.set(app, out);
    return out;
  }

  async #row(app) {
    const hb = kit.readHeartbeat(this.dir, app);
    let version = hb && typeof hb.version === "string" ? hb.version : null;
    let installed = !!hb;
    if (!installed) {
      let f = this.found.get(app);
      if (!f || this.now() - f.at > 5 * 60 * 1000) {
        f = { at: this.now(), hit: await this.detectAny([].concat(APPS[app].installed)) };
        this.found.set(app, f);
      }
      if (f.hit) {
        installed = true;
        version = f.hit.version || null;
      }
    }
    const running = kit.isRunning(hb, this.now(), STALE_MS);
    const feed = await this.#latest(app);
    const mine = this.readMasora();
    const connected = app === "masora" ? !!mine.paired : !!(hb && hb.masora && hb.masora.connected);
    const member = app === "masora" ? mine.member || null : (hb && hb.masora && hb.masora.member_email) || null;
    let state = "Connected";
    if (!installed) state = "Install";
    else if (version && feed.version && cmpVersion(version, feed.version) < 0) state = "Update";
    else if (!connected) state = "Connect";
    return {
      app,
      name: APPS[app].name,
      state,
      version,
      latest: feed.version,
      running,
      member,
      lastSeen: hb ? hb.updated_at || null : null,
      page: APPS[app].page,
      download: feed.file ? DOWNLOADS + feed.file : null,
      pairing: app === "masora" ? this.pairing : undefined,
    };
  }

  async status() {
    return Promise.all(["masora", "voice"].map((a) => this.#row(a)));
  }

  /** The click on a chip. Resolves what the card should show next. */
  async act(app, action) {
    if (!APPS[app]) return { ok: false };
    const row = await this.#row(app);
    if (action === "update") {
      if (!row.running) return { ok: true, download: row.download };
      return { ok: true, ...this.#request(app, { action: "update" }) };
    }
    if (action === "connect") {
      if (app === "masora") {
        const r = await this.connect();
        if (r === "no_owner") {
          const url = (readJson(path.join(this.dir, "masora.json")) || {}).web || this.readMasora().url;
          if (url) Promise.resolve(this.openExternal(url)).catch(() => {});
        }
        return { ok: true, pairing: r };
      }
      return { ok: true, ...this.#request(app, { action: "connect" }) };
    }
    if (action === "disconnect" && app === "masora") {
      this.clearToken();
      this.heartbeat();
      return { ok: true };
    }
    return { ok: false };
  }

  #request(app, body) {
    try {
      kit.writeRequest(this.dir, app, { ...body, requested_by: "zevet", at: new Date(this.now()).toISOString() });
      return { requested: true };
    } catch {
      return { requested: false };
    }
  }
}

module.exports = { Family, familyDir, cmpVersion, APPS, frameable, FRAME_URLS };
