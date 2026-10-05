// A teammate's agents are visible only if the hook posts and the hub accepts.
// The hook is silent about failing, so the app must notice: a hook whose script
// has gone missing is repaired (and the launch injects a working one meanwhile),
// and Settings gets ONE line when the hub rejects this machine or has not heard
// from it since an agent started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const health = require(path.join(ROOT, "desktop", "reporting-health.js"));
const { claudeHookSettings } = require(path.join(ROOT, "desktop", "agent-console.js"))._internals;

const settingsWith = (hook) => ({
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `"node" "${hook}" --zevet-hook --zevet-agent claude-code --zevet-repo "/r"` }] }] },
});

test("a marked hook is stale only when its script is gone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-rh-"));
  const real = path.join(dir, "hook.mjs");
  writeFileSync(real, "");
  assert.equal(health.hasStaleHook(settingsWith(real)), false);
  assert.equal(health.hasStaleHook(settingsWith(path.join(dir, "gone", "hook.mjs"))), true);
  assert.equal(health.hasStaleHook({ hooks: {} }), false);
});

test("launch injects a working hook when the repo's own zevet hook is dead, and not when it is fine", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-rh-"));
  const real = path.join(dir, "hook.mjs");
  writeFileSync(real, "");
  const opts = (hook) => ({ repoRoot: dir, repoSettings: settingsWith(hook), hookPath: real, nodePath: process.execPath });
  assert.equal(claudeHookSettings(opts(real)), null);
  assert.ok(claudeHookSettings(opts(path.join(dir, "gone", "hook.mjs"))), "dead hook: inject a live one");
});

test("repairStaleHooks reinstalls only the stale repos and names the ones it could not fix", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-rh-"));
  const real = path.join(dir, "hook.mjs");
  writeFileSync(real, "");
  const read = (repo) => ({ good: settingsWith(real), stale: settingsWith("/nope/hook.mjs"), stuck: settingsWith("/nope/hook.mjs"), bare: {} }[repo]);
  const installed = [];
  const failed = await health.repairStaleHooks(["good", "stale", "stuck", "bare"], {
    read,
    install: async (repo) => (installed.push(repo), { ok: repo !== "stuck" }),
  });
  assert.deepEqual(installed, ["stale", "stuck"]);
  assert.deepEqual(failed, ["stuck"]);
});

const answer = (status, body) => async () => ({ status, ok: status < 400, json: async () => body });
const ask = (fetchImpl, more = {}) => health.reportingProblem({ hub: "https://h", token: "t", fetchImpl, now: 10_000_000, ...more });

test("one line per problem, empty when healthy", async () => {
  assert.equal(await ask(answer(401, {})), "Signed out of the hub. Sign in again.");
  assert.equal(await ask(async () => { throw new Error("down"); }), "Hub not reachable.");
  assert.match(await ask(answer(200, { shared: true })), /Not signed in/);
  assert.match(await ask(answer(200, {}), { failedRepos: ["/a/b/proj"] }), /proj/);
  const fine = answer(200, { shared: false, me: { presence: { eventAt: 9_900_000 } } });
  assert.equal(await ask(fine, { agentStartedAt: 9_000_000 }), "");
});

test("an agent started minutes ago and no event since is reported; a fresh start is given grace", async () => {
  const silent = answer(200, { shared: false, me: { presence: { eventAt: null } } });
  assert.match(await ask(silent, { agentStartedAt: 9_000_000 }), /No event from this machine/);
  assert.equal(await ask(silent, { agentStartedAt: 9_950_000 }), "", "within 3 minutes: not yet");
  assert.equal(await ask(silent, { agentStartedAt: 0 }), "", "no agent started: nothing to expect");
  const old = answer(200, { shared: false, me: { presence: { eventAt: 8_000_000 } } });
  assert.match(await ask(old, { agentStartedAt: 9_000_000 }), /No event/, "an event from before this agent started does not count");
});
