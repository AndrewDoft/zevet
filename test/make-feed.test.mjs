import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tempDir, ROOT } from "./helpers.mjs";

const { readManifest, readSignedFeed } = createRequire(import.meta.url)(path.join(ROOT, "desktop", "app-update.js"));
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
    // MAKE_FEED_SKIP_ARTIFACT_CHECK: these fixtures are a few bytes of literal
    // text, not real installers -- the artifact-integrity gate (added for the
    // masora2 corrupted-upload incident) would reject every one of them for a
    // reason unrelated to what these tests are actually checking.
    run: (extra = []) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-feed.mjs"), t.dir, "--notes", "Mac update test", ...(extra.length ? extra : ["--test-key", path.join(t.dir, "test-key.json")])], { encoding: "utf8", env: { ...process.env, ZEVET_UPDATE_SIGNING_KEY: "", MAKE_FEED_SKIP_ARTIFACT_CHECK: "1" } }),
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

test("a truncated Windows installer is refused, not hashed and published", (t) => {
  const t2 = tempDir("zevet release with spaces ");
  t.after(t2.cleanup);
  writeFileSync(path.join(t2.dir, win()), Buffer.alloc(1024, "M")); // real size floor is 20MB
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-feed.mjs"), t2.dir], { encoding: "utf8" }); // no skip env var
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /looks truncated/);
  assert.equal(existsSync(path.join(t2.dir, "zevet-latest.json")), false);
});

test("a release may still deliberately contain only the Mac artifact", (t) => {
  const r = release(t, { [mac()]: "Mac" });
  const result = r.run();
  assert.equal(result.status, 0, result.stderr);
  const feed = JSON.parse(readFileSync(r.feed, "utf8"));
  assert.deepEqual(Object.keys(feed.platforms), ["darwin-arm64"]);
});

const trustedFrom = (dir) => {
  const k = JSON.parse(readFileSync(path.join(dir, "test-key.json"), "utf8"));
  return { [k.key_id]: k.public_key };
};

test("the feed carries a signed payload that equals its legacy top-level fields", (t) => {
  const r = release(t, { [mac()]: "Mac", [win()]: "Windows" });
  assert.equal(r.run().status, 0);
  const feed = JSON.parse(readFileSync(r.feed, "utf8"));
  const signed = readSignedFeed(feed, trustedFrom(r.dir));
  assert.equal(signed.error, undefined);
  assert.equal(signed.payload.type, "zevet-update");
  assert.deepEqual({ version: feed.version, notes: feed.notes, platforms: feed.platforms },
    { version: signed.payload.version, notes: signed.payload.notes, platforms: signed.payload.platforms });
  assert.match(readSignedFeed(feed).error, /untrusted key/, "a throwaway key must not verify against the pinned keys");
});

test("without a signing key no feed is written, and the test key is never the default", (t) => {
  const r = release(t, { [mac()]: "Mac" });
  const result = r.run(["--notes", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ZEVET_UPDATE_SIGNING_KEY is not set/);
  assert.equal(existsSync(r.feed), false);
});

test("--sign-only re-signs a published feed in place, from its payload, keeping the platforms", (t) => {
  const r = release(t, { [mac()]: "Mac" });
  writeFileSync(r.feed, JSON.stringify({ version: version, notes: "old", platforms: { "darwin-arm64": { file: mac(), bytes: 3, sha256: "a".repeat(64) } } }));
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-feed.mjs"), "--sign-only", r.feed, "--test-key", path.join(r.dir, "test-key.json")], { encoding: "utf8", env: { ...process.env, ZEVET_UPDATE_SIGNING_KEY: "" } });
  assert.equal(run.status, 0, run.stderr);
  const feed = JSON.parse(readFileSync(r.feed, "utf8"));
  assert.equal(readSignedFeed(feed, trustedFrom(r.dir)).payload.notes, "old");
  assert.equal(feed.platforms["darwin-arm64"].bytes, 3);
});

test("the feed carries linux-x64 and win32-arm64 alongside the original two", (t) => {
  const files = {
    [mac()]: Buffer.from("Mac fixture bytes"),
    [win()]: Buffer.from("Windows fixture bytes"),
    [`zevet-${version}-windows-arm64-setup.exe`]: Buffer.from("Windows ARM fixture bytes"),
    [`zevet-${version}-linux-x64.AppImage`]: Buffer.from("Linux fixture bytes"),
  };
  const r = release(t, files);
  const result = r.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /incomplete/);
  const feed = JSON.parse(readFileSync(r.feed, "utf8"));
  assert.deepEqual(Object.keys(feed.platforms).sort(), ["darwin-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  assert.deepEqual(Object.keys(feed.payload.platforms).sort(), Object.keys(feed.platforms).sort());
  for (const key of Object.keys(feed.platforms)) {
    const m = readManifest(feed, key);
    assert.equal(m.error, undefined, `${key}: ${m.error}`);
    assert.equal(m.entry.sha256, createHash("sha256").update(files[m.entry.file]).digest("hex"));
  }
});
