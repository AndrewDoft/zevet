// Local model servers: loopback only, bounded (desktop/local-models.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { detectLocalModels, TARGETS } = require(path.join(ROOT, "desktop", "local-models.js"));

const json = (body) => ({ ok: true, json: async () => body });

test("Ollama and LM Studio are found by their loopback endpoints", async () => {
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    assert.ok(init.signal, "every probe is bounded");
    return url.includes("11434") ? json({ models: [{ name: "llama3:8b" }, { name: "qwen2.5-coder" }] }) : json({ data: [{ id: "phi-4" }] });
  };
  const out = await detectLocalModels({ fetch });
  assert.deepEqual(out, [
    { provider: "ollama", state: "connected", models: ["llama3:8b", "qwen2.5-coder"] },
    { provider: "lmstudio", state: "connected", models: ["phi-4"] },
  ]);
  assert.deepEqual(urls.sort(), ["http://127.0.0.1:11434/api/tags", "http://127.0.0.1:1234/v1/models"].sort());
});

test("nothing listening, an error status, a hang past the timeout, and junk bodies all read as not_setup", async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("timeout"))));
  for (const fetch of [async () => { throw new Error("ECONNREFUSED"); }, async () => ({ ok: false }), hang, async () => json("junk"), async () => json(null)]) {
    const out = await detectLocalModels({ fetch, timeoutMs: 20 });
    assert.deepEqual(out.map((o) => o.state), ["not_setup", "not_setup"]);
  }
});

test("only two fixed 127.0.0.1 URLs exist: no other host, no scan", () => {
  assert.equal(TARGETS.length, 2);
  for (const t of TARGETS) assert.equal(new URL(t.url).hostname, "127.0.0.1");
});

test("model names are filtered and capped", async () => {
  const names = Array.from({ length: 80 }, (_, i) => ({ name: `m${i}` })).concat([{ name: 5 }, { name: "x".repeat(300) }]);
  const out = await detectLocalModels({ fetch: async (u) => (u.includes("11434") ? json({ models: names }) : { ok: false }) });
  assert.equal(out[0].models.length, 50);
});
