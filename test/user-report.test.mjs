// desktop/user-report.js: a planted secret must not survive into the Sentry payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const ur = require(path.join(ROOT, "desktop", "user-report.js"));
const HOME = "C:/Users/kai";
const KEY = "sk-ant-api03-PLANTEDsecret123456";
const PAT = "ghp_" + "a".repeat(30);

test("secrets in the typed text and the log tail are scrubbed from the payload", () => {
  const r = ur.build({
    text: `broke, key ${KEY}`,
    version: "1.2.3",
    log: `ok
Bearer abc.def-123456 ${PAT}
at ${HOME}/x.js`,
    home: HOME,
  });
  const all = JSON.stringify(r);
  for (const needle of ["PLANTED", "aaaaaaaaaa", "abc.def-123456", "kai"]) assert.ok(!all.includes(needle), `leaked ${needle}`);
  assert.equal(r.tags.source, "user-report");
  assert.equal(r.extra.version, "1.2.3");
});

test("log tail is the newest 200 lines; empty text sends nothing", () => {
  const log = Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n");
  const r = ur.build({ text: "x", log });
  assert.equal(r.extra.logTail.split("\n").length, 200);
  assert.ok(r.extra.logTail.endsWith("l999"));
  assert.equal(ur.build({ text: "  " }), null);
  const calls = [];
  assert.deepEqual(ur.send({ captureMessage: (...a) => calls.push(a) }, { text: "" }), { ok: false });
  assert.equal(calls.length, 0);
  assert.deepEqual(ur.send({ captureMessage: (...a) => calls.push(a) }, { text: "hi" }), { ok: true });
  assert.equal(calls.length, 1);
});
