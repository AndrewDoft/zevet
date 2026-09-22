// Pairing with Masora (T5, docs/contracts/cross_app_context.md C1/C2/C4):
// config persistence (with a stub in place of safeStorage), the device-flow
// state machine against masora2's actual /connector/register protocol, the
// C2 brief fetch (fail-open), and the C4 http MCP entry shape.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

// ZEVET_HOME is read once at module load, so it must be set before the
// require below -- `node --test` gives each test FILE its own process, so
// this does not leak into any other file's run.
const home = tempDir("zevet-masora-cfg-");
process.env.ZEVET_HOME = home.dir;

const require = createRequire(import.meta.url);
const masora = require(path.join(ROOT, "desktop", "masora.js"));

/** A reversible stand-in for safeStorage.encryptString/decryptString: real
 *  enough to prove the roundtrip and the "wrong key" failure path, without
 *  Electron running. */
function fakeCrypto(key = "k") {
  return {
    encrypt: (s) => Buffer.from(`${key}:${s}`, "utf8"),
    decrypt: (buf) => {
      const s = buf.toString("utf8");
      if (!s.startsWith(`${key}:`)) throw new Error("wrong key");
      return s.slice(key.length + 1);
    },
  };
}

describe("config", () => {
  test("defaults to the production URL and unpaired", () => {
    const cfg = masora.readConfig();
    assert.equal(cfg.url, masora.DEFAULT_URL);
    assert.equal(cfg.paired, false);
    assert.deepEqual(cfg.repos, {});
  });

  test("saveUrl persists and trims", () => {
    const cfg = masora.saveUrl("  https://masora.example.com/  ");
    assert.equal(cfg.url, "https://masora.example.com/");
    assert.equal(masora.readConfig().url, "https://masora.example.com/");
  });

  test("blank saveUrl falls back to the default rather than an empty string", () => {
    const cfg = masora.saveUrl("   ");
    assert.equal(cfg.url, masora.DEFAULT_URL);
  });

  test("token round-trips through the injected encrypt/decrypt and never sits in the config as plaintext", () => {
    const { encrypt, decrypt } = fakeCrypto();
    masora.saveToken("palct_super_secret_token", encrypt);
    assert.equal(masora.readConfig().paired, true);
    assert.equal(masora.loadToken(decrypt), "palct_super_secret_token");

    const raw = JSON.parse(require("node:fs").readFileSync(masora.CONFIG_PATH, "utf8"));
    assert.doesNotMatch(JSON.stringify(raw), /palct_super_secret_token/);
  });

  test("loadToken fails closed (null, not a throw) when decryption fails -- e.g. a config copied to another machine", () => {
    const { encrypt } = fakeCrypto("machine-a");
    masora.saveToken("t", encrypt);
    const { decrypt: wrongDecrypt } = fakeCrypto("machine-b");
    assert.equal(masora.loadToken(wrongDecrypt), null);
  });

  test("unpair clears the token but keeps the URL and repo opt-ins", () => {
    const { encrypt } = fakeCrypto();
    masora.saveUrl("https://keep.example.com");
    masora.saveToken("t", encrypt);
    masora.setRepoOpted("/repo/a", true);
    masora.unpair();
    const cfg = masora.readConfig();
    assert.equal(cfg.paired, false);
    assert.equal(cfg.url, "https://keep.example.com");
    assert.equal(cfg.repos[path.resolve("/repo/a")], true);
  });

  test("setRepoOpted(dir, false) removes the key rather than storing false", () => {
    masora.setRepoOpted("/repo/b", true);
    assert.equal(masora.reposFor()[path.resolve("/repo/b")], true);
    masora.setRepoOpted("/repo/b", false);
    assert.equal(path.resolve("/repo/b") in masora.reposFor(), false);
  });
});

