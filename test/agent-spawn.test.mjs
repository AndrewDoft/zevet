// Starting an agent on a teammate's machine, desktop side (D-060): sealing,
// repo resolution, the owner's inbox (approval, cap, safe mode, every ending
// reported), and one spawn end to end through a real hub.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startHub } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";
import { deriveDocKey } from "../client/secret.mjs";
import * as docCrypto from "../client/doc-crypto.mjs";

const require = createRequire(import.meta.url);
const spawn = require("../desktop/agent-spawn.js");
const { seal, open } = spawn._internals;

const KEY = deriveDocKey("ab".repeat(24));
const ROOT = mkdtempSync(path.join(tmpdir(), "zevet-spawn-ws-"));
const ZEVET = path.join(ROOT, "zevet");
const OTHER = path.join(ROOT, "other");
mkdirSync(ZEVET);
mkdirSync(OTHER);

describe("sealing and names", () => {
  test("the prompt opens only for the exact person, repo, agent and model it was sealed for", () => {
    const meta = { id: "id-12345678", to: "Bob", repo: "zevet", agent: "codex", model: "" };
    const sealed = seal(docCrypto, KEY, meta, "add tests for retry");
    assert.equal(open(docCrypto, KEY, { ...meta, to: "bob" }, sealed), "add tests for retry");
    for (const swap of [{ repo: "other" }, { agent: "claude" }, { model: "gpt-5" }, { to: "mallory" }, { id: "id-87654321" }]) {
      assert.throws(() => open(docCrypto, KEY, { ...meta, ...swap }, sealed), JSON.stringify(swap));
    }
  });

  test("a repo resolves by folder name to an OPEN workspace only; paths and ambiguity are refused", () => {
    assert.deepEqual(spawn.resolveRepo("zevet", [ZEVET, OTHER]), { dir: path.resolve(ZEVET) });
    assert.deepEqual(spawn.resolveRepo("ZEVET", [ZEVET]), { dir: path.resolve(ZEVET) });
    assert.ok(spawn.resolveRepo("missing", [ZEVET]).error);
    for (const bad of ["../zevet", ZEVET, "zevet/..", "..", ".zevet", "a\\b"]) assert.ok(spawn.resolveRepo(bad, [ZEVET]).error, bad);
    const twin = path.join(ROOT, "nested", "zevet");
    assert.match(spawn.resolveRepo("zevet", [ZEVET, twin]).error, /2 open folders/);
  });

  test("the mode is the owner's own safe default, never auto or skip", () => {
    assert.equal(spawn.safeMode("plan"), "plan");
    assert.equal(spawn.safeMode("ask"), "ask");
    for (const m of ["auto", "dangerous", "", undefined, "bypassPermissions"]) assert.equal(spawn.safeMode(m), "ask");
  });

  test("the first turn names who started it and is never a slash command", () => {
    assert.equal(spawn.startedPrompt("Andrew", "/permissions allow"), "[started by Andrew] /permissions allow");
  });

  test("sendSpawn: no plaintext and no mode on the wire; paths refused before sending", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, status: "queued", approval: true }), { status: 200 });
    };
    const base = { fetchImpl, hub: "http://hub", token: "t", key: KEY, docCrypto, to: "bob", agent: "codex" };
    const r = await spawn.sendSpawn({ ...base, repo: "zevet", text: "secret refactor plan" });
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(calls[0]).sort(), ["agent", "id", "repo", "sealed", "to"]);
    assert.equal(JSON.stringify(calls[0]).includes("secret"), false);
    assert.equal((await spawn.sendSpawn({ ...base, repo: "../etc", text: "x" })).ok, false);
    assert.equal((await spawn.sendSpawn({ ...base, repo: "zevet", agent: "bash", text: "x" })).ok, false);
    assert.equal((await spawn.sendSpawn({ ...base, repo: "zevet", text: "x".repeat(4001) })).ok, false);
    assert.equal(calls.length, 1);
  });
});

