// The uninstaller, executed.
//
// This file exists because client/uninstall.mjs shipped having never been run
// once. It is also the most destructive thing in the repo: it edits config
// files it did not write and deletes directories. Reading it is not evidence.
//
// SAFETY: every run here is fenced to a throwaway ZEVET_HOME under the OS temp
// directory, asserted before the child is spawned. An uninstall that escaped
// that fence would delete the developer's own ~/.zevet, token and all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tempDir, runScript } from "./helpers.mjs";

const MARK = "--zevet-hook";
const ZEVET_HOOK = (home) => ({
  type: "command",
  command: `node "${path.join(home, "client", "hook.mjs")}" ${MARK}`,
  timeout: 10,
});
/** Somebody else's hook, in the same file. It must survive untouched. */
const THEIR_HOOK = { type: "command", command: "npm run lint-staged", timeout: 30 };

const BLOCK_START = "# zevet:hooks:start — managed block, do not edit by hand";
const BLOCK_END = "# zevet:hooks:end";

/**
 * A throwaway ZEVET_HOME plus N repos, and one uninstall run over them.
 *
 * Cleanup is registered on the test context, NOT in a finally here: the whole
 * point of these tests is to read the files afterwards, and a finally would
 * delete them before the caller ever looked. (It did, on the first run.)
 */
async function uninstall(t, { repos = {}, args = [], config = true, workspaces } = {}) {
  const home = tempDir("zevet-uninstall-home-");
  const work = tempDir("zevet-uninstall-repos-");
  // The fence. If this ever fails, do not spawn anything.
  assert.ok(
    home.dir.startsWith(tmpdir()) && work.dir.startsWith(tmpdir()),
    `refusing to run: ${home.dir} is not under ${tmpdir()}`,
  );
  t.after(() => {
    home.cleanup();
    work.cleanup();
  });
  {
    mkdirSync(path.join(home.dir, "client"), { recursive: true });
    writeFileSync(path.join(home.dir, "client", "hook.mjs"), "// pretend client\n");
    if (config) {
      writeFileSync(path.join(home.dir, "config.json"), JSON.stringify({ hub: "http://x", token: "t" }));
    }

    const made = {};
    for (const [name, spec] of Object.entries(repos)) {
      const repo = path.join(work.dir, name);
      mkdirSync(repo, { recursive: true });
      if (spec.claude !== undefined) {
        mkdirSync(path.join(repo, ".claude"), { recursive: true });
        const f = path.join(repo, ".claude", "settings.json");
        const body =
          typeof spec.claude === "string" ? spec.claude : `${JSON.stringify(spec.claude, null, 2)}\n`;
        writeFileSync(f, body);
      }
      if (spec.codex !== undefined) {
        mkdirSync(path.join(repo, ".codex"), { recursive: true });
        writeFileSync(path.join(repo, ".codex", "config.toml"), spec.codex);
      }
      made[name] = repo;
    }
    const list = workspaces !== undefined ? workspaces : Object.values(made);
    writeFileSync(path.join(home.dir, "workspaces.json"), JSON.stringify(list));

    // CODEX_HOME as well as ZEVET_HOME: the Codex hooks block lives in the
    // GLOBAL Codex config, so an unfenced uninstall run strips the developer's
    // real ~/.codex/config.toml. It did exactly that once -- the suite was
    // green while quietly unwiring this machine.
    const r = await runScript("uninstall.mjs", {
      args,
      env: { ZEVET_HOME: home.dir, CODEX_HOME: path.join(home.dir, "codex") },
    });
    const read = (name, rel) => readFileSync(path.join(made[name], rel), "utf8");
    const backupsFor = (name, dir) => {
      const d = path.join(made[name], dir);
      return existsSync(d) ? readdirSync(d).filter((f) => f.includes(".bak.")) : [];
    };
    return { r, home: home.dir, repos: made, read, backupsFor };
  }
}

/** Rule 1: an uninstall never hands back a red exit code. */
const assertExitZero = (r, label) =>
  assert.equal(r.code, 0, `${label}: uninstall must exit 0, got ${r.code}\n${r.stdout}\n${r.stderr}`);

