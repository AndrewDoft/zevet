// Pushing agent sessions to Masora (T5, C1): building a C1 record from what
// desktop/agent-sessions.js already reads, the durable outbox, and the
// cursor that keeps a re-run from re-sending an unchanged session.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const home = tempDir("zevet-masora-push-");
process.env.ZEVET_HOME = home.dir;

const require = createRequire(import.meta.url);
const push = require(path.join(ROOT, "desktop", "masora-push.js"));

describe("summarize: transcript text and files touched from agent-sessions.js records", () => {
  test("claude: joins HUMAN/ASSISTANT turns and collects Edit/Write file_path", () => {
    const records = [
      { source: "claude", type: "user", message: { content: "fix the pairing flow" } },
      {
        source: "claude", type: "assistant",
        message: {
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", name: "Edit", input: { file_path: "desktop/main.js" } },
            { type: "tool_use", name: "Read", input: { file_path: "desktop/masora.js" } },
          ],
        },
      },
    ];
    const { contentText, filesTouched } = push.summarize(records);
    assert.equal(contentText, "[HUMAN]: fix the pairing flow\n[ASSISTANT]: On it.");
    // Read is not an edit tool -- only Edit/Write/MultiEdit/NotebookEdit count.
    assert.deepEqual(filesTouched, ["desktop/main.js"]);
  });

  test("codex: user_message/agent_message items become HUMAN/ASSISTANT turns", () => {
    const records = [
      { source: "codex", item: { type: "user_message", text: "add pairing" } },
      { source: "codex", item: { type: "agent_message", text: "done" } },
      { source: "codex", item: { type: "reasoning", text: "thinking, not a turn" } },
    ];
    const { contentText } = push.summarize(records);
    assert.equal(contentText, "[HUMAN]: add pairing\n[ASSISTANT]: done");
  });

  test("a tool-only turn (no text block) contributes no HUMAN/ASSISTANT line", () => {
    const records = [
      { source: "claude", type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } },
    ];
    assert.equal(push.summarize(records).contentText, "");
  });

  test("content_text is capped at 200 KB, same limit the server enforces", () => {
    const records = [{ source: "claude", type: "user", message: { content: "x".repeat(300_000) } }];
    const { contentText } = push.summarize(records);
    assert.ok(Buffer.byteLength(contentText, "utf8") <= push.CONTENT_TEXT_MAX_BYTES);
  });
});

