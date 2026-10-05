// The gate reruns ONLY the files that failed, serially, once (scripts/run-tests.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { failingFiles } from "../scripts/run-tests-lib.mjs";

const BS = String.fromCharCode(92);
const win = (sep) => ["C:", "r", "test", "a.test.mjs"].join(sep);
const fail = (loc) => `not ok 3 - x\n  ---\n  location: '${loc}:12:3'\n  ...\n`;

test("names each failing file once, un-doubling Windows backslashes", () => {
  const tap = "ok 1 - a\n" + fail(win(BS + BS)) + fail(win(BS + BS)) + fail("/r/test/b.test.mjs");
  assert.deepEqual(failingFiles(tap), [win(BS), "/r/test/b.test.mjs"]);
});

test("nothing to rerun: all green, a failure with no file, or a mass failure", () => {
  assert.equal(failingFiles("ok 1 - a\n"), null);
  assert.equal(failingFiles("not ok 1 - hook\n  ---\n  error: boom\n"), null);
  const many = Array.from({ length: 13 }, (_, i) => fail(`/r/test/f${i}.test.mjs`)).join("");
  assert.equal(failingFiles(many), null);
});
