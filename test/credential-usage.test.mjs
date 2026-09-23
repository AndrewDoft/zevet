// Plan utilization probing + its 60s cache (desktop/credential-usage.js).
// fetchImpl and now are both injected — no real request to api.anthropic.com
// and no real minute passes.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const usage = require(path.join(ROOT, "desktop", "credential-usage.js"));

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  fn.calls = calls;
  return fn;
}

function headerRes({ ok = true, h5, h7 } = {}) {
  return {
    ok,
    headers: {
      get: (name) => {
        if (name === "anthropic-ratelimit-unified-5h-utilization") return h5 === undefined ? null : String(h5);
        if (name === "anthropic-ratelimit-unified-7d-utilization") return h7 === undefined ? null : String(h7);
        return null;
      },
    },
  };
}

beforeEach(() => usage._clearCache());

describe("utilizationFor", () => {
  test("a subscription_token credential reports max(5h, 7d)", async () => {
    const fetchImpl = fakeFetch(() => headerRes({ h5: 0.3, h7: 0.6 }));
    const v = await usage.utilizationFor("e1", { provider: "anthropic", kind: "subscription_token", key: "sk-ant-oat01-x" }, { fetchImpl, now: () => 0 });
    assert.equal(v, 0.6);
  });

  test("an api_key credential is 0 on a successful probe", async () => {
    const fetchImpl = fakeFetch(() => headerRes({ ok: true }));
    const v = await usage.utilizationFor("k1", { provider: "anthropic", kind: "api_key", key: "sk-ant-api03-x" }, { fetchImpl, now: () => 0 });
    assert.equal(v, 0);
  });

  test("an api_key credential is undefined when the probe fails, not treated as empty", async () => {
    const fetchImpl = fakeFetch(() => headerRes({ ok: false }));
    const v = await usage.utilizationFor("k2", { provider: "anthropic", kind: "api_key", key: "sk-ant-api03-bad" }, { fetchImpl, now: () => 0 });
    assert.equal(v, undefined);
  });

  test("a non-anthropic provider is undefined without ever fetching", async () => {
    const fetchImpl = fakeFetch(() => headerRes());
    const v = await usage.utilizationFor("o1", { provider: "openai", kind: "api_key", key: "sk-openai-x" }, { fetchImpl, now: () => 0 });
    assert.equal(v, undefined);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("a network failure is undefined, not a throw", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const v = await usage.utilizationFor("e2", { provider: "anthropic", kind: "subscription_token", key: "sk-ant-oat01-x" }, { fetchImpl, now: () => 0 });
    assert.equal(v, undefined);
  });

  test("a reading is cached for 60s -- a second call inside the window does not re-fetch", async () => {
    const fetchImpl = fakeFetch(() => headerRes({ h5: 0.2, h7: 0.1 }));
    let t = 1000;
    const now = () => t;
    const cred = { provider: "anthropic", kind: "subscription_token", key: "sk-ant-oat01-x" };
    const first = await usage.utilizationFor("e3", cred, { fetchImpl, now });
    t += 59_000;
    const second = await usage.utilizationFor("e3", cred, { fetchImpl, now });
    assert.equal(first, 0.2);
    assert.equal(second, 0.2);
    assert.equal(fetchImpl.calls.length, 1, "cached, not re-probed");
  });

  test("the cache expires after 60s and re-probes", async () => {
    let call = 0;
    const fetchImpl = fakeFetch(() => headerRes({ h5: call++ === 0 ? 0.2 : 0.9, h7: 0 }));
    let t = 1000;
    const now = () => t;
    const cred = { provider: "anthropic", kind: "subscription_token", key: "sk-ant-oat01-x" };
    const first = await usage.utilizationFor("e4", cred, { fetchImpl, now });
    t += 61_000;
    const second = await usage.utilizationFor("e4", cred, { fetchImpl, now });
    assert.equal(first, 0.2);
    assert.equal(second, 0.9);
    assert.equal(fetchImpl.calls.length, 2);
  });
});
