// Pinned memory (D-077): a note is tied to a path and the hash the file
// had; it flips to stale when the hash moves, a person can edit or retire it,
// and the hub only ever holds ciphertext. The hub test runs a REAL hub and two
// DocSync "machines", the same arrangement doc-sync.test.mjs uses.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "./helpers.mjs";
import { deriveAuthToken, deriveDocKey } from "../client/secret.mjs";
import * as docCrypto from "../client/doc-crypto.mjs";
import { needsReview, flagText, stalePaths, staleChipText } from "../board/src/lib/memory.mjs";

const require = createRequire(import.meta.url);
const { createMemory, stalenessOf, room } = require("../desktop/pinned-memory.js");
const { DocSync } = require("../desktop/doc-sync.js");

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY = deriveDocKey(SECRET);
const SECRET_PATH = "payroll/salary-bands.ts";
const SECRET_TEXT = "bands are rounded up to the nearest 500, see hunter2";

const tmp = [];
const dirOf = () => (tmp.push(mkdtempSync(path.join(tmpdir(), "zevet-mem-"))), tmp.at(-1));
after(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

function rig() {
  const root = dirOf();
  mkdirSync(path.join(root, "payroll"));
  writeFileSync(path.join(root, SECRET_PATH), "export const bands = [1];\n");
  let t = 1000;
  const dir = dirOf();
  const mem = createMemory({ dir, docCrypto, key: KEY, now: () => ++t });
  return { root, mem, dir, file: path.join(root, SECRET_PATH) };
}

describe("staleness is computed from the file's hash", () => {
  test("a note is fresh until the file's content moves, then stale, then fresh again if it moves back", () => {
    const { root, mem, file } = rig();
    const n = mem.create({ repo: "acme", path: SECRET_PATH, text: SECRET_TEXT, root, author: "andrew" });
    assert.equal(mem.list({ repo: "acme", root })[0].stale, "fresh");
    writeFileSync(file, "export const bands = [2];\n");
    assert.equal(mem.list({ repo: "acme", root })[0].stale, "stale");
    writeFileSync(file, "export const bands = [1];\n");
    assert.equal(mem.list({ repo: "acme", root })[0].stale, "fresh");
    assert.equal(n.hash.length, 64);
  });

  test("a deleted file is flagged missing, and a note needs an existing file to be written", () => {
    const { root, mem, file } = rig();
    mem.create({ repo: "acme", path: SECRET_PATH, text: "x", root });
    rmSync(file);
    assert.equal(mem.list({ repo: "acme", root })[0].stale, "missing");
    assert.equal(mem.create({ repo: "acme", path: "nope.ts", text: "x", root }), null);
    assert.equal(stalenessOf({ hash: "a" }, "a"), "fresh");
  });

  test("the board reads stale and missing as needing review, never fresh or retired", () => {
    const notes = [
      { id: "1", path: "a", stale: "stale", retired: false },
      { id: "2", path: "b", stale: "missing", retired: false },
      { id: "3", path: "c", stale: "fresh", retired: false },
      { id: "4", path: "d", stale: "stale", retired: true },
    ];
    assert.equal(needsReview(notes).length, 2);
    assert.deepEqual([...stalePaths(notes)].sort(), ["a", "b"]);
    assert.equal(staleChipText(notes), "2 stale");
    assert.equal(staleChipText([notes[2]]), "");
    assert.equal(flagText(notes[0]), "stale");
  });
});

describe("humans edit and retire", () => {
  test("edit changes the text; re-pinning moves the hash so the flag clears", () => {
    const { root, mem, file } = rig();
    const n = mem.create({ repo: "acme", path: SECRET_PATH, text: "old", root });
    writeFileSync(file, "changed\n");
    assert.equal(mem.list({ repo: "acme", root })[0].stale, "stale");
    mem.edit(n.id, { text: "new words" });
    assert.equal(mem.list({ repo: "acme", root })[0].text, "new words");
    assert.equal(mem.list({ repo: "acme", root })[0].stale, "stale", "text alone does not re-pin");
    mem.edit(n.id, { rehash: true, root });
    assert.equal(mem.list({ repo: "acme", root })[0].stale, "fresh");
  });

  test("retire hides the note from the default list and keeps it on request", () => {
    const { root, mem } = rig();
    const n = mem.create({ repo: "acme", path: SECRET_PATH, text: "t", root });
    mem.retire(n.id);
    assert.equal(mem.list({ repo: "acme", root }).length, 0);
    assert.equal(mem.list({ repo: "acme", root, retired: true })[0].retired, true);
    assert.equal(mem.retire("no-such"), null);
  });
});

describe("only ciphertext leaves the app", () => {
  test("the note file on disk holds neither the path nor the text", () => {
    const { root, mem, dir } = rig();
    mem.create({ repo: "acme", path: SECRET_PATH, text: SECRET_TEXT, root });
    // The frames are base64, so look at the bytes they decode to, not the JSON around them.
    const raw = readdirSync(dir)
      .map((f) => Object.values(JSON.parse(readFileSync(path.join(dir, f), "utf8")).notes).map((b) => Buffer.from(b, "base64").toString("latin1")).join(""))
      .join("");
    assert.ok(raw.length > 0);
    assert.ok(!raw.includes("hunter2") && !raw.includes("salary-bands"), "plaintext on disk");
  });

  test("a note under another key does not open, and one moved to another id does not either", () => {
    const { root, mem, dir } = rig();
    const n = mem.create({ repo: "acme", path: SECRET_PATH, text: "t", root });
    const f = path.join(dir, "acme.memory.json");
    const j = JSON.parse(readFileSync(f, "utf8"));
    const wrong = createMemory({ dir, docCrypto, key: Buffer.alloc(32, 1) });
    assert.equal(wrong.list({ repo: "acme", root }).length, 0);
    writeFileSync(f, JSON.stringify({ v: 1, notes: { other: j.notes[n.id] } }));
    assert.equal(mem.list({ repo: "acme", root }).length, 0);
  });

  describe("through a real hub", () => {
    let hub;
    const syncs = [];
    before(async () => {
      hub = await startHub({ ZEVET_TOKEN: deriveAuthToken(SECRET) });
    });
    after(async () => {
      syncs.forEach((s) => s.destroy());
      await hub.stop();
    });

    test("the hub's room holds ciphertext only; a teammate opens the note and flags it from their own tree", async () => {
      const a = rig();
      const b = rig(); // a teammate's checkout of the same repo
      let sentTo;
      const mkSync = (onEvent) => {
        const s = new DocSync({ hub: hub.base, secret: SECRET, onEvent, onStatus: () => {} });
        syncs.push(s);
        return s;
      };
      let aReady;
      const aOpen = new Promise((r) => (aReady = r));
      const syncA = mkSync((r, p) => p.kind === "ready" && aReady());
      const memB = createMemory({ dir: dirOf(), docCrypto, key: KEY, now: () => 5000 });
      const got = new Promise((resolve) => {
        const syncB = mkSync((r, p) => {
          if (p.kind === "update" && memB.applyRemote(r.slice("memory:".length), p.bytes)) resolve();
        });
        syncB.join(room("acme"));
      });
      const memA = createMemory({
        dir: dirOf(), docCrypto, key: KEY, now: () => 4000,
        send: (r, bytes) => { sentTo = r; syncA.send(r, bytes); },
      });
      syncA.join(room("acme"));
      await aOpen;
      await new Promise((r) => setTimeout(r, 300)); // B's socket joins too
      memA.create({ repo: "acme", path: SECRET_PATH, text: SECRET_TEXT, root: a.root });
      await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("teammate never received the note")), 5000))]);
      assert.equal(sentTo, "memory:acme");

      assert.equal(memB.list({ repo: "acme", root: b.root })[0].text, SECRET_TEXT);
      assert.equal(memB.list({ repo: "acme", root: b.root })[0].stale, "fresh", "same file content in B's tree");
      writeFileSync(b.file, "B changed it\n");
      assert.equal(memB.list({ repo: "acme", root: b.root })[0].stale, "stale", "staleness is B's own reading of B's tree");

      // What the hub itself holds: join raw, no key.
      const frames = await new Promise((resolve, reject) => {
        const u = new URL(hub.base.replace(/^http/, "ws") + "/ws");
        u.searchParams.set("token", deriveAuthToken(SECRET));
        const ws = new WebSocket(u.toString());
        ws.binaryType = "arraybuffer";
        const out = [];
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "join", room: room("acme") })));
        ws.addEventListener("message", (ev) => { if (typeof ev.data !== "string") out.push(Buffer.from(ev.data)); });
        setTimeout(() => { ws.close(); out.length ? resolve(out) : reject(new Error("hub replayed nothing")); }, 600);
      });
      const wire = Buffer.concat(frames);
      assert.ok(!wire.includes("hunter2") && !wire.includes("salary-bands"), "the hub saw plaintext");
      assert.equal(JSON.parse(docCrypto.open(KEY, room("acme"), frames[0]).toString()).text, SECRET_TEXT, "and the key does open it");
    });
  });
});