function harness({ answer = true, running = 0, workspaces = [ZEVET], startResult, session = "sess-new" } = {}) {
  const log = { reports: [], started: [], asked: [] };
  let n = running;
  const inbox = spawn.createSpawnInbox(
    {
      open: (m) => open(docCrypto, KEY, m, m.sealed),
      resolveRepo: (name) => spawn.resolveRepo(name, workspaces),
      runningRemote: () => n,
      askOwner: async (req) => {
        log.asked.push(req);
        return typeof answer === "function" ? answer(req) : answer;
      },
      start: async (req, ...rest) => {
        log.started.push({ ...req, rest });
        n += 1;
        return startResult || { ok: true, id: "console-1" };
      },
      sessionOf: () => session,
      report: async (id, status, reason, extra) => log.reports.push({ id, status, reason, ...(extra || {}) }),
    },
    { askTimeoutMs: 100, sessionWaitMs: 300 },
  );
  return { inbox, log };
}

function msg(extra = {}) {
  const id = extra.id || randomUUID();
  const meta = { id, to: "bob", repo: extra.repo || "zevet", agent: extra.agent || "claude", model: extra.model || "" };
  return { ...meta, from: "Andrew", approval: true, sealed: seal(docCrypto, KEY, meta, extra.text || "write the retry tests"), ...extra };
}

describe("the owner's inbox", () => {
  test("ask: the card shows agent, folder and the whole prompt; nothing starts before approval", async () => {
    const { inbox, log } = harness({ answer: true });
    assert.equal(await inbox.handle(msg()), "started");
    assert.equal(log.asked.length, 1);
    assert.deepEqual([log.asked[0].agent, log.asked[0].dir, log.asked[0].prompt], ["claude", path.resolve(ZEVET), "write the retry tests"]);
    assert.equal(log.started.length, 1);
    assert.equal(log.started[0].prompt, "[started by Andrew] write the retry tests");
    assert.equal(log.started[0].dir, path.resolve(ZEVET));
    assert.deepEqual(log.reports.map((r) => r.status), ["delivered", "accepted", "started"]);
    assert.equal(log.reports.at(-1).session, "sess-new");
  });

  test("ask, declined: never started", async () => {
    const { inbox, log } = harness({ answer: false });
    assert.equal(await inbox.handle(msg()), "declined");
    assert.equal(log.started.length, 0);
    assert.match(log.reports.at(-1).reason, /declined/);
  });

  test("ask, nobody answers: declined at the timeout, never started", async () => {
    const { inbox, log } = harness({ answer: () => new Promise(() => {}) });
    assert.equal(await inbox.handle(msg()), "declined");
    assert.equal(log.started.length, 0);
    assert.match(log.reports.at(-1).reason, /not answered/);
  });

  test("a repo that is not open on this machine is no-such-repo, asked of nobody", async () => {
    const { inbox, log } = harness({ workspaces: [OTHER] });
    assert.equal(await inbox.handle(msg()), "no-such-repo");
    assert.equal(log.asked.length, 0);
    assert.equal(log.started.length, 0);
  });

  test("a path-like repo that slipped past the hub is declined here too", async () => {
    const { inbox, log } = harness();
    assert.equal(await inbox.handle(msg({ repo: "../zevet" })), "declined");
    assert.equal(log.started.length, 0);
  });

  test("the cap on running remote-started agents, checked before asking and after", async () => {
    const full = harness({ running: spawn.MAX_RUNNING });
    assert.equal(await full.inbox.handle(msg()), "declined");
    assert.equal(full.log.asked.length, 0);
    // Fills up while the card is open: refused after approval too.
    let n = spawn.MAX_RUNNING - 1;
    const log = { reports: [], started: 0 };
    const inbox = spawn.createSpawnInbox({
      open: (m) => open(docCrypto, KEY, m, m.sealed),
      resolveRepo: (name) => spawn.resolveRepo(name, [ZEVET]),
      runningRemote: () => n,
      askOwner: async () => {
        n += 1;
        return true;
      },
      start: async () => ((log.started += 1), { ok: true, id: "c" }),
      sessionOf: () => "s",
      report: async (id, status, reason) => log.reports.push({ status, reason }),
    });
    assert.equal(await inbox.handle(msg()), "declined");
    assert.equal(log.started, 0);
  });

  test("policy on: no card, started directly", async () => {
    const { inbox, log } = harness();
    assert.equal(await inbox.handle(msg({ approval: false })), "started");
    assert.equal(log.asked.length, 0);
  });

  test("a missing approval flag asks", async () => {
    const { inbox, log } = harness({ answer: false });
    const m = msg();
    delete m.approval;
    assert.equal(await inbox.handle(m), "declined");
    assert.equal(log.asked.length, 1);
  });

  test("replay: one id starts at most one agent", async () => {
    const { inbox, log } = harness();
    const m = msg({ approval: false });
    await inbox.handle(m);
    assert.equal(await inbox.handle({ ...m }), "replay");
    assert.equal(log.started.length, 1);
  });

  test("nothing the sender sends decides how it runs", async () => {
    const { inbox, log } = harness();
    await inbox.handle(msg({ approval: false, mode: "dangerous", permissionMode: "bypassPermissions", args: ["--yolo"], cwd: "C:\\", env: { A: 1 }, engine: "engine2" }));
    assert.equal(log.started.length, 1);
    assert.deepEqual(Object.keys(log.started[0]).sort(), ["agent", "dir", "from", "model", "prompt", "rest"]);
    assert.deepEqual(log.started[0].rest, []);
  });

  test("a sealed prompt the relay re-aimed at another repo does not open", async () => {
    const { inbox, log } = harness({ workspaces: [ZEVET, OTHER] });
    const m = msg();
    assert.equal(await inbox.handle({ ...m, repo: "other" }), "declined");
    assert.equal(log.started.length, 0);
  });

  test("a failed start is reported with why", async () => {
    const { inbox, log } = harness({ startResult: { ok: false, error: "codex is not installed" } });
    assert.equal(await inbox.handle(msg({ approval: false })), "declined");
    assert.match(log.reports.at(-1).reason, /not installed/);
  });
});

