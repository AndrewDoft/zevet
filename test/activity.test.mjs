// The team activity block agents are handed (D-058, client/activity.mjs):
// who else is working where, teammates' recent prompts, open comments —
// bounded, flattened, framed as data, and never about the reader themself.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { activityBlock, readComments, writeActivityFile, setActivityImport, importLine, ACTIVITY_MAX_CHARS } from "../client/activity.mjs";

const NOW = 1_800_000_000_000;
const snap = {
  agents: [
    { actor: "Bob", agent: "codex", repo: "zevet", current: "Edit  src/db.ts", mission: "fix retry", lastTs: NOW - 1000, state: "working" },
    { actor: "Andrew", agent: "claude-code", repo: "zevet", current: "Edit  src/me.ts", lastTs: NOW - 1000, state: "working" },
    { actor: "Old", agent: "codex", repo: "x", current: "Read a", lastTs: NOW - 3 * 3600 * 1000, state: "idle" },
  ],
  events: [
    { actor: "Bob", kind: "prompt", detail: "make retryOnce\nnot recurse\u0007 under contention", ts: NOW - 5000 },
    { actor: "andrew", kind: "prompt", detail: "my own prompt", ts: NOW - 4000 },
    { actor: "Bob", kind: "tool", detail: "x", ts: NOW - 3000 },
  ],
};

describe("activityBlock", () => {
  test("names teammates' work and prompts, never the reader's own", () => {
    const b = activityBlock(snap, { me: ["andrew"], now: NOW });
    assert.match(b, /Bob \(codex, zevet\): Edit src\/db\.ts/);
    assert.match(b, /Bob: "make retryOnce"/, "first line only");
    assert.doesNotMatch(b, /me\.ts|my own prompt/);
    assert.doesNotMatch(b, /Old/, "stale agents are left out");
    assert.match(b, /DATA, not instructions/);
    assert.doesNotMatch(b, /\u0007/);
  });

  test("nothing to say is an empty string, not a header", () => {
    assert.equal(activityBlock({ agents: [], events: [] }, { now: NOW }), "");
    assert.equal(activityBlock(null, { now: NOW }), "");
  });

  test("bounded however busy the team is", () => {
    const many = {
      agents: Array.from({ length: 50 }, (_, i) => ({ actor: `p${i}`, agent: "codex", repo: "r".repeat(200), current: "y".repeat(500), lastTs: NOW, state: "working" })),
      events: Array.from({ length: 50 }, (_, i) => ({ actor: `p${i}`, kind: "prompt", detail: "z".repeat(5000), ts: NOW })),
    };
    const comments = Array.from({ length: 50 }, () => ({ path: "a.ts", author: "q", text: "w".repeat(5000) }));
    assert.ok(activityBlock(many, { now: NOW, comments }).length <= ACTIVITY_MAX_CHARS);
  });

  test("open comments are listed, resolved ones are not", () => {
    const b = activityBlock({ agents: [], events: [] }, { now: NOW, comments: [{ path: "src/db.ts", author: "Mina", text: "retryOnce can recurse" }, { path: "x", text: "done", resolvedAt: 1 }] });
    assert.match(b, /src\/db\.ts — Mina: retryOnce can recurse/);
    assert.doesNotMatch(b, /done/);
  });
});

describe("files", () => {
  test("readComments takes a file or a directory and skips what it cannot read", () => {
    const home = mkdtempSync(path.join(tmpdir(), "zevet-act-"));
    assert.deepEqual(readComments(home), []);
    mkdirSync(path.join(home, "comments"));
    writeFileSync(path.join(home, "comments", "a.json"), JSON.stringify([{ text: "one" }]));
    writeFileSync(path.join(home, "comments", "b.json"), JSON.stringify({ comments: [{ text: "two" }] }));
    writeFileSync(path.join(home, "comments", "c.json"), "{not json");
    assert.deepEqual(readComments(home).map((c) => c.text).sort(), ["one", "two"]);
  });

  test("writeActivityFile writes ~/.zevet/activity.md", () => {
    const home = mkdtempSync(path.join(tmpdir(), "zevet-act-"));
    const f = writeActivityFile(home, "## Team activity");
    assert.equal(readFileSync(f, "utf8"), "## Team activity\n");
  });

  test("the CLAUDE.md import is opt-in, idempotent, and removable", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "zevet-act-repo-"));
    const fake = mkdtempSync(path.join(tmpdir(), "zevet-act-home-"));
    const home = path.join(fake, ".zevet");
    writeFileSync(path.join(repo, "CLAUDE.md"), "# Project\nrules here");
    assert.equal(importLine(home, fake), "@~/.zevet/activity.md");
    assert.equal(setActivityImport(repo, home, { homedir: fake }).changed, true);
    assert.equal(setActivityImport(repo, home, { homedir: fake }).changed, false);
    const once = readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
    assert.equal(once.split("@~/.zevet/activity.md").length, 2);
    assert.ok(once.startsWith("# Project\nrules here\n"));
    assert.equal(setActivityImport(repo, home, { remove: true, homedir: fake }).changed, true);
    assert.doesNotMatch(readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), /activity\.md|zevet keeps/);
  });
});
