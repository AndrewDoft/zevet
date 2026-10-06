// The path an agent's edit takes to a named range in the buffer:
// hook (PreToolUse payload) -> ~/.zevet/edit-hints -> file-watch change event -> presence.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { runScript, tempDir, TOKEN, ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { FileWatch, readHints } = require("../desktop/file-watch.js");
const P = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "presence.mjs")).href);

const hookEnv = (home) => ({
  ZEVET_HUB: "http://127.0.0.1:9", // nothing listens: the hook must still exit 0 quietly
  ZEVET_TOKEN: TOKEN,
  ZEVET_SECRET: "",
  ZEVET_ACTOR: "Mina",
  ZEVET_HOME: home,
  ZEVET_UPDATE_INTERVAL_MS: "86400000",
});

describe("the hook leaves a local hint for edit tools", () => {
  test("Edit -> one hint file with the new text; stdout stays empty; hub never sees it", async () => {
    const home = tempDir("zevet-hint-home-");
    const r = await runScript("hook.mjs", {
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        cwd: home.dir,
        tool_input: { file_path: path.join(home.dir, "a.js"), old_string: "x", new_string: "  return 2;", ignored: "dropped" },
      }),
      env: hookEnv(home.dir),
    });
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
    const dir = path.join(home.dir, "edit-hints");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const hint = JSON.parse(readFileSync(path.join(dir, files[0]), "utf8"));
    assert.equal(hint.actor, "Mina");
    assert.equal(hint.agent, "claude-code");
    assert.equal(hint.input.new_string, "  return 2;");
    assert.equal(hint.input.ignored, undefined);
  });

  test("a Bash call leaves none", async () => {
    const home = tempDir("zevet-hint-home-");
    await runScript("hook.mjs", {
      stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
      env: hookEnv(home.dir),
    });
    assert.throws(() => readdirSync(path.join(home.dir, "edit-hints")));
  });
});

describe("a change event carries fresh hints", () => {
  test("readHints: fresh in, stale and junk out, oldest first", () => {
    const dir = tempDir("zevet-hints-").dir;
    const now = Date.now();
    const put = (name, body) => writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
    put("a.json", { ts: now - 1000, actor: "B", agent: "codex", tool: "apply_patch", input: {} });
    put("b.json", { ts: now - 3000, actor: "A", agent: "claude-code", tool: "Edit", input: {} });
    put("c.json", { ts: now - 120_000, actor: "Old", agent: "codex", tool: "Edit", input: {} });
    put("d.json", "{not json");
    assert.deepEqual(readHints(dir, now).map((h) => h.actor), ["A", "B"]);
    assert.deepEqual(readHints(path.join(dir, "missing"), now), []);
  });

  test("FileWatch -> hints -> a located range for the right agent", async () => {
    const root = tempDir("zevet-hintroot-").dir;
    const hints = path.join(root, ".hints");
    mkdirSync(hints);
    writeFileSync(path.join(root, "a.js"), "one\ntwo\nthree\n");
    const seen = [];
    const fw = new FileWatch({ onChange: (e) => seen.push(e), debounceMs: 40, hintsDir: hints });
    assert.ok(fw.watch(root, "a.js").ok);
    writeFileSync(
      path.join(hints, `${Date.now()}-1.json`),
      JSON.stringify({ ts: Date.now(), actor: "Mina", agent: "claude-code", tool: "Edit", input: { file_path: path.join(root, "a.js"), new_string: "TWO" } }),
    );
    writeFileSync(path.join(root, "a.js"), "one\nTWO\nthree\n");
    const deadline = Date.now() + 4000;
    while (!seen.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    fw.closeAll();
    assert.equal(seen.length, 1);
    const [r] = P.agentRanges(seen[0].hints, "a.js", seen[0].text);
    assert.equal(r.actor, "Mina");
    assert.equal(r.fromLine, 2);
  });
});