describe("MasoraPair: the device flow against /api/connector/register", () => {
  /** A fake register endpoint scripted by call count, mirroring devices.py's
   *  own status codes (200 for step 1 and an approved step 2, 428 pending). */
  function fakeFetch(script) {
    let n = 0;
    return async (url, init) => {
      assert.match(String(url), /\/api\/connector\/register$/);
      const body = init && init.body ? JSON.parse(init.body) : {};
      const answer = script(body, n++);
      return {
        status: answer.status,
        async json() {
          return answer.body ?? {};
        },
      };
    };
  }

  test("start() returns the user code and verify URL from step 1", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: { device_code: "dc-1", user_code: "ABCD-1234", verify_url: "https://m/settings#pair-device" },
    }));
    const p = new masora.MasoraPair({ baseUrl: "https://m", fetchImpl: f });
    const r = await p.start();
    assert.equal(r.userCode, "ABCD-1234");
    assert.equal(r.verifyUrl, "https://m/settings#pair-device");
  });

  test("waits BEFORE the first poll, same as GithubSignIn and for the same reason", async () => {
    const order = [];
    const f = fakeFetch((body, n) => {
      order.push(body.device_code === undefined ? "start" : "poll");
      return n === 0
        ? { status: 200, body: { device_code: "dc", user_code: "U", verify_url: "https://m/v" } }
        : { status: 200, body: { token: "tok" } };
    });
    const sleeps = [];
    const p = new masora.MasoraPair({
      baseUrl: "https://m", fetchImpl: f,
      sleep: async (ms) => { sleeps.push(ms); order.push("sleep"); },
    });
    await p.start();
    await p.wait("mba", "darwin-arm64");
    assert.deepEqual(order, ["start", "sleep", "poll"]);
    assert.equal(sleeps[0], 5000, "matches apps/connector/main.go's own -poll-interval default");
  });

  test("428 is pending, not an error, and polling continues", async () => {
    const f = fakeFetch((body, n) => {
      if (n === 0) return { status: 200, body: { device_code: "dc", user_code: "U", verify_url: "v" } };
      return n < 4 ? { status: 428, body: {} } : { status: 200, body: { token: "tok-after-pending" } };
    });
    const p = new masora.MasoraPair({ baseUrl: "https://m", fetchImpl: f, sleep: async () => {} });
    await p.start();
    const r = await p.wait("mba", "win32-x64");
    assert.equal(r.token, "tok-after-pending");
  });

  test("a name/platform actually reaches the poll body", async () => {
    let seen = null;
    const f = fakeFetch((body, n) => {
      if (n === 0) return { status: 200, body: { device_code: "dc", user_code: "U", verify_url: "v" } };
      seen = body;
      return { status: 200, body: { token: "t" } };
    });
    const p = new masora.MasoraPair({ baseUrl: "https://m", fetchImpl: f, sleep: async () => {} });
    await p.start();
    await p.wait("mba", "darwin-arm64");
    assert.deepEqual(seen, { device_code: "dc", name: "mba", platform: "darwin-arm64" });
  });

  test("any other status is a fatal error", async () => {
    const f = fakeFetch((body, n) =>
      n === 0
        ? { status: 200, body: { device_code: "dc", user_code: "U", verify_url: "v" } }
        : { status: 404, body: { detail: "unknown_device_code" } },
    );
    const p = new masora.MasoraPair({ baseUrl: "https://m", fetchImpl: f, sleep: async () => {} });
    await p.start();
    await assert.rejects(() => p.wait("mba", "win32-x64"), /unknown_device_code/);
  });

  test("gives up at the 15-minute deadline rather than polling forever", async () => {
    let now = 0;
    const f = fakeFetch((body, n) =>
      n === 0
        ? { status: 200, body: { device_code: "dc", user_code: "U", verify_url: "v" } }
        : { status: 428, body: {} },
    );
    const p = new masora.MasoraPair({
      baseUrl: "https://m", fetchImpl: f, now: () => now,
      sleep: async () => { now += 5 * 60_000; },
    });
    await p.start();
    await assert.rejects(() => p.wait("mba", "win32-x64"), /expired/);
  });

  test("cancel() stops the poll loop", async () => {
    const f = fakeFetch((body, n) =>
      n === 0
        ? { status: 200, body: { device_code: "dc", user_code: "U", verify_url: "v" } }
        : { status: 428, body: {} },
    );
    const p = new masora.MasoraPair({ baseUrl: "https://m", fetchImpl: f, sleep: async () => p.cancel() });
    await p.start();
    await assert.rejects(() => p.wait("mba", "win32-x64"), /cancelled/);
  });
});

