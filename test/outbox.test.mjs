// Store-and-forward: what the hub never acknowledged is kept, then delivered.
//
// The hook and the opencode plugin share the shape (copies, not imports — see
// hook.mjs). Both halves are exercised here the same way: hub down means a
// line in outbox.jsonl; hub back means the backlog arrives oldest-first and
// the file drains. Nothing here may touch the turn: stdout stays empty and
// the exit is always 0.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { startHub, state, runScript, tempDir, TOKEN } from "./helpers.mjs";
import { addOpencodeRepo } from "../client/install-opencode.mjs";

const TOOL_PAYLOAD = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
});

function hookRun(home, hub, extra = {}) {
  return runScript("hook.mjs", {
    stdin: TOOL_PAYLOAD,
    args: ["--zevet-hook", "--zevet-agent", "claude-code", "--zevet-repo", home.repo],
    env: {
      ZEVET_HUB: hub,
      ZEVET_TOKEN: TOKEN,
      ZEVET_SECRET: "",
      ZEVET_ACTOR: "tester",
      ZEVET_HOME: home.dir,
      ZEVET_TIMEOUT_MS: "400",
      ZEVET_UPDATE_INTERVAL_MS: "86400000",
      ...extra,
    },
  });
}

function outboxOf(home) {
  return path.join(home.dir, "outbox.jsonl");
}

describe("the hook outbox", () => {
  test("an unreachable hub queues the event without touching the turn", async (t) => {
    const home = tempDir("zevet-outbox-");
    t.after(() => home.cleanup());
    home.repo = home.dir;
    const r = await hookRun(home, "http://127.0.0.1:1");
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
    assert.ok(existsSync(outboxOf(home)), "nothing was queued");
    const lines = readFileSync(outboxOf(home), "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).kind, "tool");
  });

  test("the backlog arrives oldest-first and the file drains", async (t) => {
    const home = tempDir("zevet-outbox-back-");
    t.after(() => home.cleanup());
    home.repo = home.dir;
    await hookRun(home, "http://127.0.0.1:1");
    await hookRun(home, "http://127.0.0.1:1");
    assert.equal(readFileSync(outboxOf(home), "utf8").split("\n").filter(Boolean).length, 2);

    const hub = await startHub();
    try {
      const before = (await state(hub.base, TOKEN)).body.events.length;
      const r = await hookRun(home, hub.base);
      assert.equal(r.stdout, "");
      assert.equal(r.code, 0);
      const events = (await state(hub.base, TOKEN)).body.events.slice(before);
      assert.equal(events.length, 3, `expected 2 queued + 1 live, got ${events.length}`);
      assert.equal(readFileSync(outboxOf(home), "utf8"), "", "outbox did not drain");
    } finally {
      await hub.stop();
    }
  });

  test("a hub answer is not queued, even a rejection", async (t) => {
    // A 401 means the credential is wrong; keeping it would retry a mistake
    // on every tool call until someone looks.
    const home = tempDir("zevet-outbox-401-");
    t.after(() => home.cleanup());
    home.repo = home.dir;
    const hub = await startHub();
    try {
      const r = await hookRun(home, hub.base, { ZEVET_TOKEN: "wrong-token-value-here" });
      assert.equal(r.code, 0);
      assert.ok(!existsSync(outboxOf(home)), "a rejected event was queued");
    } finally {
      await hub.stop();
    }
  });
});

describe("the plugin outbox", () => {
  async function withEnv(vars, fn) {
    const before = {};
    for (const k of Object.keys(vars)) {
      before[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  }

  test("same shape: queued while down, drained when back", async (t) => {
    const home = tempDir("zevet-outbox-plugin-");
    t.after(() => home.cleanup());
    const env = { ZEVET_HOME: home.dir, ZEVET_TIMEOUT_MS: "400" };
    // The global plugin now needs the directory opted in (see
    // opencode-repos.json / D-013) — home.dir has no .git, so the plugin's
    // opt-in check falls back to comparing this exact path.
    await withEnv({ ZEVET_HOME: home.dir }, () => addOpencodeRepo(home.dir));
    const mod = await import(`../client/opencode-plugin.mjs?outbox=${Date.now()}`);

    await withEnv({ ...env, ZEVET_HUB: "http://127.0.0.1:1", ZEVET_TOKEN: TOKEN }, async () => {
      const hooks = await mod.Zevet({ directory: home.dir });
      await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "npm test" } });
    });
    const file = path.join(home.dir, "outbox.jsonl");
    assert.ok(existsSync(file), "nothing was queued");
    // The agent tag is applied at POST time, not queue time — the queued line
    // is the event body as the turn saw it.
    const queued = JSON.parse(readFileSync(file, "utf8").split("\n").filter(Boolean)[0]);
    assert.equal(queued.kind, "tool");
    assert.equal(queued.tool, "bash");

    const hub = await startHub();
    try {
      const before = (await state(hub.base, TOKEN)).body.events.length;
      await withEnv({ ...env, ZEVET_HUB: hub.base, ZEVET_TOKEN: TOKEN }, async () => {
        const hooks = await mod.Zevet({ directory: home.dir });
        await hooks.event({ event: { type: "session.idle" } });
      });
      const events = (await state(hub.base, TOKEN)).body.events.slice(before);
      assert.deepEqual(events.map((e) => e.kind), ["tool", "turn_end"]);
      assert.equal(readFileSync(file, "utf8"), "", "outbox did not drain");
    } finally {
      await hub.stop();
    }
  });
});
