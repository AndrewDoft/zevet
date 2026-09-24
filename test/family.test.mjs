// Family auto-connect and the panel's states, against a fake Masora on a real
// local port and fixture files in a temp family dir.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const { Family, familyDir, cmpVersion, frameable } = createRequire(import.meta.url)(`${ROOT}/desktop/family.js`);

let srv, web;
const fake = { runtime: "masora-desktop", pair: { status: 200, body: { token: "tok-1", member_email: "a@b.co" } }, pairs: [] };
before(async () => {
  srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      if (req.url === "/healthz") return res.end(JSON.stringify({ ok: true, runtime: fake.runtime }));
      if (req.url === "/api/family/pair") {
        fake.pairs.push(JSON.parse(b));
        res.statusCode = fake.pair.status;
        return res.end(JSON.stringify(fake.pair.body));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  web = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const feeds = {
  "https://usemasora.com/download/masora-context-latest.json": { version: "0.3.3", platforms: { [`${process.platform}-${process.arch}`]: { file: "m-setup.exe" } } },
  "https://usemasora.com/download/zevet-voice-updates-canary.json": { target_version: "0.1.26", update: { manifest: { bundle: { file: "v.zip" } } } },
};

function rig(over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-family-"));
  const s = { paired: false, member: "", token: null, url: "", opened: [], updates: 0 };
  const f = new Family({
    dir,
    readMasora: () => ({ url: s.url, paired: s.paired, member: s.member }),
    saveUrl: (u) => (s.url = u),
    saveToken: (t, m) => Object.assign(s, { paired: true, token: t, member: m }),
    clearToken: () => Object.assign(s, { paired: false, token: null, member: "" }),
    openExternal: async (u) => void s.opened.push(u),
    runUpdate: async () => void s.updates++,
    fetchImpl: (u, o) => (feeds[u] ? Promise.resolve({ ok: true, json: async () => feeds[u] }) : fetch(u, o)),
    detect: async () => null,
    version: "0.2.63",
    installPath: "C:/zevet",
    host: "box",
    platform: process.platform,
    ...over,
  });
  const masora = (extra = {}) =>
    writeFileSync(path.join(dir, "masora.json"), JSON.stringify({ web, api: web, runtime: "masora-desktop", version: "0.3.3", updated_at: new Date().toISOString(), ...extra }));
  const key = (k = "s3cret") => writeFileSync(path.join(dir, "family.key"), k);
  return { dir, s, f, masora, key };
}

describe("family dir", () => {
  test("MASORA_FAMILY_DIR wins; else per-OS", () => {
    assert.equal(familyDir({ MASORA_FAMILY_DIR: "/x" }, "win32", "/h"), "/x");
    assert.match(familyDir({ LOCALAPPDATA: "C:\\L" }, "win32", "/h"), /Masora[\\/]family$/);
    assert.match(familyDir({}, "darwin", "/Users/u"), /Library[\\/]Application Support[\\/]Masora[\\/]family$/);
  });
  test("versions compare numerically", () => {
    assert.equal(cmpVersion("0.1.9", "0.1.26"), -1);
    assert.equal(cmpVersion("0.2.63", "0.2.63"), 0);
  });
});

describe("auto-connect", () => {
  test("healthy Masora + key: pairs with app/secret/device_name/platform and stores the token", async () => {
    const r = rig();
    r.masora();
    r.key();
    fake.pairs.length = 0;
    assert.equal(await r.f.connect(), "connected");
    assert.deepEqual(fake.pairs[0], { app: "zevet", secret: "s3cret", device_name: "box", platform: process.platform });
    assert.equal(r.s.token, "tok-1");
    assert.equal(r.s.member, "a@b.co");
    assert.equal(r.s.url, web);
  });

  test("not a masora-desktop runtime: no pairing attempted", async () => {
    const r = rig();
    r.masora();
    r.key();
    fake.runtime = "something-else";
    fake.pairs.length = 0;
    assert.equal(await r.f.connect(), "unreachable");
    assert.equal(fake.pairs.length, 0);
    fake.runtime = "masora-desktop";
  });

  test("no masora.json or no key: waits, does not throw", async () => {
    const r = rig();
    assert.equal(await r.f.connect(), "unreachable");
    r.masora();
    assert.equal(await r.f.connect(), "unreachable");
  });

  test("409 no_owner retries later; 403 re-reads the key next time", async () => {
    const r = rig();
    r.masora();
    r.key("old");
    fake.pair = { status: 409, body: { error: "no_owner" } };
    assert.equal(await r.f.connect(), "no_owner");
    assert.equal(r.s.paired, false);
    fake.pair = { status: 403, body: {} };
    assert.equal(await r.f.connect(), "error");
    r.key("new");
    fake.pair = { status: 200, body: { token: "t2", member_email: "" } };
    fake.pairs.length = 0;
    assert.equal(await r.f.connect(), "connected");
    assert.equal(fake.pairs[0].secret, "new");
  });

  test("a 401 later re-pairs: the old token is dropped and a new one stored", async () => {
    const r = rig();
    r.masora();
    r.key();
    fake.pair = { status: 200, body: { token: "first", member_email: "a@b.co" } };
    await r.f.connect();
    fake.pair = { status: 200, body: { token: "second", member_email: "a@b.co" } };
    assert.equal(await r.f.repair(), "connected");
    assert.equal(r.s.token, "second");
  });
});

describe("heartbeat and requests", () => {
  test("zevet.json carries the contract fields; stop() writes running:false", () => {
    const r = rig();
    r.s.paired = true;
    r.s.member = "a@b.co";
    r.f.heartbeat();
    const hb = JSON.parse(readFileSync(path.join(r.dir, "zevet.json"), "utf8"));
    assert.equal(hb.app, "zevet");
    assert.equal(hb.version, "0.2.63");
    assert.equal(hb.pid, process.pid);
    assert.equal(hb.install_path, "C:/zevet");
    assert.equal(hb.running, true);
    assert.deepEqual(hb.masora, { connected: true, member_email: "a@b.co" });
    assert.ok(Date.parse(hb.updated_at));
    r.f.stop();
    assert.equal(JSON.parse(readFileSync(path.join(r.dir, "zevet.json"), "utf8")).running, false);
  });

  test("request files: update runs the updater, connect pairs now; all are deleted", async () => {
    const r = rig();
    r.masora();
    r.key();
    fake.pair = { status: 200, body: { token: "t", member_email: "" } };
    const req = path.join(r.dir, "zevet.request.json");
    writeFileSync(req, JSON.stringify({ action: "update" }));
    await r.f.pollRequest();
    assert.equal(r.s.updates, 1);
    assert.equal(existsSync(req), false);
    writeFileSync(req, JSON.stringify({ action: "connect" }));
    await r.f.pollRequest();
    assert.equal(r.s.paired, true);
    assert.equal(existsSync(req), false);
    writeFileSync(req, JSON.stringify({ action: "format-disk" }));
    await r.f.pollRequest();
    assert.equal(r.s.updates, 1);
    assert.equal(existsSync(req), false);
  });
});

describe("panel states", () => {
  const beat = (r, app, o = {}) =>
    writeFileSync(
      path.join(r.dir, `${app}.json`),
      JSON.stringify({ app, version: "0.1.26", pid: 1, updated_at: new Date().toISOString(), running: true, masora: { connected: true, member_email: "v@b.co" }, ...o }),
    );
  const chip = async (r, app) => (await r.f.status()).find((x) => x.app === app);

  test("Install when nothing is found", async () => {
    const r = rig();
    const row = await chip(r, "voice");
    assert.equal(row.state, "Install");
    assert.equal(row.download, "https://usemasora.com/download/v.zip");
    assert.equal(row.page, "https://usemasora.com/voice");
  });

  test("OS detection counts as installed", async () => {
    const r = rig({ detect: async () => ({ version: "0.1.1" }) });
    assert.equal((await chip(r, "voice")).state, "Update");
  });

  test("Update when older than the feed; Connect when current but not connected; Connected otherwise", async () => {
    const r = rig();
    beat(r, "voice", { version: "0.1.9" });
    assert.equal((await chip(r, "voice")).state, "Update");
    beat(r, "voice", { masora: { connected: false, member_email: null } });
    assert.equal((await chip(r, "voice")).state, "Connect");
    beat(r, "voice");
    const row = await chip(r, "voice");
    assert.equal(row.state, "Connected");
    assert.equal(row.member, "v@b.co");
  });

  test("Masora is Connected iff THIS app holds a token", async () => {
    const r = rig();
    beat(r, "masora", { version: "0.3.3" });
    assert.equal((await chip(r, "masora")).state, "Connect");
    r.s.paired = true;
    assert.equal((await chip(r, "masora")).state, "Connected");
  });

  test("a feed that fails leaves the local state", async () => {
    const r = rig({
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    beat(r, "voice", { version: "0.0.1" });
    assert.equal((await chip(r, "voice")).state, "Connected");
  });

  test("Update on a running app writes its request file; on a stopped one hands back the download", async () => {
    const r = rig();
    beat(r, "voice", { version: "0.1.9" });
    const out = await r.f.act("voice", "update");
    assert.equal(out.requested, true);
    const req = JSON.parse(readFileSync(path.join(r.dir, "voice.request.json"), "utf8"));
    assert.equal(req.action, "update");
    assert.equal(req.requested_by, "zevet");
    beat(r, "voice", { version: "0.1.9", running: false });
    assert.equal((await r.f.act("voice", "update")).download, "https://usemasora.com/download/v.zip");
  });

  test("Connect Masora with no owner opens Masora; Connect Voice writes a request", async () => {
    const r = rig();
    r.masora();
    r.key();
    fake.pair = { status: 409, body: {} };
    const out = await r.f.act("masora", "connect");
    assert.equal(out.pairing, "no_owner");
    assert.deepEqual(r.s.opened, [web]);
    await r.f.act("voice", "connect");
    assert.equal(JSON.parse(readFileSync(path.join(r.dir, "voice.request.json"), "utf8")).action, "connect");
  });
});

describe("framing usemasora.com pages", () => {
  test("drops X-Frame-Options and frame-ancestors, keeps everything else", () => {
    const out = frameable({
      "X-Frame-Options": ["DENY"],
      "Content-Security-Policy": ["default-src 'self'; frame-ancestors 'none'; form-action 'self'"],
      "Content-Type": ["text/html"],
    });
    assert.equal(out["X-Frame-Options"], undefined);
    assert.equal(out["Content-Security-Policy"][0], "default-src 'self'; form-action 'self'");
    assert.deepEqual(out["Content-Type"], ["text/html"]);
  });
});
