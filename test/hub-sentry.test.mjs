import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initSentry } from "../hub/sentry.mjs";

test("no SENTRY_DSN: nothing is loaded, nothing is initialised", async () => {
  let loaded = false;
  const r = await initSentry({}, async () => { loaded = true; return {}; });
  assert.equal(r, null);
  assert.equal(loaded, false);
});

test("SENTRY_DSN set: the SDK is initialised with that DSN", async () => {
  const calls = [];
  const fake = { init: (o) => calls.push(o) };
  const r = await initSentry({ SENTRY_DSN: "https://k@o1.ingest.sentry.io/2" }, async () => fake);
  assert.equal(r, fake);
  assert.equal(calls[0].dsn, "https://k@o1.ingest.sentry.io/2");
  assert.equal(calls[0].sendDefaultPii, false);
});

test("@sentry/node is exact-pinned to the desktop's major, and server.mjs wires it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.dependencies["@sentry/node"], /^10\.\d+\.\d+$/);
  const server = readFileSync(new URL("../hub/server.mjs", import.meta.url), "utf8");
  assert.match(server, /await initSentry\(/);
  assert.match(server, /sentry\?\.captureException\(err\)/);
});
