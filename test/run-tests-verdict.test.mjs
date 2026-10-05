// The gate's verdict on a finished run (scripts/run-tests.mjs): cancelled is never green, but a
// cancelled suite that names its file is rerun like a failure instead of going red unretried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateVerdict } from "../scripts/run-tests-lib.mjs";

const summary = (fail, cancelled) => `# tests 10\n# pass ${10 - fail - cancelled}\n# fail ${fail}\n# cancelled ${cancelled}\n`;
const failed = (file) => `not ok 1 - suite\n  ---\n  location: '${file}:50:1'\n  failureType: 'hookFailed'\n  ...\n`;

test("a clean run is green; a summary with no cancelled line is red", () => {
  assert.deepEqual(gateVerdict(summary(0, 0), 0), { verdict: "green" });
  assert.equal(gateVerdict("# tests 10\n# pass 10\n", 0).verdict, "red");
});

test("a hook failure that cancelled tests is rerun when its file is named", () => {
  const v = gateVerdict(failed("/r/test/team-credentials.test.mjs") + summary(1, 28), 1);
  assert.deepEqual(v, { verdict: "rerun", files: ["/r/test/team-credentials.test.mjs"] });
});

test("cancelled with no file to name stays red, and says why", () => {
  const v = gateVerdict(summary(0, 3), 1);
  assert.equal(v.verdict, "red");
  assert.match(v.why, /3 tests cancelled/);
});

test("cancelled is never green, even when node exits 0", () => {
  assert.equal(gateVerdict(summary(0, 2), 0).verdict, "red");
});