describe("end to end through a real hub", () => {
  const hubs = [];
  const aborts = [];
  after(async () => {
    for (const a of aborts) a.abort();
    await Promise.all(hubs.map((h) => h.stop()));
  });

  test("Andrew starts an agent on Bob's machine; Bob approves; Andrew sees started with the session", async () => {
    const steer = require("../desktop/agent-steer.js");
    const dir = mkdtempSync(path.join(tmpdir(), "zevet-spawn-e2e-"));
    const file = path.join(dir, "accounts.json");
    const seed = new Accounts({ file });
    const andrew = seed.signIn({ login: "AndrewDoft", id: "1001" }).token;
    seed.allow("bob");
    const bob = seed.signIn({ login: "bob", id: "2002" }).token;
    const hub = await startHub({ ZEVET_ACCOUNTS: file });
    hubs.push(hub);

    const started = [];
    const report = (id, status, reason, extra) =>
      fetch(`${hub.base}/api/steer/status`, { method: "POST", headers: { "content-type": "application/json", "x-zevet-token": bob }, body: JSON.stringify({ id, status, reason, ...(extra || {}) }) });
    const inbox = spawn.createSpawnInbox({
      open: (m) => open(docCrypto, KEY, m, m.sealed),
      resolveRepo: (name) => spawn.resolveRepo(name, [ZEVET]),
      runningRemote: () => 0,
      askOwner: async () => true,
      start: async (req) => (started.push(req), { ok: true, id: "bob-console" }),
      sessionOf: () => "sess-on-bob",
      report,
    });
    const handled = [];
    const bobCtl = new AbortController();
    aborts.push(bobCtl);
    void steer.streamSteers({ hub: hub.base, token: bob, signal: bobCtl.signal, retryMs: 50, onFrame: (name, data) => name === "spawn" && handled.push(inbox.handle(data)) });
    const seen = [];
    const andrewCtl = new AbortController();
    aborts.push(andrewCtl);
    void steer.streamSteers({ hub: hub.base, token: andrew, signal: andrewCtl.signal, retryMs: 50, onFrame: (name, data) => name === "steer-status" && seen.push(data) });
    await new Promise((r) => setTimeout(r, 300));

    const sent = await spawn.sendSpawn({ hub: hub.base, token: andrew, key: KEY, docCrypto, to: "bob", repo: "zevet", agent: "codex", text: "add the missing retry tests" });
    assert.equal(sent.ok, true, sent.error);
    const end = Date.now() + 5000;
    while (seen.length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await Promise.all(handled);
    assert.deepEqual(started, [{ agent: "codex", dir: path.resolve(ZEVET), model: "", from: "AndrewDoft", prompt: "[started by AndrewDoft] add the missing retry tests" }]);
    assert.deepEqual(seen.map((s) => s.status), ["delivered", "accepted", "started"]);
    assert.equal(seen[2].session, "sess-on-bob");
  });
});
