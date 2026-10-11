// BYOK detection (desktop/key-detect.js): what is read, what is refused, what is stored.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const kd = require(path.join(ROOT, "desktop", "key-detect.js"));

/** A throwaway home holding the given files (objects are written as JSON). */
function home(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-keys-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}
const detect = (h, env = {}) => kd.detectKeys({ home: h, env });

describe("sources", () => {
  test("env allowlist: Anthropic, OpenAI, Gemini, Google, OpenRouter -- and nothing else", () => {
    const found = detect(home(), { ANTHROPIC_API_KEY: "sk-ant-api03-x", OPENAI_API_KEY: "sk-o", GOOGLE_API_KEY: "g", OPENROUTER_API_KEY: "sk-or", AWS_SECRET_ACCESS_KEY: "nope", GITHUB_TOKEN: "nope" });
    assert.deepEqual(found.map((k) => k.provider).sort(), ["anthropic", "gemini", "openai", "openrouter"]);
  });
  test("opencode auth.json: only type api entries; an OAuth entry is ignored", () => {
    const h = home({ ".local/share/opencode/auth.json": { openrouter: { type: "api", key: "sk-or-1" }, anthropic: { type: "oauth", access: "sk-ant-oat01-zzz", refresh: "r" } } });
    assert.deepEqual(detect(h), [{ provider: "openrouter", from: "opencode" }]);
  });
  test("codex auth.json: OPENAI_API_KEY only, never the tokens block; CODEX_HOME honoured", () => {
    const h = home({ ".codex/auth.json": { tokens: { access_token: "t" } }, "elsewhere/auth.json": { OPENAI_API_KEY: "sk-c", tokens: { access_token: "t" } } });
    assert.deepEqual(detect(h), []);
    assert.deepEqual(detect(h, { CODEX_HOME: path.join(h, "elsewhere") }), [{ provider: "openai", from: "codex" }]);
  });
  test("~/.gemini/.env and ~/.env: GEMINI_API_KEY, export / quotes / comments", () => {
    assert.deepEqual(detect(home({ ".gemini/.env": '# c\nexport GEMINI_API_KEY="AIza-1"  \n' })), [{ provider: "gemini", from: "gemini-env" }]);
    assert.deepEqual(detect(home({ ".env": "OTHER=1\nGEMINI_API_KEY=AIza-2 # work\n" })), [{ provider: "gemini", from: "gemini-env" }]);
    assert.deepEqual(kd.parseDotenv("GEMINI_API_KEY='a b'\nBAD LINE\nX=1"), { GEMINI_API_KEY: "a b", X: "1" });
  });
  test("Vertex AI: no Gemini key is offered (env, or the same file)", () => {
    assert.deepEqual(detect(home({ ".gemini/.env": "GEMINI_API_KEY=AIza-1\n" }), { GOOGLE_GENAI_USE_VERTEXAI: "true" }), []);
    assert.deepEqual(detect(home({ ".env": "GOOGLE_GENAI_USE_VERTEXAI=1\nGEMINI_API_KEY=AIza-1\n" })), []);
    assert.deepEqual(detect(home({ ".env": "GOOGLE_GENAI_USE_VERTEXAI=false\nGEMINI_API_KEY=AIza-1\n" })).map((k) => k.provider), ["gemini"]);
  });
});

describe("guards", () => {
  test("a file over 256 KB is not read; a directory in its place is not either", () => {
    const big = "X=1\n".repeat(70000) + "GEMINI_API_KEY=AIza-late\n";
    assert.ok(big.length > kd.MAX_BYTES);
    assert.deepEqual(detect(home({ ".gemini/.env": big })), []);
    assert.deepEqual(detect(home({ ".gemini/.env/inner": "x" })), []);
  });
  test("an OAuth token in an API-key variable is refused, as is a malformed value", () => {
    assert.deepEqual(detect(home(), { ANTHROPIC_API_KEY: "sk-ant-oat01-abc" }), []);
    assert.deepEqual(detect(home(), { OPENAI_API_KEY: "two words" }), []);
    assert.deepEqual(detect(home(), { OPENAI_API_KEY: "x".repeat(600) }), []);
  });
  test("the result carries provider and source, never the key", () => {
    const out = JSON.stringify(detect(home(), { OPENAI_API_KEY: "sk-secret-value" }));
    assert.ok(!out.includes("sk-secret-value"));
  });
});