describe("the uninstaller takes out ours and only ours", () => {
  test("a zevet hook is removed and a neighbouring hook is left alone", async (t) => {
    const { r, read } = await uninstall(t, {
      repos: {
        a: {
          claude: {
            // A key we have no business touching, first, so a rewrite that
            // dropped unknown top-level keys would show here.
            permissions: { allow: ["Bash(git status)"] },
            hooks: {
              PreToolUse: [{ matcher: "*", hooks: [ZEVET_HOOK("/home/x/.zevet"), THEIR_HOOK] }],
              Stop: [{ hooks: [ZEVET_HOOK("/home/x/.zevet")] }],
            },
          },
        },
      },
    });
    assertExitZero(r, "mixed hooks");
    const cfg = JSON.parse(read("a", ".claude/settings.json"));

    assert.deepEqual(cfg.permissions, { allow: ["Bash(git status)"] }, "an unrelated key was disturbed");
    assert.deepEqual(
      cfg.hooks.PreToolUse,
      [{ matcher: "*", hooks: [THEIR_HOOK] }],
      "their hook did not survive intact",
    );
    assert.ok(!("Stop" in cfg.hooks), "an event key emptied of our hooks should go, not linger as []");
    assert.ok(!JSON.stringify(cfg).includes(MARK), "a zevet hook survived the uninstall");
    assert.match(r.stdout, /Claude Code\s+removed 2 hook entries/);
  });

  test("a settings file with nothing of ours is not rewritten at all", async (t) => {
    // Rule 2. Not "rewritten identically" — not rewritten. A reformat and a
    // stray .bak in someone's repo is litter we had no reason to leave.
    const theirs =
      '{\n    "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "make fmt"}]}]}\n}\n';
    const { r, read, backupsFor, repos } = await uninstall(t, { repos: { b: { claude: theirs } } });
    assertExitZero(r, "nothing of ours");
    assert.equal(read("b", ".claude/settings.json"), theirs, "a file with no zevet hooks was rewritten");
    assert.deepEqual(backupsFor("b", ".claude"), [], "a backup was made of a file we never changed");
    assert.match(r.stdout, /no zevet hooks in/);
    assert.ok(existsSync(repos.b), "the repo itself must still be there");
  });

  test("a settings file that will not parse is reported and left byte-for-byte", async (t) => {
    const broken = '{ "hooks": { oops';
    const { r, read } = await uninstall(t, { repos: { c: { claude: broken } } });
    assertExitZero(r, "broken json");
    assert.equal(read("c", ".claude/settings.json"), broken, "a file we could not parse was written anyway");
    assert.match(r.stdout, /FAILED: .*is not valid JSON/);
    assert.match(r.stdout, /1 thing could not be done/);
  });

  test("the codex managed block goes and the rest of the toml stays", async (t) => {
    const toml = [
      'model = "gpt-5"',
      "",
      BLOCK_START,
      "[hooks]",
      'PreToolUse = { type = "command", command = "node hook.mjs" }',
      BLOCK_END,
      "",
      "[projects.'/somewhere']",
      'trust_level = "trusted"',
      "",
    ].join("\n");
    const { r, read } = await uninstall(t, { repos: { d: { codex: toml } } });
    assertExitZero(r, "codex block");
    const after = read("d", ".codex/config.toml");
    assert.ok(!after.includes(BLOCK_START), "the managed block survived");
    assert.ok(!after.includes("PreToolUse"), "a hook inside the block survived");
    assert.match(after, /model = "gpt-5"/, "their model setting was lost");
    assert.match(after, /trust_level = "trusted"/, "their trust table was lost");
  });
});

describe("the uninstaller keeps going and says what it did", () => {
  test("a repo listed but no longer on disk is reported, not fatal", async (t) => {
    const gone = path.join(tmpdir(), "zevet-definitely-not-here-93f1c2");
    assert.ok(!existsSync(gone), "the fixture path must genuinely not exist");
    const { r } = await uninstall(t, {
      repos: { e: { claude: { hooks: { Stop: [{ hooks: [ZEVET_HOOK("/h")] }] } } } },
      workspaces: [gone, path.join(tmpdir(), "also-not-here-93f1c2")],
    });
    assertExitZero(r, "missing repo");
    assert.match(r.stdout, /folder is not here/);
  });

  test("a workspaces.json that will not parse still produces a report", async (t) => {
    const home = tempDir("zevet-uninstall-home-");
    assert.ok(home.dir.startsWith(tmpdir()));
    try {
      writeFileSync(path.join(home.dir, "workspaces.json"), "{ not json");
      const r = await runScript("uninstall.mjs", {
        env: { ZEVET_HOME: home.dir, CODEX_HOME: path.join(home.dir, "codex") },
      });
      assertExitZero(r, "broken workspaces");
      assert.match(r.stdout, /workspaces\s+.*is not valid JSON/);
      // And it still tells the reader how to finish by hand.
      assert.match(r.stdout, /install\.mjs <repo-path> --remove/);
    } finally {
      home.cleanup();
    }
  });

  test("the client folder is removed; config.json is kept unless --all", async (t) => {
    const { r, home } = await uninstall(t, { repos: {} });
    assertExitZero(r, "default run");
    assert.ok(!existsSync(path.join(home, "client")), "the client folder should be gone");
    assert.ok(existsSync(path.join(home, "config.json")), "config.json must survive a default uninstall");
    assert.match(r.stdout, /config\s+left alone at/);
  });

  test("--all takes the whole home, token and all", async (t) => {
    const { r, home } = await uninstall(t, { repos: {}, args: ["--all"] });
    assertExitZero(r, "--all");
    assert.ok(!existsSync(home), `--all must remove ${home}`);
    assert.match(r.stdout, /config\s+removed .*token and all/);
  });
});
