// Per-team retention (D-NEXT-W2-13): the owner picks how long prompt and
// command text lives, and the hub's existing compaction enforces it — on the
// served board and in the event log file, now, not at the next boot.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, state } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const DAY = 864e5;
const dirs = [];
const hubs = [];
after(async () => {
  await Promise.all(hubs.map((h) => h.stop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A hub whose log holds one 3-day-old and one fresh event, both with text. */
async function team() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-retention-"));
  dirs.push(dir);
  const seed = new Accounts({ file: path.join(dir, "accounts.json") });
  const owner = seed.signIn({ login: "AndrewDoft", id: "1001" }).token;
  seed.allow("bob");
  const bob = seed.signIn({ login: "bob", id: "2002" }).token;
  const log = path.join(dir, "events.jsonl");
  const e = (id, ts, detail) => JSON.stringify({ id, ts, actor: "bob", repo: "r", kind: "prompt", tool: "", target: null, detail, agent: "claude-code", session: "s" });
  writeFileSync(log, `${e("old", Date.now() - 3 * DAY, "old words")}\n${e("new", Date.now(), "new words")}\n`);
  const hub = await startHub({ ZEVET_ACCOUNTS: path.join(dir, "accounts.json"), ZEVET_EVENTS: log });
  hubs.push(hub);
  return { hub, owner, bob, log };
}

const put = (base, token, body) =>
  fetch(`${base}/api/policy`, { method: "PUT", headers: { "content-type": "application/json", "x-zevet-token": token }, body: JSON.stringify(body) });
const details = async (hub, token) => (await state(hub.base, token)).body.events.map((x) => x.detail);

describe("team retention", () => {
  test("default keeps everything", async () => {
    const { hub, bob } = await team();
    assert.deepEqual(await details(hub, bob), ["old words", "new words"]);
    const p = await fetch(`${hub.base}/api/policy`, { headers: { "x-zevet-token": bob } }).then((r) => r.json());
    assert.equal(p.policy.retention, "forever");
  });

  test("the owner setting 1d blanks old text on the board and in the log, now", async () => {
    const { hub, owner, bob, log } = await team();
    const r = await put(hub.base, owner, { retention: "1d" });
    assert.equal(r.status, 200);
    assert.deepEqual(await details(hub, bob), ["", "new words"]);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.detail), ["", "new words"], "the file was not compacted");
    assert.equal(lines[0].actor, "bob", "structure was trimmed with the words");
  });

  test("a longer window keeps what a shorter one would drop", async () => {
    const { hub, owner, bob } = await team();
    assert.equal((await put(hub.base, owner, { retention: "7d" })).status, 200);
    assert.deepEqual(await details(hub, bob), ["old words", "new words"]);
  });

  test("a member cannot change it, and nothing is blanked", async () => {
    const { hub, bob } = await team();
    const r = await put(hub.base, bob, { retention: "1d" });
    assert.equal(r.status, 403);
    assert.deepEqual(await details(hub, bob), ["old words", "new words"]);
  });

  test("an unknown window is refused", async () => {
    const { hub, owner } = await team();
    assert.equal((await put(hub.base, owner, { retention: "5m" })).status, 400);
  });
});
