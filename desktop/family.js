// The Masora family: Masora, Zevet and Zevet Voice sense each other through a
// per-user directory of small files, and Zevet pairs itself with a Masora on
// this machine without a click.
//
//   <family dir>/masora.json  {web, api, runtime:"masora-desktop", version, ...}  (Masora writes)
//   <family dir>/family.key   the pairing secret                                (Masora writes)
//   <family dir>/zevet.json   heartbeat, every 60 s                             (we write)
//   <family dir>/zevet.request.json {"action":"update"|"connect"}               (others write; we delete)
//
// Nothing here throws into the caller: every failure is a state, retried on
// the next tick. The token goes to the same safeStorage store the device-code
// flow uses (masora.js), never to a renderer.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TICK_MS = 60_000;
const REQUEST_POLL_MS = 3_000;
const FEED_TTL_MS = 60 * 60 * 1000;
const STALE_MS = 3 * 60 * 1000; // a heartbeat older than this is not "running"
const DOWNLOADS = "https://usemasora.com/download/";

const APPS = {
  masora: {
    name: "Masora",
    page: "https://usemasora.com/context",
    feed: "https://usemasora.com/download/masora-context-latest.json",
    installed: "Masora Context",
  },
  voice: {
    name: "Zevet Voice",
    page: "https://usemasora.com/voice",
    feed: "https://usemasora.com/download/zevet-voice-updates-canary.json",
    installed: "Zevet Voice",
  },
};

function familyDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.MASORA_FAMILY_DIR) return env.MASORA_FAMILY_DIR;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Masora", "family");
  return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Masora", "family");
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

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

class Family {
  constructor({
    dir,
    readMasora, // () => {url, paired, member}
    saveUrl, // (url) => void
    saveToken, // (token, memberEmail) => void  (may throw)
    clearToken, // () => void
    openExternal,
    runUpdate, // async () => void : the normal self-update
    fetchImpl,
    detect = osDetect,
    version,
    installPath,
    host = os.hostname(),
    platform = process.platform,
    pid = process.pid,
    now = () => Date.now(),
    tickMs = TICK_MS,
    pollMs = REQUEST_POLL_MS,
  } = {}) {
    Object.assign(this, { dir, readMasora, saveUrl, saveToken, clearToken, openExternal, runUpdate, detect, version, installPath, host, platform, pid, now, tickMs, pollMs });
    this.fetch = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);
    this.pairing = "idle"; // idle | pairing | no_owner | unreachable | error
    this.feeds = new Map(); // app -> {at, version, file}
    this.found = new Map(); // app -> {at, version}  (OS detection cache)
    this.timers = [];
    this.busy = false;
  }

  /* ── heartbeat ─────────────────────────────────────────────────────────── */

  heartbeat(running = true) {
    const m = this.readMasora();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, "zevet.json");
      fs.writeFileSync(
        `${file}.tmp`,
        JSON.stringify({
          app: "zevet",
          version: this.version,
          pid: this.pid,
          updated_at: new Date(this.now()).toISOString(),
          install_path: this.installPath,
          running,
          masora: { connected: !!m.paired, member_email: m.member || null },
        }),
      );
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      /* an unwritable family dir must not hurt Zevet */
    }
  }

  /* ── auto-connect ──────────────────────────────────────────────────────── */

  /** One attempt. Resolves the pairing state; never throws. */
  async connect() {
    if (this.busy) return this.pairing;
    this.busy = true;
    try {
      const mj = readJson(path.join(this.dir, "masora.json"));
      const web = mj && mj.runtime === "masora-desktop" && typeof mj.web === "string" ? mj.web.replace(/\/+$/, "") : "";
      if (!web) return (this.pairing = "unreachable");
      let health = null;
      try {
        const r = await this.fetch(`${web}/healthz`, { signal: AbortSignal.timeout(3000) });
        health = r.ok ? await r.json() : null;
      } catch {
        /* down */
      }
      if (!health || health.runtime !== "masora-desktop") return (this.pairing = "unreachable");
      let secret = "";
      try {
        secret = fs.readFileSync(path.join(this.dir, "family.key"), "utf8").trim();
      } catch {
        /* Masora has not written it yet */
      }
      if (!secret) return (this.pairing = "unreachable");
      this.pairing = "pairing";
      let res;
      try {
        res = await this.fetch(`${web}/api/family/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app: "zevet", secret, device_name: this.host, platform: this.platform }),
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
        this.saveToken(body.token, typeof body.member_email === "string" ? body.member_email : "");
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

  /** A 401 from Masora: the token is dead, so drop it and pair again. */
  repair() {
    try {
      this.clearToken();
    } catch {
      /* nothing stored */
    }
    return this.connect();
  }

  /* ── requests from siblings ────────────────────────────────────────────── */

  async pollRequest() {
    const file = path.join(this.dir, "zevet.request.json");
    const req = readJson(file);
    if (!req) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return; // cannot delete it, so cannot promise to run it only once
    }
    if (req.action === "connect") await this.connect();
    else if (req.action === "update") await Promise.resolve(this.runUpdate()).catch(() => {});
  }

  start() {
    const tick = () => {
      this.heartbeat();
      if (!this.readMasora().paired) void this.connect();
    };
    tick();
    const add = (fn, ms) => {
      const t = setInterval(fn, ms);
      if (typeof t.unref === "function") t.unref();
      this.timers.push(t);
    };
    add(tick, this.tickMs);
    add(() => void this.pollRequest(), this.pollMs);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
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
    const hb = readJson(path.join(this.dir, `${app}.json`));
    let version = hb && typeof hb.version === "string" ? hb.version : null;
    let installed = !!hb;
    if (!installed) {
      let f = this.found.get(app);
      if (!f || this.now() - f.at > 5 * 60 * 1000) {
        f = { at: this.now(), hit: await this.detect(APPS[app].installed, this.platform).catch(() => null) };
        this.found.set(app, f);
      }
      if (f.hit) {
        installed = true;
        version = f.hit.version || null;
      }
    }
    const beat = hb && Date.parse(hb.updated_at);
    const running = !!(hb && hb.running !== false && beat && this.now() - beat < STALE_MS);
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
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${app}.request.json`), JSON.stringify({ ...body, requested_by: "zevet", at: new Date(this.now()).toISOString() }));
      return { requested: true };
    } catch {
      return { requested: false };
    }
  }
}

module.exports = { Family, familyDir, cmpVersion, APPS };