describe("validateKey", () => {
  const respond = (status) => async () => ({ ok: status >= 200 && status < 300, status });
  test("2xx valid; 401/403 invalid; other statuses and network errors unknown", async () => {
    assert.equal(await kd.validateKey("openai", "k", { fetch: respond(200) }), "valid");
    assert.equal(await kd.validateKey("openai", "k", { fetch: respond(401) }), "invalid");
    assert.equal(await kd.validateKey("openai", "k", { fetch: respond(403) }), "invalid");
    assert.equal(await kd.validateKey("openai", "k", { fetch: respond(503) }), "unknown");
    assert.equal(await kd.validateKey("openai", "k", { fetch: async () => { throw new Error("offline"); } }), "unknown");
    assert.equal(await kd.validateKey("nope", "k", { fetch: respond(200) }), "unknown");
  });
  test("each provider is probed with a GET on its own host and its own auth header", async () => {
    const seen = [];
    const fetch = async (url, init) => { seen.push([new URL(url).host, Object.keys(init.headers)[0], init.method]); return { ok: true, status: 200 }; };
    for (const p of ["anthropic", "openai", "gemini", "openrouter"]) await kd.validateKey(p, "k", { fetch });
    assert.deepEqual(seen, [
      ["api.anthropic.com", "x-api-key", undefined],
      ["api.openai.com", "authorization", undefined],
      ["generativelanguage.googleapis.com", "x-goog-api-key", undefined],
      ["openrouter.ai", "authorization", undefined],
    ]);
  });
});

describe("adoptKeys", () => {
  const run = (h, env, extra) => {
    const stored = [];
    return kd.adoptKeys({ home: h, env, list: () => extra.held || [], add: (k) => stored.push(k), fetch: extra.fetch, removedPath: extra.removedPath }).then((result) => ({ result, stored }));
  };
  const ok = async () => ({ ok: true, status: 200 });

  test("a valid detected key is stored; an invalid or unverifiable one is not", async () => {
    const env = { OPENAI_API_KEY: "sk-good", OPENROUTER_API_KEY: "sk-bad", GEMINI_API_KEY: "AIza-flaky" };
    const fetch = async (url) => (url.includes("openai") ? { ok: true, status: 200 } : url.includes("openrouter") ? { ok: false, status: 401 } : { ok: false, status: 502 });
    const { result, stored } = await run(home(), env, { fetch });
    assert.deepEqual(stored.map((s) => s.provider), ["openai"]);
    assert.deepEqual(Object.fromEntries(result.map((r) => [r.provider, r.state])), { openai: "stored", openrouter: "invalid", gemini: "unknown" });
  });
  test("a key already held is not validated or stored twice", async () => {
    let calls = 0;
    const { result, stored } = await run(home(), { OPENAI_API_KEY: "sk-abcd1234" }, { held: [{ provider: "openai", kind: "api_key", last4: "1234" }], fetch: async () => { calls++; return { ok: true, status: 200 }; } });
    assert.equal(calls, 0);
    assert.deepEqual(stored, []);
    assert.equal(result[0].state, "exists");
  });
  test("a key the person removed is never added back, and the file holds a fingerprint, not the key", async () => {
    const h = home();
    const removedPath = path.join(h, "removed.json");
    const env = { OPENAI_API_KEY: "sk-removed-me" };
    assert.equal(kd.forgetKeys("openai", { home: h, env, removedPath }), true);
    const { result, stored } = await run(h, env, { fetch: ok, removedPath });
    assert.deepEqual(stored, []);
    assert.equal(result[0].state, "removed");
    assert.ok(!readFileSync(removedPath, "utf8").includes("sk-removed-me"));
    const again = await run(h, { OPENAI_API_KEY: "sk-a-new-key" }, { fetch: ok, removedPath });
    assert.equal(again.stored.length, 1, "a different key is a new decision");
  });
});

test("policy: no credential file of a subscription login is opened by the detector", () => {
  const src = readFileSync(path.join(ROOT, "desktop", "key-detect.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.credentials\.json/.test(src));
  assert.ok(!/claudeAiOauth|id_token|access_token|refresh/.test(src));
});
