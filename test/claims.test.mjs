import test from "node:test";
import assert from "node:assert/strict";
import { ClaimStore, claimEnvelope } from "../client/claims.mjs";

test("claims create, broadcast, and expire on session end or timeout", () => {
  let now = 1000;
  const sent = [];
  const store = new ClaimStore({ now: () => now, broadcast: (x) => sent.push(x) });
  store.claim({ path: "src/db.ts", session: "s1", actor: "andrew" });
  assert.equal(store.isClaimed("src/db.ts"), true);
  assert.equal(sent.length, 1);
  store.endSession("s1");
  assert.equal(store.isClaimed("src/db.ts"), false);
  store.claim({ path: "src/a.ts", session: "s2", actor: "andrew", timeoutMs: 10 });
  now = 1011;
  store.expire();
  assert.equal(store.isClaimed("src/a.ts"), false);
});

test("sealed claim envelope does not contain plaintext paths", () => {
  const e = claimEnvelope({ path: "secret/file.ts", session: "s1" }, (value) => Buffer.from(JSON.stringify(value)).toString("base64"));
  assert.equal(e.type, "claim");
  assert.equal(e.path, undefined);
  assert.doesNotMatch(JSON.stringify(e), /secret\/file\.ts/);
});
