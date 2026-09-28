// The one ZEVET_HOME lookup and the one atomic JSON writer, shared by client/ and desktop/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";
import { zevetHome, atomicWriteJson } from "../client/zevet-home.mjs";

test("zevetHome: ZEVET_HOME wins, else ~/.zevet", () => {
  assert.equal(zevetHome({ ZEVET_HOME: "/x" }, () => "/h"), "/x");
  assert.equal(zevetHome({}, () => "/h"), path.join("/h", ".zevet"));
});

test("atomicWriteJson writes formatted JSON and leaves no temp file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-home-"));
  const f = path.join(dir, "a.json");
  atomicWriteJson(f, { a: 1 });
  atomicWriteJson(f, { a: 2 });
  assert.equal(readFileSync(f, "utf8"), '{\n  "a": 2\n}\n');
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("atomicWriteJson: a failed replace throws, cleans its temp and keeps the old file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-home-"));
  const target = path.join(dir, "d");
  mkdirSync(target); // renaming a file over a directory fails
  writeFileSync(path.join(target, "keep"), "x");
  assert.throws(() => atomicWriteJson(target, { a: 1 }));
  assert.deepEqual(readdirSync(dir), ["d"]);
});

test("desktop/ loads the very same functions", () => {
  const d = createRequire(import.meta.url)("../desktop/zevet-home.js");
  assert.equal(d.zevetHome, zevetHome);
  assert.equal(d.atomicWriteJson, atomicWriteJson);
});

test("no file re-derives ZEVET_HOME by hand (opencode-plugin.mjs is copied alone, index-capability.js injects env)", () => {
  const skip = new Set(["zevet-home.mjs", "opencode-plugin.mjs", "index-capability.js"]);
  for (const dir of ["desktop", "client"]) {
    for (const f of readdirSync(path.join(ROOT, dir)).filter((n) => /\.(m?js)$/.test(n) && !skip.has(n))) {
      const src = readFileSync(path.join(ROOT, dir, f), "utf8");
      assert.doesNotMatch(src, /env\.ZEVET_HOME \|\|/, `${dir}/${f} re-derives ZEVET_HOME`);
    }
  }
});
