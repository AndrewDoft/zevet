// Agent ranges, anchored comments and live prompt drafts (board/src/lib/presence*.mjs).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const lib = (f) => import(pathToFileURL(path.join(ROOT, "board", "src", "lib", f)).href);
const P = await lib("presence.mjs");
const C = await lib("presence-comments.mjs");
const D = await lib("presence-drafts.mjs");
const { AgentPresence } = await lib("presence-agents.mjs");

const req = createRequire(path.join(ROOT, "editor", "package.json"));
const Y = req("yjs");
const awarenessProtocol = req("y-protocols/awareness");

const FILE = ["function a() {", "  return 1;", "}", "", "function b() {", "  return 2;", "}", ""].join("\n");

describe("locating an agent's edit", () => {
  test("Claude Edit new_string -> its lines", () => {
    const [e] = P.extractEdits("Edit", { file_path: "/r/src/a.js", old_string: "x", new_string: "  return 2;" });
    const from = FILE.indexOf("  return 2;");
    assert.deepEqual(P.locateEdit(FILE, e.blocks), { from, to: from + 11, fromLine: 6, toLine: 6 });
  });

  test("multi-line block gives a range; a trailing newline does not add a line", () => {
    const r = P.locateBlock(FILE, "function b() {\n  return 2;\n");
    assert.equal(r.fromLine, 5);
    assert.equal(r.toLine, 6);
  });

  test("opencode newString and MultiEdit edits[]", () => {
    assert.equal(P.extractEdits("edit", { filePath: "a.js", newString: "q" })[0].blocks[0], "q");
    assert.deepEqual(P.extractEdits("MultiEdit", { file_path: "a.js", edits: [{ new_string: "a" }, { new_string: "b" }] })[0].blocks, ["a", "b"]);
  });

  test("Codex apply_patch: added blocks per file; Add File and context are ignored", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.js",
      "@@ function b() {",
      "-  return 2;",
      "+  return 2;",
      "+  // tail",
      " }",
      "*** Add File: src/new.js",
      "+whole file",
      "*** End Patch",
    ].join("\n");
    const e = P.extractEdits("apply_patch", { command: patch });
    assert.equal(e.length, 1);
    assert.equal(e[0].file, "src/a.js");
    assert.deepEqual(e[0].blocks, ["  return 2;\n  // tail"]);
    assert.equal(P.locateEdit(FILE, e[0].blocks), null, "not on disk yet in this fixture");
    const after = FILE.replace("  return 2;", "  return 2;\n  // tail");
    assert.equal(P.locateEdit(after, e[0].blocks).fromLine, 6);
    assert.equal(P.locateEdit(after, e[0].blocks).toLine, 7);
  });

  test("honest: missing, ambiguous and Write give no range", () => {
    assert.equal(P.locateBlock(FILE, "nope"), null);
    assert.equal(P.locateBlock(FILE, "}"), null, "appears twice");
    assert.deepEqual(P.extractEdits("Write", { file_path: "a.js", content: "all of it" }), []);
  });

  test("agentRanges: freshness, file match, newest wins, one per agent", () => {
    const now = 1_000_000;
    const hints = [
      { ts: now - 3000, actor: "Mina", agent: "claude-code", tool: "Edit", input: { file_path: "C:\\r\\src\\a.js", new_string: "  return 1;" } },
      { ts: now - 1000, actor: "Mina", agent: "claude-code", tool: "Edit", input: { file_path: "C:\\r\\src\\a.js", new_string: "  return 2;" } },
      { ts: now - 1000, actor: "Bob", agent: "codex", tool: "Edit", input: { file_path: "/r/src/other.js", new_string: "  return 2;" } },
      { ts: now - 60_000, actor: "Old", agent: "codex", tool: "Edit", input: { file_path: "/r/src/a.js", new_string: "  return 2;" } },
    ];
    const r = P.agentRanges(hints, "src/a.js", FILE, now);
    assert.equal(r.length, 1);
    assert.equal(r[0].actor, "Mina");
    assert.equal(r[0].fromLine, 6);
  });

  test("labels and ids", () => {
    assert.equal(P.agentLabel("Mina", "claude-code"), "Mina · Claude Code");
    assert.equal(P.agentClientId("a", "codex"), P.agentClientId("a", "codex"));
    assert.notEqual(P.agentClientId("a", "codex"), P.agentClientId("b", "codex"));
  });
});

describe("synthetic agent awareness", () => {
  test("shows a named selection over the range, then expires it", () => {
    const ydoc = new Y.Doc();
    ydoc.getText("content").insert(0, FILE);
    const awareness = new awarenessProtocol.Awareness(ydoc);
    const sent = [];
    let fire = null;
    const ap = new AgentPresence({
      Y, Awareness: awarenessProtocol.Awareness, awarenessProtocol, ydoc, awareness,
      send: (b) => sent.push(b),
      setTimeout: (f) => { fire = f; return 1; }, clearTimeout: () => {},
    });
    const id = P.agentClientId("Mina", "claude-code");
    ap.show({ actor: "Mina", agent: "claude-code", tool: "Edit", from: 15, to: 28, fromLine: 2, toLine: 2 }, "#2f6f8f");
    const st = awareness.getStates().get(id);
    assert.equal(st.user.name, "Mina · Claude Code");
    const abs = (j) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), ydoc).index;
    assert.deepEqual([abs(st.cursor.anchor), abs(st.cursor.head)], [15, 28]);
    assert.equal(sent.length, 1);

    fire(); // ~10s later
    assert.equal(awareness.getStates().has(id), false);
    assert.equal(sent.length, 2, "removal is broadcast too");
    awareness.destroy();
  });
});

