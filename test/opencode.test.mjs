// The OpenCode connector.
//
// opencode has no shell-hook config like Claude Code or Codex: it loads JS
// plugins from <repo>/.opencode/plugins/ at startup. So zevet's coverage is a
// plugin file copied per repo, and the per-repo file IS the opt-in — there is
// no global block to gate and no trust ceremony to record. Every claim about
// opencode's own behaviour is written up in docs/contracts/opencode-hooks.md,
// and the coverage is `unverified` until a live turn fires there.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { startHub, state, tempDir, TOKEN, ROOT } from "./helpers.mjs";
import {
  installOpencode,
  removeOpencode,
  opencodePluginPathFor,
  openrouterReady,
  PLUGIN_MARK,
} from "../client/install-opencode.mjs";

let hub;
before(async () => {
  hub = await startHub();
});
after(async () => {
  await hub?.stop();
});

function makeRepo(t, name = "proj") {
  const dir = tempDir(`zevet-opencode-${name}-`);
  t.after(() => dir.cleanup());
  const repo = path.join(dir.dir, name);
  mkdirSync(repo, { recursive: true });
  // A real git identity, so repo/branch detection has something to read and
  // file paths resolve relative to the root like they do in the field.
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return repo;
}

/** Fence env vars around a (possibly async) call. Awaits, so async bodies run fenced. */
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

describe("the opencode plugin file", () => {
  test("install writes the template verbatim, and twice is once", async (t) => {
    const repo = makeRepo(t);
    const first = installOpencode(repo);
    assert.ok(first.ok, `install failed: ${first.detail}`);
    const file = opencodePluginPathFor(repo);
    assert.equal(file, path.join(repo, ".opencode", "plugins", "zevet.js"));
    assert.ok(existsSync(file), "plugin file was not written");

    const template = readFileSync(path.join(ROOT, "client", "opencode-plugin.mjs"), "utf8");
    assert.equal(readFileSync(file, "utf8"), template, "installed copy differs from the template");
    assert.ok(template.includes(PLUGIN_MARK), "template carries no mark");

    const second = installOpencode(repo);
    assert.ok(second.ok, `reinstall failed: ${second.detail}`);
    assert.equal(readFileSync(file, "utf8"), template, "reinstall changed a current file");
  });

  test("a foreign zevet.js is refused, never overwritten", async (t) => {
    const repo = makeRepo(t);
    const file = opencodePluginPathFor(repo);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "// somebody else's plugin\nexport const Mine = {};\n", "utf8");

    const r = installOpencode(repo);
    assert.equal(r.ok, false, "install overwrote a file it did not write");
    assert.equal(
      readFileSync(file, "utf8"),
      "// somebody else's plugin\nexport const Mine = {};\n",
      "a refused install edited the file anyway",
    );
  });

  test("a legacy zevet.mjs carrying our mark is taken out, not left to look installed", async (t) => {
    // `.mjs` never loads (see install-opencode.mjs). A file with our mark is
    // unambiguously ours, so install and remove both clear it.
    const { opencodeLegacyPathFor } = await import("../client/install-opencode.mjs");
    const repo = makeRepo(t, "legacy");
    const legacy = opencodeLegacyPathFor(repo);
    mkdirSync(path.dirname(legacy), { recursive: true });
    const template = readFileSync(path.join(ROOT, "client", "opencode-plugin.mjs"), "utf8");
    writeFileSync(legacy, template, "utf8");

    const r = installOpencode(repo);
    assert.ok(r.ok, `install failed: ${r.detail}`);
    assert.ok(!existsSync(legacy), "dead .mjs plugin left beside the working one");
    assert.ok(existsSync(opencodePluginPathFor(repo)), "working .js plugin was not written");

    writeFileSync(legacy, template, "utf8");
    const gone = removeOpencode(repo);
    assert.equal(gone.state, "removed");
    assert.ok(!existsSync(legacy), "dead .mjs plugin survived removal");
  });

  test("remove takes ours and leaves theirs", async (t) => {
    const repo = makeRepo(t, "ours");
    installOpencode(repo);
    const gone = removeOpencode(repo);
    assert.equal(gone.state, "removed", `remove failed: ${gone.detail}`);
    assert.ok(!existsSync(opencodePluginPathFor(repo)), "plugin file survived removal");

    const empty = removeOpencode(repo);
    assert.equal(empty.state, "absent", "removing twice is not absent");

    const foreign = makeRepo(t, "theirs");
    const file = opencodePluginPathFor(foreign);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "// not ours\n", "utf8");
    const kept = removeOpencode(foreign);
    assert.ok(existsSync(file), "remove deleted somebody else's plugin");
    assert.ok(kept.state === "clean" || kept.state === "absent", `unexpected state: ${kept.state}`);
  });
});

