import test from "node:test";
import assert from "node:assert/strict";
import { sessionLabel } from "../board/src/lib/sessions.mjs";

const s = (title, extra = {}) => ({ source: "claude", id: "abc123", title, prompt: "", cwd: "C:/dev/zevet", ...extra });

test("sessionLabel strips boilerplate and keeps names short", () => {
  assert.equal(sessionLabel(s("RULES (hard): never run_in_background or Monitor — wait…")), "Never Run Background");
  assert.equal(sessionLabel(s("# RESUME — you were killed mid-task")), "Killed Mid Task");
  assert.equal(sessionLabel(s("Download process for Windows")), "Download Process");
  assert.equal(sessionLabel(s("Fix backfill credential revoked error")), "Fix Backfill");
  assert.equal(sessionLabel(s(""), []), "Zevet 19:00");
});

test("explicit labels win and are humanized", () => {
  assert.equal(sessionLabel(s("", { label: "zevet-spacing-verify" })), "Zevet Spacing Verify");
});

test("collisions use a short differentiator and remain capped", () => {
  const one = s("Resume after restart", { branch: "feature/one" });
  const two = s("Resume after restart", { branch: "feature/two" });
  const names = [sessionLabel(one, [one, two]), sessionLabel(two, [one, two])];
  assert.deepEqual(names, ["Resume Restart one", "Resume Restart two"]);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => name.length <= 20));
});
