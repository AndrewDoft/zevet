// The Codex connector.
//
// Codex reads hooks ONLY from $CODEX_HOME/config.toml. A block inside a repo
// never fires -- that was the whole reason zevet's Codex support sat labelled
// "installs but has never been seen to fire" for its entire life. Every claim
// these tests make about Codex's own behaviour was measured against
// codex-cli 0.155.0-alpha.2.6 and is written up in docs/contracts/codex-hooks.md.
//
// One global block means the hook runs for EVERY project on the machine, so the
// opt-in list is not a nicety: without it, wiring one repo publishes all of them
// to a hub the whole team can read. That is the property most of this file
// guards.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, runScript, state, tempDir, TOKEN, ROOT } from "./helpers.mjs";
import {
  installCodex,
  codexGlobalConfigPath,
  codexConfigPathFor,
  readCodexRepos,
  BLOCK_START,
} from "../client/install-codex.mjs";

let hub;
before(async () => {
  hub = await startHub();
});
after(async () => {
  await hub?.stop();
});

/** A repo with a real git identity, so repo/branch detection has something to read. */
function makeRepo(t, name = "proj") {
  const dir = tempDir(`zevet-codex-${name}-`);
  t.after(() => dir.cleanup());
  const repo = path.join(dir.dir, name);
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return repo;
}

/** An isolated CODEX_HOME + ZEVET_HOME, asserted to be under the temp dir. */
function homes(t) {
  const d = tempDir("zevet-codex-home-");
  t.after(() => d.cleanup());
  assert.ok(d.dir.startsWith(tmpdir()), `refusing to run outside ${tmpdir()}`);
  const codex = path.join(d.dir, "codex");
  const zevet = path.join(d.dir, "zevet");
  mkdirSync(codex, { recursive: true });
  mkdirSync(zevet, { recursive: true });
  return { codex, zevet };
}

/**
 * installCodex reads CODEX_HOME/ZEVET_HOME from the environment at call time,
 * so the fence is set around the call and restored after it. Without this the
 * suite edits the developer's own ~/.codex/config.toml -- which it did, once.
 */