describe("the plugin at runtime", () => {
  test("it exports one plugin function", async () => {
    const mod = await import(`../client/opencode-plugin.mjs?serial=${Date.now()}`);
    assert.equal(typeof mod.Zevet, "function", "no Zevet export");
  });

  test("tool and turn events reach the hub tagged agent=opencode", async (t) => {
    const home = tempDir("zevet-opencode-home-");
    t.after(() => home.cleanup());
    writeFileSync(
      path.join(home.dir, "config.json"),
      JSON.stringify({ hub: hub.base, token: TOKEN, actor: "opencode-test" }),
    );
    const repo = makeRepo(t, "live");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src", "db.ts"), "x\n");

    const before = (await state(hub.base, TOKEN)).body.events.length;
    await withEnv({ ZEVET_HOME: home.dir, ZEVET_TIMEOUT_MS: "4000" }, async () => {
      // Fresh import per test: the plugin module itself holds no settings, but
      // a query string defeats any loader cache anyway.
      const mod = await import(`../client/opencode-plugin.mjs?live=${Date.now()}`);
      const hooks = await mod.Zevet({ directory: repo });
      await hooks["tool.execute.before"]({ tool: "write" }, { args: { file_path: "src/db.ts" } });
      await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "npm test" } });
      // The after-hook is deliberately absent: one call, one event.
      assert.equal(typeof hooks["tool.execute.after"], "undefined", "an after-hook would double-count every tool");
      await hooks.event({ event: { type: "session.idle" } });
    });

    const afterState = await state(hub.base, TOKEN);
    const fresh = afterState.body.events.slice(before);
    assert.equal(fresh.length, 3, `expected 3 events, got ${fresh.length}: ${JSON.stringify(fresh)}`);
    for (const e of fresh) assert.equal(e.agent, "opencode", `wrong agent: ${JSON.stringify(e)}`);
    assert.deepEqual(
      fresh.map((e) => e.kind),
      ["tool", "tool", "turn_end"],
    );
    assert.equal(fresh[0].target, "src/db.ts", "file path is not repo-relative");
    const root = repo.replaceAll("\\", "/");
    assert.equal(fresh[0].checkout, createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex"));
    assert.equal(fresh[0].repo, "live", "repo did not come from the plugin directory");
  });

  test("an agent in a zevet-made worktree reports the repo it was made from", async (t) => {
    const home = tempDir("zevet-opencode-wt-");
    t.after(() => home.cleanup());
    writeFileSync(path.join(home.dir, "config.json"), JSON.stringify({ hub: hub.base, token: TOKEN, actor: "opencode-test" }));
    const repo = makeRepo(t, "orig");
    writeFileSync(path.join(repo, "a.ts"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo, stdio: "pipe" });
    const { createAgentWorktrees } = createRequire(import.meta.url)(path.join(ROOT, "desktop", "agent-worktree.js"));
    const wts = createAgentWorktrees({ home: home.dir });
    const wt = await wts.create(repo);
    t.after(() => wts.release(wt));

    const before = (await state(hub.base, TOKEN)).body.events.length;
    await withEnv({ ZEVET_HOME: home.dir, ZEVET_TIMEOUT_MS: "4000" }, async () => {
      const mod = await import(`../client/opencode-plugin.mjs?wt=${Date.now()}`);
      const hooks = await mod.Zevet({ directory: wt.dir });
      await hooks["tool.execute.before"]({ tool: "write" }, { args: { file_path: "a.ts" } });
    });
    const [e] = (await state(hub.base, TOKEN)).body.events.slice(before);
    assert.equal(e.repo, "orig");
    assert.equal(e.target, "a.ts");
    const root = repo.replaceAll("\\", "/");
    assert.equal(e.checkout, createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex"));
  });

  test("a dead hub never throws into the turn", async (t) => {
    const home = tempDir("zevet-opencode-dead-");
    t.after(() => home.cleanup());
    writeFileSync(
      path.join(home.dir, "config.json"),
      JSON.stringify({ hub: "http://127.0.0.1:1", token: TOKEN, actor: "opencode-test" }),
    );
    await withEnv({ ZEVET_HOME: home.dir, ZEVET_TIMEOUT_MS: "500" }, async () => {
      const mod = await import(`../client/opencode-plugin.mjs?dead=${Date.now()}`);
      const hooks = await mod.Zevet({ directory: t.name });
      // Must resolve, not reject: a throw in tool.execute.before blocks the tool.
      await hooks["tool.execute.before"]({ tool: "read" }, { args: { file_path: "x" } });
      await hooks.event({ event: { type: "session.idle" } });
      await hooks.event({ event: { type: "something-new" } });
      await hooks.event({});
    });
  });
});

describe("openrouter detection", () => {
  test("an env key counts without a file", async () => {
    const r = await withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => openrouterReady(path.join("no", "such", "home")));
    assert.equal(r.ready, true);
    assert.equal(r.via, "OPENROUTER_API_KEY");
  });

  test("an auth.json key counts, and its value is never repeated", async (t) => {
    const home = tempDir("zevet-openrouter-");
    t.after(() => home.cleanup());
    const dir = path.join(home.dir, ".local", "share", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api", key: "sk-or-secret" } }));
    const r = await withEnv({ OPENROUTER_API_KEY: undefined }, () => openrouterReady(home.dir));
    assert.equal(r.ready, true);
    assert.ok(!JSON.stringify(r).includes("sk-or-secret"), "the key value leaked into the result");
  });
});
