import test from "node:test";
import assert from "node:assert/strict";
import { sessionLabel } from "../board/src/lib/sessions.mjs";

const s = (title, extra = {}) => ({ source: "claude", id: "abc123", title, prompt: "", cwd: "C:/dev/zevet", ...extra });

test("sessionLabel strips boilerplate and keeps names short", () => {
  assert.equal(sessionLabel(s("RULES (hard): never run_in_background or Monitor — wait…\n\nTASK: fix Sentry issue MASORA-API-3S (https://sentry.io/example)")), "Sentry MASORA-API-3S");
  assert.equal(sessionLabel(s("# RESUME — you were killed mid-task\n\n# Track: Microsoft suite — sign-in, workspace creation…")), "Microsoft Suite");
  assert.equal(sessionLabel(s("Download process for Windows")), "Download process for");
  assert.equal(sessionLabel(s("Fix backfill credential revoked error")), "Fix backfill");
  assert.equal(sessionLabel(s("", { updated: Number.NaN }), []), "Zevet 00:00");
});

test("explicit labels win and are humanized", () => {
  assert.equal(sessionLabel(s("", { label: "zevet-spacing-verify" })), "Zevet Spacing Verify");
});

test("collisions use a short differentiator and remain capped", () => {
  const one = s("Resume after restart", { branch: "feature/one" });
  const two = s("Resume after restart", { branch: "feature/two" });
  const names = [sessionLabel(one, [one, two]), sessionLabel(two, [one, two])];
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => name.length <= 20));
});
