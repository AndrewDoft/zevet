// The Masora link runs in the background and reports; it never blocks or throws.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const { MasoraLink } = createRequire(import.meta.url)(`${ROOT}/desktop/masora-link.js`);

const tick = () => new Promise((r) => setTimeout(r, 15));
async function until(pred, n = 100) {
  for (let i = 0; i < n && !pred(); i++) await tick();
  assert.ok(pred(), "condition never held");
}

/** A Masora that is up or down, and approves when `approved.on` is set. */
function world({ up = true, url = "http://m", fetchImpl, retryMs = 20 } = {}) {
  const w = { up, approved: { on: false }, saved: [], opened: [], pairs: 0 };
  w.cfg = { url, paired: false };
  w.fetchImpl = fetchImpl || (async () => {
    if (!w.up) throw new Error("ECONNREFUSED");
    return { ok: true };
  });
  w.MasoraPair = class {
    constructor() {
      this.cancelled = false;
    }
    async start() {
      w.pairs++;
      return { userCode: "AAAA-1111", verifyUrl: "http://m/settings#pair-device" };
    }
    cancel() {
      this.cancelled = true;
    }
    async wait() {
      while (!this.cancelled) {
        if (w.approved.on) return { token: "tok" };
        await tick();
      }
      throw new Error("cancelled");
    }
  };
  w.link = new MasoraLink({
    readConfig: () => w.cfg,
    MasoraPair: w.MasoraPair,
    saveToken: (t) => {
      if (w.keychainDown) throw new Error("keychain unavailable");
      w.saved.push(t);
      w.cfg = { ...w.cfg, paired: true };
    },
    openExternal: async (u) => void w.opened.push(u),
    host: "h",
    platform: "win32",
    fetchImpl: w.fetchImpl,
    retryMs,
  });
  return w;
}

async function healthOrigin(t, apiStatus, legacyStatus) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(req.url === "/api/health" ? apiStatus : req.url === "/healthz" ? legacyStatus : 404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}

describe("MasoraLink", () => {
  test("cloud API reachability starts pairing even when the desktop-only page route is unavailable", async (t) => {
    const origin = await healthOrigin(t, 200, 404);
    const w = world({ url: origin.url, fetchImpl: fetch, retryMs: 60_000 });
    t.after(() => w.link.cancel());
    w.link.start();
    await until(() => w.link.status().phase === "waiting");
    assert.deepEqual(origin.hits, ["/api/health"]);
    assert.equal(w.pairs, 1);
    assert.deepEqual(w.opened, [], "checking reachability must not approve or open a browser");
  });

  test("older local runtimes can still pair through their legacy health route", async (t) => {
    const origin = await healthOrigin(t, 404, 200);
    const w = world({ url: origin.url, fetchImpl: fetch, retryMs: 60_000 });
    t.after(() => w.link.cancel());
    w.link.start();
    await until(() => w.link.status().phase === "waiting");
    assert.deepEqual(origin.hits, ["/api/health", "/healthz"]);
    assert.equal(w.pairs, 1);
  });

  test("an unhealthy API is not mistaken for a reachable pairing service by the page health route", async (t) => {
    const origin = await healthOrigin(t, 503, 200);
    const w = world({ url: origin.url, fetchImpl: fetch, retryMs: 60_000 });
    t.after(() => w.link.cancel());
    w.link.start();
    await until(() => w.link.status().phase === "unreachable");
    assert.deepEqual(origin.hits, ["/api/health"]);
    assert.equal(w.pairs, 0);
  });

  test("start() returns at once, before Masora has answered", () => {
    const w = world();
    const r = w.link.start();
    assert.equal(r, undefined);
    assert.equal(w.link.status().phase, "idle");
    w.link.cancel();
  });

  test("Masora not running: reports it, then links when it comes up", async () => {
    const w = world({ up: false });
    w.link.start();
    await until(() => w.link.status().phase === "unreachable");
    w.up = true;
    await until(() => w.link.status().phase === "waiting");
    assert.equal(w.link.status().code, "AAAA-1111");
    w.approved.on = true;
    await until(() => w.link.status().phase === "linked");
    assert.deepEqual(w.saved, ["tok"]);
    assert.equal(w.link.status().paired, true);
  });

  test("the browser opens only on approve(), and only while waiting", async () => {
    const w = world();
    assert.equal(w.link.approve(), false);
    w.link.start();
    await until(() => w.link.status().phase === "waiting");
    assert.deepEqual(w.opened, [], "waiting must not open a browser by itself");
    assert.equal(w.link.approve(), true);
    assert.deepEqual(w.opened, ["http://m/settings#pair-device"]);
    w.link.cancel();
  });

  test("cancel() then start() runs a fresh attempt", async () => {
    const w = world();
    w.link.start();
    await until(() => w.link.status().phase === "waiting");
    w.link.cancel();
    assert.equal(w.link.status().phase, "idle");
    w.link.start();
    await until(() => w.pairs === 2 && w.link.status().phase === "waiting");
    w.link.cancel();
  });

  test("an unusable keychain is an error status, not a retry loop", async () => {
    const w = world();
    w.keychainDown = true;
    w.link.start();
    await until(() => w.link.status().phase === "waiting");
    w.approved.on = true;
    await until(() => w.link.status().phase === "error");
    assert.match(w.link.status().error, /keychain/);
    await tick();
    assert.equal(w.pairs, 1);
  });

  test("already linked: nothing is asked of Masora", async () => {
    const w = world();
    w.cfg.paired = true;
    w.link.start();
    await until(() => w.link.status().phase === "linked");
    assert.equal(w.pairs, 0);
  });
});
