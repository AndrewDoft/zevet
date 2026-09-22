// desktop/auto-title.js: a few generated words for a console's title, and the
// first-sentence fallback on every way that can fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { titleFor, sanitize, peel, ARGS } = require(path.join(ROOT, "desktop", "auto-title.js"));

/** A child that answers `out` and exits `code`, or never exits when code is null. */
function fakeSpawn(out, code, seen = {}) {
  return (command, args) => {
    seen.command = command;
    seen.args = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (text) => {
      seen.stdin = text;
      if (code === null) return;
      setImmediate(() => {
        if (out) child.stdout.emit("data", Buffer.from(out));
        child.emit("close", code);
      });
    };
    child.kill = () => {
      seen.killed = true;
    };
    return child;
  };
}

test("an answer is cut to one clean line", () => {
  assert.equal(sanitize('"Fix the parser."\n'), "Fix the parser");
  assert.equal(sanitize("Title: **Rail agent titles**"), "Rail agent titles");
  assert.equal(sanitize("\n  Small model titles  \nmore"), "Small model titles");
  assert.equal(sanitize("User's login bug"), "User's login bug");
  assert.equal(sanitize(""), "");
  // Talking, not titling.
  assert.equal(sanitize("Sure! Here is a short title that you could use for this"), "");
  const long = sanitize("Internationalization localization synchronization reconciliation");
  assert.ok(long.length <= 48 && !long.endsWith(" "), long);
});

test("the prompt sent is peeled and small", async () => {
  const seen = {};
  const title = await titleFor(`<system-reminder>x</system-reminder>${"a".repeat(5000)}`, {
    command: "claude",
    spawn: fakeSpawn("Long a run", 0, seen),
  });
  assert.equal(title, "Long a run");
  assert.deepEqual(seen.args, ARGS);
  assert.ok(!seen.stdin.includes("system-reminder"));
  assert.ok(seen.stdin.length < 1800, String(seen.stdin.length));
  assert.equal(peel("<task-notification><task-id>b1</task-id>"), "");
});

test("every failure resolves empty, so the fallback stays", async () => {
  assert.equal(await titleFor("fix it", { command: "claude", spawn: fakeSpawn("Not signed in", 1) }), "");
  assert.equal(
    await titleFor("fix it", {
      command: "claude",
      spawn: () => {
        throw new Error("spawn EINVAL");
      },
    }),
    "",
  );
  assert.equal(await titleFor("fix it", { command: "" }), "");
  assert.equal(await titleFor("<system-reminder>only</system-reminder>", { command: "claude", spawn: fakeSpawn("X", 0) }), "");
});

test("a run that hangs is killed at the timeout", async () => {
  const seen = {};
  const title = await titleFor("fix it", { command: "claude", spawn: fakeSpawn("", null, seen), timeoutMs: 20 });
  assert.equal(title, "");
  assert.equal(seen.killed, true);
});
