// The Masora link runs in the background and reports; it never blocks or throws.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const { MasoraLink } = createRequire(import.meta.url)(`${ROOT}/desktop/masora-link.js`);

const tick = () => new Promise((r) => setTimeout(r, 15));
async function until(pred, n = 100) {
  for (let i = 0; i < n && !pred(); i++) await tick();
  assert.ok(pred(), "condition never held");
}

/** A Masora that is up or down, and approves when `approved.on` is set. */
function world({ up = true } = {}) {
  const w = { up, approved: { on: false }, saved: [], opened: [], pairs: 0 };
  w.cfg = { url: "http://m", paired: false };
  w.fetchImpl = async () => {
    if (!w.up) throw new Error("ECONNREFUSED");
    return { ok: true };
  };
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
    retryMs: 20,
  });
  return w;
}

describe("MasoraLink", () => {
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
