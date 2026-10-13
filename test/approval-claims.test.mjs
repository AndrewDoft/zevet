// Once-only claim on a tool call: (run, toolUseId) executes at most once, even across restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { createApprovalClaims } = createRequire(import.meta.url)("../desktop/approval-claims.js");
const dir = mkdtempSync(path.join(tmpdir(), "zevet-claims-"));
const fresh = () => path.join(dir, `${Math.random().toString(36).slice(2)}.json`);
const req = (over = {}) => ({ tool: "Bash", arguments: { command: "ls" }, via: "claude", run: "r1", toolUseId: "toolu_1", ...over });
const counting = (answer = { ok: true }) => {
  const h = (r) => (h.n++, Promise.resolve(answer));
  h.n = 0;
  return h;
};

test("double claim: the first runs, the second is refused with the stored outcome", async () => {
  const c = createApprovalClaims(fresh());
  const h = counting();
  const gated = c.guard(h);
  assert.deepEqual(await gated(req()), { ok: true });
  const again = await gated(req());
  assert.equal(again.ok, false);
  assert.match(again.reason, /already approved/);
  assert.equal(h.n, 1);
  assert.equal((await gated(req({ toolUseId: "toolu_2" }))).ok, true, "another call is its own claim");
  assert.equal((await gated(req({ via: "codex" }))).ok, true, "another agent is its own claim");
});

test("a claim survives a restart, including one that never got an answer", async () => {
  const file = fresh();
  const a = createApprovalClaims(file);
  await a.guard(counting())(req());
  a.claim("claude", "toolu_open"); // asked, app died before the answer
  const b = createApprovalClaims(file); // "restart"
  const h = counting();
  const gated = b.guard(h);
  assert.match((await gated(req({ run: "r-after-restart" }))).reason, /already approved/);
  assert.match((await gated(req({ toolUseId: "toolu_open" }))).reason, /outcome unknown/);
  assert.equal(h.n, 0);
});

test("a denied call stays denied on retry", async () => {
  const c = createApprovalClaims(fresh());
  await c.guard(counting({ ok: false, reason: "no" }))(req());
  const h = counting();
  assert.match((await c.guard(h)(req())).reason, /already denied/);
  assert.equal(h.n, 0);
});

test("concurrent claims: exactly one executes", async () => {
  const c = createApprovalClaims(fresh());
  const h = counting();
  const gated = c.guard(h);
  const out = await Promise.all(Array.from({ length: 20 }, () => gated(req())));
  assert.equal(h.n, 1);
  assert.equal(out.filter((o) => o.ok).length, 1);
});

test("no stable id means no claim (nothing to key on)", async () => {
  const c = createApprovalClaims(fresh());
  const h = counting();
  await c.guard(h)(req({ toolUseId: "" }));
  await c.guard(h)(req({ toolUseId: "" }));
  assert.equal(h.n, 2);
});

test("an unanswered ask settles denied at the timeout; a late approval cannot flip it; a throw denies", async () => {
  const c = createApprovalClaims(fresh());
  let late;
  c.guard(() => new Promise((r) => (late = r)), 20)(req());
  await new Promise((r) => setTimeout(r, 60));
  late({ ok: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.match((await c.guard(counting())(req())).reason, /already denied/);
  await assert.rejects(c.guard(() => Promise.reject(new Error("x")))(req({ toolUseId: "toolu_t" })));
  assert.match((await c.guard(counting())(req({ toolUseId: "toolu_t" }))).reason, /already denied/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