describe("briefFor: C2, fails open", () => {
  test("returns the parsed brief on a healthy 200", async () => {
    const f = async (url, init) => {
      assert.match(String(url), /\/api\/v2\/context\/brief$/);
      assert.equal(init.headers.authorization, "Bearer tok");
      const body = JSON.parse(init.body);
      assert.equal(body.surface, "zevet");
      assert.equal(body.prompt, "fix the pairing flow");
      return { ok: true, async json() { return { tier: "full", brief: "# Notes\n\ncited stuff" }; } };
    };
    const r = await masora.briefFor({
      baseUrl: "https://m", token: "tok", prompt: "fix the pairing flow",
      repository: "AndrewDoft/zevet", fetchImpl: f,
    });
    assert.equal(r.brief, "# Notes\n\ncited stuff");
  });

  test("an empty brief (tier: none) is treated as no brief", async () => {
    const f = async () => ({ ok: true, async json() { return { tier: "none", brief: "" }; } });
    const r = await masora.briefFor({ baseUrl: "https://m", token: "t", prompt: "x", fetchImpl: f });
    assert.equal(r, null);
  });

  test("a non-2xx response is no brief, not a thrown error", async () => {
    const f = async () => ({ ok: false, async json() { return {}; } });
    const r = await masora.briefFor({ baseUrl: "https://m", token: "t", prompt: "x", fetchImpl: f });
    assert.equal(r, null);
  });

  test("a fetch that never resolves is no brief within the 2s budget", async () => {
    // A real `fetch` aborts itself when the `signal` it was given fires; a
    // stand-in fetchImpl has to honour that explicitly to be a fair fake of
    // one, same as `sleep`/`now` are injected as real functions elsewhere in
    // this suite rather than being no-ops.
    const f = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const started = Date.now();
    const r = await masora.briefFor({ baseUrl: "https://m", token: "t", prompt: "x", fetchImpl: f });
    assert.equal(r, null);
    assert.ok(Date.now() - started < 4000, "must not wait past its own timeout");
  });

  test("no token means no call at all", async () => {
    const r = await masora.briefFor({ baseUrl: "https://m", token: "", prompt: "x", fetchImpl: () => assert.fail("must not fetch") });
    assert.equal(r, null);
  });
});

describe("withBrief: its own budget, separate from the standing-instructions cap", () => {
  test("appends under the Masora header when there is a brief", () => {
    const out = masora.withBrief("Always run tests first.", "Cited note.");
    assert.match(out, /^Always run tests first\.\n\n# Context from Masora \(cited\)\n\nCited note\.$/);
  });

  test("returns the system prompt unchanged when there is no brief", () => {
    assert.equal(masora.withBrief("Always run tests first.", null), "Always run tests first.");
    assert.equal(masora.withBrief("Always run tests first.", ""), "Always run tests first.");
  });

  test("truncates the brief itself, never the caller's system prompt", () => {
    const standing = "x".repeat(7999); // just under the 8000-char cap agent-settings already enforces
    const huge = "y".repeat(10_000);
    const out = masora.withBrief(standing, huge);
    assert.ok(out.startsWith(standing), "the standing instructions must survive intact");
    assert.ok(out.includes("[truncated]"));
    const briefPart = out.slice(standing.length);
    assert.ok(briefPart.length < huge.length, "the brief, not the standing prompt, is what shrank");
  });
});

test("mcpServerEntry: the http MCP shape, verified this session against the installed claude CLI's own `mcp add-json` output", () => {
  assert.deepEqual(masora.mcpServerEntry("https://usemasora.com"), {
    masora: { type: "http", url: "https://usemasora.com/mcp" },
  });
  assert.deepEqual(masora.mcpServerEntry("https://usemasora.com/"), {
    masora: { type: "http", url: "https://usemasora.com/mcp" },
  });
});
