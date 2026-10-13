// The ratchets fail when a count grows AND when a baseline row goes stale; the shipped baselines are green.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { main, RATCHETS, collectMaxLines, collectTsNocheck, collectSpawns, collectRootEntries } from "../scripts/ratchets.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" });
const put = (root, rel, body) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};
const quiet = (fn) => {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { log, error });
  }
};

test("the shipped baselines match the tree", () => {
  assert.equal(quiet(() => main(ROOT, [])), 0);
  assert.ok(Number(readFileSync(path.join(ROOT, "config/max-lines-baseline.txt"), "utf8").match(/^(\d+) desktop\/main\.js$/m)?.[1]) > 5000, "main.js row present");
});

describe("on a fixture repo", () => {
  let root;
  const run = (...args) => quiet(() => main(root, args));
  const stage = () => git(root, "add", "-A");
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "zevet-ratchet-"));
    git(root, "init", "-q");
    mkdirSync(path.join(root, "config"));
    put(root, "big.js", "x\n".repeat(1001));
    put(root, "a.js", 'const { spawn } = require("node:child_process");\nspawn("x");\n');
    stage();
    run("--init");
    stage(); // the baselines themselves are root entries once tracked
    run("--init");
    stage();
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("green straight after --init", () => assert.equal(run(), 0));

  test("max-lines: a file that grows fails, one that shrinks is stale", () => {
    put(root, "big.js", "x\n".repeat(1002));
    assert.equal(run("max-lines"), 1);
    put(root, "big.js", "x\n".repeat(900));
    assert.equal(run("max-lines"), 1, "a shrunk file must be pruned so it cannot regrow");
    assert.equal(run("max-lines", "--prune"), 0);
    assert.equal(run("max-lines"), 0);
    put(root, "big.js", "x\n".repeat(1001)); // regrowing past the pruned baseline fails
    assert.equal(run("max-lines"), 1);
    assert.equal(run("max-lines", "--init"), 0); // accept it, so the next tests start from green
  });

  test("a NEW file over the limit fails", () => {
    put(root, "new.js", "x\n".repeat(1001));
    stage();
    assert.equal(run("max-lines"), 1);
    git(root, "rm", "-qf", "new.js");
  });

  test("child-process: a second launch fails; pruning never raises", () => {
    put(root, "a.js", 'const { spawn, execFile } = require("node:child_process");\nspawn("x");\nexecFile("y");\n');
    assert.equal(run("child-process"), 1);
    assert.equal(run("child-process", "--prune"), 1);
    put(root, "a.js", "// nothing\n");
    assert.equal(run("child-process"), 1, "launch removed: baseline row is stale");
    assert.equal(run("child-process", "--prune"), 0);
    assert.equal(run("child-process"), 0);
  });

  test("ts-nocheck: a new directive fails", () => {
    put(root, "b.ts", "// @ts-nocheck\nexport {};\n");
    stage();
    assert.equal(run("ts-nocheck"), 1);
    git(root, "rm", "-qf", "b.ts");
    assert.equal(run("ts-nocheck"), 0);
  });

  test("root-entries: a new top-level entry fails, a removed one is stale", () => {
    put(root, "extra/file.txt", "x");
    stage();
    assert.equal(run("root-entries"), 1);
    git(root, "rm", "-qrf", "extra");
    assert.equal(run("root-entries"), 0);
    git(root, "rm", "-qf", "a.js");
    assert.equal(run("root-entries"), 1);
  });

  test("an unknown ratchet name or flag is an error, not a pass", () => {
    assert.equal(run("nope"), 1);
    assert.equal(run("--prun"), 1);
  });

  test("a new untracked file over the limit fails before it is ever committed", () => {
    put(root, "fresh.js", "x\n".repeat(1001));
    assert.equal(run("max-lines"), 1);
    rmSync(path.join(root, "fresh.js"));
  });
});

test("collectors ignore tests, comments and the built hub bundle", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zevet-ratchet-c-"));
  try {
    git(root, "init", "-q");
    put(root, "hub/public/board.js", "x\n".repeat(2000) + '// @ts-nocheck\n');
    put(root, "test/t.test.mjs", '// @ts-nocheck\nimport { spawn } from "node:child_process";\nspawn("x");\n');
    put(root, "src/c.js", 'const cp = require("child_process");\n// spawn("x")\n/* @ts-nocheck */\ncp.spawn("y");\nprocess.exec(1);\n');
    git(root, "add", "-A");
    assert.equal(collectMaxLines(root).size, 0);
    assert.deepEqual([...collectTsNocheck(root)], [["src/c.js", 1]]);
    assert.deepEqual([...collectSpawns(root)], [["src/c.js", 1]], "regex .exec is not a launch");
    assert.deepEqual(collectRootEntries(root), ["hub", "src", "test"]);
    assert.equal(RATCHETS.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