describe("anchored comments", () => {
  const sync = (a, b) => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  };

  test("a concurrent edit above the anchor moves the comment with its line", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("content").insert(0, FILE);
    sync(a, b);
    const id = C.addComment(a, Y, { author: "Ann", text: "why 2?", index: FILE.indexOf("  return 2;") });
    // Bob inserts three lines at the top while Ann comments (nobody has synced yet).
    b.getText("content").insert(0, "// one\n// two\n// three\n");
    sync(a, b);
    for (const doc of [a, b]) {
      const [c] = C.listComments(doc, Y);
      assert.equal(c.id, id);
      assert.equal(c.line, 9, "line 6 became line 9");
      assert.equal(doc.getText("content").toString().split("\n")[c.line - 1], "  return 2;");
    }
  });

  test("reply, resolve, reopen replicate; unresolved export carries the line text", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("content").insert(0, FILE);
    sync(a, b);
    const id = C.addComment(a, Y, { author: "Ann", text: "why 2?", index: FILE.indexOf("  return 2;") });
    sync(a, b);
    C.replyTo(b, id, { author: "Bob", text: "spec says so" });
    sync(a, b);
    const [c] = C.listComments(a, Y);
    assert.equal(c.replies[0].text, "spec says so");
    const ex = C.exportUnresolved(C.listComments(a, Y), a.getText("content").toString(), "r:src/a.js");
    assert.equal(ex.comments[0].lineText, "  return 2;");
    assert.equal(ex.comments[0].replies[0].author, "Bob");
    C.setResolved(a, id, true);
    sync(a, b);
    assert.ok(C.listComments(b, Y)[0].resolvedAt);
    assert.equal(C.exportUnresolved(C.listComments(b, Y), "", "r").comments.length, 0);
    C.setResolved(b, id, false);
    assert.equal(C.listComments(b, Y)[0].resolvedAt, null);
  });

  test("a deleted line leaves a comment, not a lost one", () => {
    const a = new Y.Doc();
    a.getText("content").insert(0, FILE);
    C.addComment(a, Y, { author: "Ann", text: "x", index: FILE.indexOf("  return 2;") + 2 });
    a.getText("content").delete(0, FILE.length);
    const [c] = C.listComments(a, Y);
    assert.equal(c.text, "x");
  });
});

describe("live prompt drafts", () => {
  test("shared by default; hide, empty and over-long handled", () => {
    assert.equal(D.draftField({ text: "fix it", target: "Claude Code", hidden: false, now: 5 }).text, "fix it");
    assert.equal(D.draftField({ text: "secret", hidden: true }), null);
    assert.equal(D.draftField({ text: "   ", hidden: false }), null);
    assert.equal(D.draftField({ text: "x".repeat(5000), hidden: false }).text.length, D.DRAFT_MAX);
  });

  test("liveDrafts skips me, stale and draft-less peers", () => {
    const now = 100_000;
    const states = new Map([
      [1, { user: { name: "me" }, draft: { text: "mine", ts: now } }],
      [2, { user: { name: "Bob" }, draft: { text: "hi", target: "Codex", ts: now - 1000 } }],
      [3, { user: { name: "Old" }, draft: { text: "gone", ts: now - D.DRAFT_STALE_MS - 1 } }],
      [4, { user: { name: "Quiet" } }],
    ]);
    assert.deepEqual(Object.keys(D.liveDrafts(states, 1, now)), ["Bob"]);
  });
});

describe("the comments file agents read", () => {
  const { writeCommentsFile } = createRequire(import.meta.url)("../desktop/doc-sync.js");
  const data = { room: "r:src/a.js", comments: [{ id: "1", line: 6, text: "why?" }] };

  test("written under ~/.zevet/comments/<repo>/<path>.json; emptied when all are resolved", async () => {
    const { tempDir } = await import("./helpers.mjs");
    const { readFileSync, existsSync } = await import("node:fs");
    const home = tempDir("zevet-comments-").dir;
    const f = writeCommentsFile(home, "r:src/a.js", data);
    assert.equal(f, path.join(home, "comments", "r", "src", "a.js.json"));
    assert.equal(JSON.parse(readFileSync(f, "utf8")).comments[0].text, "why?");
    writeCommentsFile(home, "r:src/a.js", { comments: [] });
    assert.equal(existsSync(f), false);
  });

  test("a hostile room name cannot leave the comments directory", async () => {
    const { tempDir } = await import("./helpers.mjs");
    const home = tempDir("zevet-comments-").dir;
    for (const room of ["r:../../evil", "..:x", "r:a/../../b", "r:/abs", "r:C:\\x", "r:a\\..\\..\\b", "norepo", "r:", "r:a\0b"]) {
      assert.equal(writeCommentsFile(home, room, data), null, room);
    }
  });
});