describe("toRecord: the C1 shape", () => {
  test("matches docs/contracts/cross_app_context.md's record fields exactly", async () => {
    const summary = {
      source: "claude", slug: "c--dev-github-zevet", id: "sess-1",
      title: "Fix the pairing flow", started: 1758500000000, updated: 1758500100000,
    };
    const records = [{ source: "claude", type: "user", message: { content: "hello" } }];
    const record = await push.toRecord(summary, records, "AndrewDoft/zevet");
    assert.deepEqual(Object.keys(record).sort(), [
      "agent", "content_text", "created_at", "external_id", "files_touched",
      "participants", "repository", "surface", "title", "updated_at",
    ].sort());
    assert.equal(record.surface, "zevet");
    assert.equal(record.external_id, "zevet:session:claude:c--dev-github-zevet:sess-1");
    assert.equal(record.repository, "AndrewDoft/zevet");
    assert.equal(record.agent, "claude");
    assert.match(record.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("codex sessions are tagged agent: codex", async () => {
    const summary = { source: "codex", slug: "s", id: "1", title: "t", started: 1, updated: 2 };
    const record = await push.toRecord(summary, [], "o/n");
    assert.equal(record.agent, "codex");
  });
});

describe("the outbox: durable retry", () => {
  test("append/read/remove round-trips, and remove only drops the front", () => {
    push.appendOutbox([{ a: 1 }, { a: 2 }]);
    assert.deepEqual(push.readOutbox(), [{ a: 1 }, { a: 2 }]);
    push.appendOutbox([{ a: 3 }]);
    assert.deepEqual(push.readOutbox(), [{ a: 1 }, { a: 2 }, { a: 3 }]);
    push.removeFromOutbox(2);
    assert.deepEqual(push.readOutbox(), [{ a: 3 }]);
  });

  test("flushOutbox removes only what the server actually 202'd, and stops on the first failure", async () => {
    push.removeFromOutbox(push.readOutbox().length); // start clean
    push.appendOutbox([{ n: 1 }, { n: 2 }]);
    const seen = [];
    let call = 0;
    const f = async (url, init) => {
      assert.match(String(url), /\/api\/connector\/ingest$/);
      assert.equal(init.headers.authorization, "Bearer tok");
      const body = zlib.gunzipSync(init.body).toString("utf8");
      seen.push(body.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
      call += 1;
      return { status: call === 1 ? 202 : 500 };
    };
    const { sent } = await push.flushOutbox({ baseUrl: "https://m", token: "tok", fetchImpl: f });
    // BATCH_SIZE is 50, so both fit in one batch and one call is all this needs.
    assert.equal(sent, 2);
    assert.deepEqual(push.readOutbox(), []);
    assert.deepEqual(seen[0], [{ n: 1 }, { n: 2 }]);
  });

  test("a network error leaves the outbox untouched for the next cycle", async () => {
    push.removeFromOutbox(push.readOutbox().length);
    push.appendOutbox([{ n: "keep-me" }]);
    const { sent } = await push.flushOutbox({
      baseUrl: "https://m", token: "t",
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal(sent, 0);
    assert.deepEqual(push.readOutbox(), [{ n: "keep-me" }]);
    push.removeFromOutbox(push.readOutbox().length);
  });
});

describe("runOnce: only changed sessions are ever queued", () => {
  const summary = {
    source: "claude", slug: "s", id: "sess-a", cwd: "/repo",
    title: "t1", started: 1000, updated: 1000,
  };
  function fakeSessions(current) {
    return {
      listSessions: () => ({ sessions: [current] }),
      readSession: () => ({ records: [{ source: "claude", type: "user", message: { content: "hi" } }] }),
    };
  }

  const acceptAll = async () => ({ status: 202 });

  test("a never-seen session is queued and flushed", async () => {
    let posted = 0;
    const f = async (...a) => { posted += 1; return acceptAll(...a); };
    const r = await push.runOnce({
      repos: { "/repo": true }, baseUrl: "https://m", token: "tok", fetchImpl: f,
      ...fakeSessions(summary),
    });
    assert.equal(r.queued, 1);
    assert.equal(r.sent, 1);
    assert.equal(posted, 1);
    assert.deepEqual(push.readOutbox(), []);
  });

  test("re-running with the SAME updated timestamp queues nothing", async () => {
    const r = await push.runOnce({
      repos: { "/repo": true }, baseUrl: "https://m", token: "tok", fetchImpl: acceptAll,
      ...fakeSessions(summary),
    });
    assert.equal(r.queued, 0);
  });

  test("a session whose `updated` moved forward is queued again", async () => {
    const moved = { ...summary, updated: 2000 };
    const r = await push.runOnce({
      repos: { "/repo": true }, baseUrl: "https://m", token: "tok", fetchImpl: acceptAll,
      ...fakeSessions(moved),
    });
    assert.equal(r.queued, 1);
  });

  test("a repo not in the opt-in map is never read at all", async () => {
    const r = await push.runOnce({
      repos: {}, baseUrl: "https://m", token: "tok", fetchImpl: acceptAll,
      listSessions: () => { throw new Error("must not be called"); },
      readSession: () => { throw new Error("must not be called"); },
    });
    assert.equal(r.queued, 0);
  });
});

describe("deriveRepository: owner/name from git, folder name otherwise", () => {
  test("reads owner/name off an HTTPS remote", async () => {
    const dir = tempDir("zevet-masora-repo-");
    execFileSync("git", ["init", "-q", dir.dir]);
    execFileSync("git", ["-C", dir.dir, "remote", "add", "origin", "https://github.com/AndrewDoft/zevet.git"]);
    assert.equal(await push.deriveRepository(dir.dir), "AndrewDoft/zevet");
    dir.cleanup();
  });

  test("reads owner/name off an SSH remote", async () => {
    const dir = tempDir("zevet-masora-repo-");
    execFileSync("git", ["init", "-q", dir.dir]);
    execFileSync("git", ["-C", dir.dir, "remote", "add", "origin", "git@github.com:AndrewDoft/zevet.git"]);
    assert.equal(await push.deriveRepository(dir.dir), "AndrewDoft/zevet");
    dir.cleanup();
  });

  test("falls back to the folder name when there is no remote (C1: '<owner/name or folder>')", async () => {
    const dir = tempDir("zevet-masora-repo-");
    execFileSync("git", ["init", "-q", dir.dir]);
    assert.equal(await push.deriveRepository(dir.dir), path.basename(dir.dir));
    dir.cleanup();
  });

  test("falls back to the folder name when the folder is not a git repo at all", async () => {
    const dir = tempDir("zevet-masora-notrepo-");
    mkdirSync(path.join(dir.dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir.dir, "file.txt"), "x");
    assert.equal(await push.deriveRepository(dir.dir), path.basename(dir.dir));
    dir.cleanup();
  });
});