function withHomes({ codex, zevet }, fn) {
  const before = { CODEX_HOME: process.env.CODEX_HOME, ZEVET_HOME: process.env.ZEVET_HOME };
  process.env.CODEX_HOME = codex;
  process.env.ZEVET_HOME = zevet;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("where the Codex hooks block is written", () => {
  test("into the global config, and never into the repo", async (t) => {
    const h = homes(t);
    const repo = makeRepo(t);
    const r = withHomes(h, () =>
      installCodex(repo, { hookPath: path.join(ROOT, "client", "hook.mjs"), node: process.execPath, mark: "--zevet-hook" }),
    );
    assert.ok(r.ok, `install failed: ${r.detail}`);

    const global = path.join(h.codex, "config.toml");
    assert.ok(existsSync(global), "the global config was not written");
    assert.ok(readFileSync(global, "utf8").includes(BLOCK_START), "no managed block in the global config");

    // The repo-local file is the one Codex ignores. Writing it would be worse
    // than useless: it looks installed and does nothing.
    assert.ok(!existsSync(codexConfigPathFor(repo)), "a block was written into the repo, where it can never fire");
  });

  test("the repo is recorded as opted in", async (t) => {
    const h = homes(t);
    const repo = makeRepo(t);
    withHomes(h, () => {
      installCodex(repo, { hookPath: "h.mjs", node: process.execPath, mark: "--zevet-hook" });
      const list = readCodexRepos();
      assert.deepEqual(list, [path.resolve(repo)], "the wired repo is not on the opt-in list");
    });
  });

  test("removing one repo leaves the block while another still needs it", async (t) => {
    const h = homes(t);
    const a = makeRepo(t, "aaa");
    const b = makeRepo(t, "bbb");
    withHomes(h, () => {
      installCodex(a, { hookPath: "h.mjs", node: process.execPath, mark: "--zevet-hook" });
      installCodex(b, { hookPath: "h.mjs", node: process.execPath, mark: "--zevet-hook" });
      assert.equal(readCodexRepos().length, 2);

      installCodex(a, { hookPath: "", node: "", mark: "--zevet-hook", remove: true });
      const text = readFileSync(codexGlobalConfigPath(), "utf8");
      assert.ok(text.includes(BLOCK_START), "unwiring one repo tore out the block the other still needs");
      assert.deepEqual(readCodexRepos(), [path.resolve(b)], "the removed repo is still listed");

      installCodex(b, { hookPath: "", node: "", mark: "--zevet-hook", remove: true });
      assert.ok(!readFileSync(codexGlobalConfigPath(), "utf8").includes(BLOCK_START), "the last repo left the block behind");
      assert.deepEqual(readCodexRepos(), []);
    });
  });
});

describe("the command string Codex can actually run", () => {
  test("the program token is never a quoted path", async (t) => {
    // MEASURED: Codex resolves the program from the first whitespace-delimited
    // token and does not honour quotes around it, so `"C:\Program Files\..."`
    // fails. Arguments quote fine. This is the defect that kept the connector
    // dark, so it is asserted on the generated string rather than trusted.
    const h = homes(t);
    const repo = makeRepo(t);
    withHomes(h, () =>
      installCodex(repo, {
        hookPath: path.join(ROOT, "client", "hook.mjs"),
        node: process.execPath,
        mark: "--zevet-hook",
      }),
    );
    const text = readFileSync(path.join(h.codex, "config.toml"), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("Stop = "));
    assert.ok(line, `no Stop handler in:\n${text}`);
    const command = (line.match(/command = '([^']*)'/) || [])[1];
    assert.ok(command, `no command in: ${line}`);

    const program = command.trim().split(/\s+/)[0];
    assert.ok(!program.startsWith('"') && !program.startsWith("'"), `the program token is quoted: ${program}`);
    assert.ok(!program.includes(" "), `the program token contains a space: ${program}`);
    if (process.platform === "win32") {
      assert.equal(program.toLowerCase(), "cmd", `expected a cmd /c wrapper on Windows, got: ${command}`);
    }
    // The repo must NOT be baked in: one global block serves every repo, and a
    // repo in the command would label them all with whichever was wired first.
    assert.ok(!command.includes("--zevet-repo"), `the repo is baked into a global hook: ${command}`);
    assert.ok(command.includes("--zevet-agent codex"), `the agent flag is missing: ${command}`);
  });
});

describe("the POSIX branch, which no Mac has yet run", () => {
  /**
   * Michael and Kai are both on Apple silicon and no macOS machine was
   * available, so this forces the platform rather than claiming coverage it
   * does not have. It proves what zevet GENERATES on POSIX; whether Codex
   * accepts it there is still open (INSUF-003). That is a smaller gap than
   * "never exercised at all", which is what this was.
   */
  function asPlatform(name, fn) {
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: name, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  }

  test("writes a bare program path, with no cmd /c and no quoting around it", async (t) => {
    const h = homes(t);
    const repo = makeRepo(t, "posix");
    asPlatform("darwin", () =>
      withHomes(h, () =>
        installCodex(repo, { hookPath: "/Users/m/.zevet/client/hook.mjs", node: "/opt/homebrew/bin/node", mark: "--zevet-hook" }),
      ),
    );
    const text = readFileSync(path.join(h.codex, "config.toml"), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("Stop = "));
    assert.ok(line, `no Stop handler in:\n${text}`);
    const command = (line.match(/command = '([^']*)'/) || [])[1];
    assert.ok(command, `no command in: ${line}`);
    assert.ok(!command.startsWith("cmd /c"), `the Windows wrapper leaked onto POSIX: ${command}`);
    const program = command.trim().split(/\s+/)[0];
    assert.equal(program, "/opt/homebrew/bin/node", `wrong program token: ${program}`);
    assert.ok(!program.startsWith('"'), "the program is quoted, which Codex does not resolve");
    assert.ok(command.includes('"/Users/m/.zevet/client/hook.mjs"'), `the script should still be quoted: ${command}`);
  });

  test("refuses loudly if the POSIX node path has a space", async (t) => {
    // The Windows lesson applied forward: a spaced program path cannot be
    // written at all, so fail with a reason rather than emit a hook that will
    // silently never fire.
    const h = homes(t);
    const repo = makeRepo(t, "posixspace");
    const r = asPlatform("darwin", () =>
      withHomes(h, () =>
        installCodex(repo, { hookPath: "/tmp/hook.mjs", node: "/Applications/My Tools/node", mark: "--zevet-hook" }),
      ),
    );
    assert.equal(r.ok, false, "a node path with a space was accepted on POSIX");
    assert.match(r.detail, /space/, `unhelpful refusal: ${r.detail}`);
  });
});

describe("the opt-in list decides what reaches the hub", () => {
  /** One Codex event, exactly as Codex delivers it: cwd in the payload, flag on argv. */
  async function fire(repo, zevetHome) {
    // Stamp the update check as just-done BEFORE the hook runs.
    //
    // ZEVET_UPDATE_INTERVAL_MS alone does NOT stop the updater: hook.mjs only
    // skips when a `last-check` stamp exists and is fresh, and a brand-new temp
    // ZEVET_HOME has none — so the first hook of every test spawned a detached
    // updater that wrote into <home>/client while the test's cleanup was trying
    // to remove it. On Windows that surfaced as
    //   ENOTEMPTY: directory not empty, rmdir '...\zevet\client'
    // on the CI runner and never once on a dev box, which is exactly the shape
    // CLAUDE.md 9.1 warns about. Writing the stamp removes the race rather than
    // widening the retry window around it.
    writeFileSync(path.join(zevetHome, "last-check"), String(Date.now()), "utf8");
    return runScript("hook.mjs", {
      args: ["--zevet-hook", "--zevet-agent", "codex"],
      stdin: JSON.stringify({
        session_id: "s1",
        turn_id: "t1",
        hook_event_name: "UserPromptSubmit",
        cwd: repo,
        prompt: "do the thing",
        model: "gpt-6-astra",
      }),
      env: {
        ZEVET_HUB: hub.base,
        ZEVET_TOKEN: TOKEN,
        ZEVET_ACTOR: "tester",
        ZEVET_HOME: zevetHome,
        ZEVET_UPDATE_INTERVAL_MS: "86400000",
      },
    });
  }

  test("a listed repo reports, an unlisted one stays silent", async (t) => {
    const h = homes(t);
    const listed = makeRepo(t, "listed");
    const other = makeRepo(t, "other");
    withHomes(h, () => installCodex(listed, { hookPath: "h.mjs", node: process.execPath, mark: "--zevet-hook" }));

    const before = (await state(hub.base)).body.events.length;

    const quiet = await fire(other, h.zevet);
    assert.equal(quiet.code, 0, "the hook must exit 0 even when it publishes nothing");
    assert.equal(quiet.stdout, "", "the hook must never write to stdout");
    assert.equal(
      (await state(hub.base)).body.events.length,
      before,
      "a repo nobody opted in published to the hub",
    );

    const loud = await fire(listed, h.zevet);
    assert.equal(loud.code, 0);
    const after = (await state(hub.base)).body.events;
    assert.equal(after.length, before + 1, "the opted-in repo did not report");
    const ev = after[after.length - 1];
    assert.equal(ev.agent, "codex", "the event is not attributed to codex");
    assert.equal(ev.kind, "prompt");
    assert.equal(ev.repo, path.basename(listed), `repo came out as ${ev.repo}`);
  });

  test("no list at all means silence, not everything", async (t) => {
    // The failure direction matters: an unreadable or missing list must publish
    // nothing, rather than falling open and reporting every repo on the machine.
    const h = homes(t);
    const repo = makeRepo(t, "nolist");
    const before = (await state(hub.base)).body.events.length;
    const r = await fire(repo, h.zevet); // nothing installed, so no list exists
    assert.equal(r.code, 0);
    assert.equal((await state(hub.base)).body.events.length, before, "a missing opt-in list fell open");
  });

  test("an opted-in folder keeps reporting when the agent resolves its symlink", async (t) => {
    const h = homes(t);
    const repo = makeRepo(t, "real-repo");
    const alias = path.join(path.dirname(repo), "picked-alias");
    symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    const opts = { hookPath: "h.mjs", node: process.execPath, mark: "--zevet-hook" };
    withHomes(h, () => installCodex(alias, opts));
    const before = (await state(hub.base)).body.events.length;
    const fired = await fire(repo, h.zevet);
    assert.equal(fired.code, 0);
    assert.equal(fired.stdout, "");
    assert.equal((await state(hub.base)).body.events.length, before + 1, "the canonical path is the same chosen repo");
    withHomes(h, () => installCodex(repo, opts));
    assert.equal(withHomes(h, readCodexRepos).length, 1, "aliases must not create duplicate opt-ins");
    withHomes(h, () => installCodex(repo, { ...opts, remove: true }));
    assert.deepEqual(withHomes(h, readCodexRepos), [], "removing the canonical path must remove its alias too");
  });

  test("a corrupt list means silence too", async (t) => {
    const h = homes(t);
    const repo = makeRepo(t, "badlist");
    writeFileSync(path.join(h.zevet, "codex-repos.json"), "{ this is not json", "utf8");
    const before = (await state(hub.base)).body.events.length;
    const r = await fire(repo, h.zevet);
    assert.equal(r.code, 0);
    assert.equal((await state(hub.base)).body.events.length, before, "a corrupt opt-in list fell open");
  });
});
