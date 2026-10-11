// Per-launch engine choice (desktop/agent-engine.js). Every filesystem path,
// the platform, the pwsh child and the usage probe are all injected -- no
// real DPAPI file, no real pwsh process, no real request to api.anthropic.com.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const engine = require(path.join(ROOT, "desktop", "agent-engine.js"));

const dir = mkdtempSync(path.join(tmpdir(), "zevet-agent-engine-"));
const credentialsFile = path.join(dir, ".credentials.json");
const dpapiFile = path.join(dir, "engine2.dpapi");
const missingDpapiFile = path.join(dir, "no-such-file.dpapi");

function writeCreds(token) {
  writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
}

function fakeExecFile(stdout, err) {
  const calls = [];
  const fn = (file, args, options, cb) => {
    calls.push({ file, args, options });
    cb(err || null, stdout || "");
  };
  fn.calls = calls;
  return fn;
}

after(() => rmSync(dir, { recursive: true, force: true }));

describe("engine2Available", () => {
  test("false off Windows even when the file exists", () => {
    writeFileSync(dpapiFile, "x");
    assert.equal(engine.engine2Available({ platform: "darwin", dpapiFile }), false);
  });

  test("false on Windows when the file is missing", () => {
    assert.equal(engine.engine2Available({ platform: "win32", dpapiFile: missingDpapiFile }), false);
  });

  test("true on Windows when the file exists", () => {
    writeFileSync(dpapiFile, "x");
    assert.equal(engine.engine2Available({ platform: "win32", dpapiFile }), true);
  });
});

describe("engine2Token", () => {
  test("decrypts via the injected pwsh child, path passed through an env var", async () => {
    writeFileSync(dpapiFile, "x");
    const execFileImpl = fakeExecFile("sk-ant-oat01-e2\r\n");
    const tok = await engine.engine2Token({ platform: "win32", dpapiFile, execFileImpl });
    assert.equal(tok, "sk-ant-oat01-e2");
    assert.equal(execFileImpl.calls.length, 1);
    const [call] = execFileImpl.calls;
    assert.equal(call.file, "pwsh");
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.ZEVET_DPAPI_FILE, dpapiFile);
    assert.ok(!call.args.some((a) => a.includes(dpapiFile)), "the path must not be interpolated into the -Command string");
  });

  test("undefined without spawning anything when engine2 is not available", async () => {
    const execFileImpl = fakeExecFile("should not run");
    const tok = await engine.engine2Token({ platform: "win32", dpapiFile: missingDpapiFile, execFileImpl });
    assert.equal(tok, undefined);
    assert.equal(execFileImpl.calls.length, 0);
  });

  test("undefined when the pwsh child fails", async () => {
    writeFileSync(dpapiFile, "x");
    const execFileImpl = fakeExecFile("", new Error("boom"));
    const tok = await engine.engine2Token({ platform: "win32", dpapiFile, execFileImpl });
    assert.equal(tok, undefined);
  });
});

describe("resolveEngine", () => {
  test("engine1 (default): no credential-selecting env var survives", async () => {
    const base = { CLAUDE_CODE_OAUTH_TOKEN: "stale", ANTHROPIC_API_KEY: "stale", PATH: "/x", HOME: "/h" };
    const r = await engine.resolveEngine(undefined, base);
    assert.equal(r.ok, true);
    assert.equal(r.engine, "engine1");
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(r.env.PATH, "/x", "everything else in the base env is kept");
  });

  test("an unrecognized engine name behaves like engine1", async () => {
    const r = await engine.resolveEngine("nonsense", {});
    assert.equal(r.engine, "engine1");
  });

  test("engine2 off Windows is an explicit, loud failure -- no silent fallback", async () => {
    const r = await engine.resolveEngine("engine2", {}, { platform: "darwin" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Windows/);
  });

  test("engine2 on Windows with no dpapi file is a loud failure", async () => {
    const r = await engine.resolveEngine("engine2", {}, { platform: "win32", dpapiFile: missingDpapiFile });
    assert.equal(r.ok, false);
    assert.match(r.error, /not set up/);
  });

  test("engine2 sets CLAUDE_CODE_OAUTH_TOKEN from the decrypted token and reports engine2", async () => {
    writeFileSync(dpapiFile, "x");
    const execFileImpl = fakeExecFile("sk-ant-oat01-e2");
    const r = await engine.resolveEngine("engine2", { PATH: "/x" }, { platform: "win32", dpapiFile, execFileImpl });
    assert.equal(r.ok, true);
    assert.equal(r.engine, "engine2");
    assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-e2");
    assert.equal(r.env.PATH, "/x");
  });

  test("auto is the default login: no usage probe, no credentials file read, no network", async () => {
    writeFileSync(dpapiFile, "x");
    const execFileImpl = fakeExecFile("sk-ant-oat01-e2");
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error("auto must not touch the network"); };
    try {
      const r = await engine.resolveEngine("auto", { PATH: "/x" }, { platform: "win32", dpapiFile, execFileImpl });
      assert.equal(r.engine, "engine1");
      assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(execFileImpl.calls.length, 0, "engine2 is not decrypted for auto");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the module no longer exposes a way to read the login's OAuth token or its usage", () => {
    assert.equal(engine.engine1Token, undefined);
    assert.equal(engine.engine1Windows, undefined);
  });
});
