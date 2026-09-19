import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const { readManifest } = createRequire(import.meta.url)(path.join(ROOT, "desktop", "app-update.js"));
const { version } = JSON.parse(readFileSync(path.join(ROOT, "desktop", "package.json"), "utf8"));
const mac = (v = version) => `zevet-${v}-macos-arm64.dmg`;
const win = (v = version) => `zevet-${v}-windows-x64-setup.exe`;
const otherVersion = version === "0.0.1" ? "0.0.2" : "0.0.1";

function release(context, files) {
  const t = tempDir("zevet release with spaces ");
  context.after(t.cleanup);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(t.dir, name), body);
  return {
    dir: t.dir,
    feed: path.join(t.dir, "zevet-latest.json"),
    run: () => spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-feed.mjs"), t.dir, "--notes", "Mac update test"], { encoding: "utf8" }),
  };
}

test("the release feed advertises exact bytes accepted by both platform readers", (t) => {
  const files = { [mac()]: Buffer.from("Mac fixture bytes"), [win()]: Buffer.from("Windows fixture bytes") };
  const r = release(t, files);
  const result = r.run();
  assert.equal(result.status, 0, result.stderr);
  const feed = JSON.parse(readFileSync(r.feed, "utf8"));
  assert.equal(feed.notes, "Mac update test");
  for (const key of ["darwin-arm64", "win32-x64"]) {
    const m = readManifest(feed, key);
    assert.equal(m.error, undefined);
    const body = files[m.entry.file];
    assert.equal(m.entry.bytes, body.length);
    assert.equal(m.entry.sha256, createHash("sha256").update(body).digest("hex"));
  }
});

test("a stale second Mac version aborts without overwriting an existing feed", (t) => {
  const r = release(t, { [mac()]: "new Mac", [mac(otherVersion)]: "old Mac", [win()]: "Windows" });
  writeFileSync(r.feed, "previous feed");
  const result = r.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple artifacts for darwin-arm64/);
  assert.equal(readFileSync(r.feed, "utf8"), "previous feed");
});

test("different platform versions cannot publish a mixed release", (t) => {
  const r = release(t, { [mac()]: "Mac", [win(otherVersion)]: "Windows" });
  const result = r.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifacts disagree/);
  assert.equal(existsSync(r.feed), false);
});

test("an empty Mac artifact cannot produce a feed", (t) => {
  const r = release(t, { [mac()]: "" });
  const result = r.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no usable size/);
  assert.equal(existsSync(r.feed), false);
});

test("a release may still deliberately contain only the Mac artifact", (t) => {
  const r = release(t, { [mac()]: "Mac" });
  const result = r.run();
  assert.equal(result.status, 0, result.stderr);
  const feed = JSON.parse(readFileSync(r.feed, "utf8"));
  assert.deepEqual(Object.keys(feed.platforms), ["darwin-arm64"]);
});
