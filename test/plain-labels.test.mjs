import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sessionLabel, sessionBlurb } from "../board/src/lib/sessions.mjs";

const src = (name) => readFileSync(new URL("../board/src/components/" + name, import.meta.url), "utf8");

test("session titles never fall back to recorded identifiers", () => {
  const id = "01a0c24e-b014-7af1-aa26-92ebc15cc60b";
  for (const label of [sessionLabel, sessionBlurb]) {
    assert.equal(label({ source: "codex", id }), "Codex session");
    assert.equal(label({ source: "codex", id, title: id }), "Codex session");
    assert.equal(label({ source: "codex", id, title: id, prompt: "Fix login" }), "Fix login");
    assert.equal(label({ source: "codex", title: "a6b8e8e", prompt: "Fix login" }), "Fix login");
    assert.equal(label({ source: "claude", id }), "Claude session");
    assert.equal(label({ source: "codex", title: "Fix UUID parsing", id }), "Fix UUID parsing");
  }
});

test("the empty pane keeps project tools behind a closed disclosure", () => {
  const detail = src("detail.tsx");
  const project = detail.match(/<details className="blank-repo">([\s\S]*?)<\/details>/)?.[1];
  assert.ok(project);
  for (const component of ["IndexSearch", "SessionsPane", "Checkpoints", "Schedules", "Memories", "CommitActivity"]) {
    assert.ok(project.includes("<" + component));
  }
  assert.ok(!detail.includes("<AgentSettings"));
  assert.ok(!detail.includes("<Readiness"));
  assert.ok(src("settings.tsx").includes("<AgentSettings />"));
  const settings = src("agentsettings.tsx");
  assert.ok(settings.includes("onSystemPromptChange={onSystemPromptChange}"));
  assert.ok(settings.includes("saveAgentSettings({ computerUse:"));
  assert.ok(!settings.includes('key: "darkTheme"'));
  assert.ok(!settings.includes('key: "agentView"'));
});

test("app chrome does not expose installation commands or backend badges", () => {
  assert.ok(!src("tree.tsx").includes("node client/install.mjs"));
  // The rail's corner is Andrew's status line, on purpose: branch, commit and
  // live on one line, cindex and graph on the next, spend below (strip.tsx).
  const strip = src("strip.tsx");
  for (const kept of ['text="cindex"', 'text="graph"', 'repo.sha', 'g.head']) assert.ok(strip.includes(kept), kept);
  const sessions = src("sessions.tsx");
  assert.ok(!sessions.includes("WHERE_LABEL"));
  assert.ok(!sessions.includes("Showing {"));
  assert.ok(!sessions.includes("open.version"));
});

test("setup uses plain results while retaining sign-in and folder actions", () => {
  const setup = readFileSync(new URL("../desktop/setup.html", import.meta.url), "utf8");
  for (const leak of ['"Connecting " + repo', '"Connected: " + repo', ' + r.detail', 'say("bad", done.error)', 'say("bad", res.why)']) assert.ok(!setup.includes(leak), leak);
  for (const action of ["githubStart(hub, createdTeam)", "googleStart(hub, createdTeam)", "window.zevet.install(repo)", "window.zevet.save("]) assert.ok(setup.includes(action), action);
  new Function(setup.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test("working label and empty-tree explanation are plain", () => {
  const conv = src("conversation.tsx");
  const tree = src("tree.tsx");
  assert.ok(!conv.includes(" is working"), "conversation shows agent-is-working phrase");
  assert.ok(!tree.includes("Shows where agents read and edit"), "tree shows explanatory empty-state text");
  assert.ok(conv.includes('label="Working"'), "conversation shows plain Working");
  assert.ok(tree.includes('"No files touched yet."'), "tree shows plain empty-state");
});

test("token counts and cost are not shown by default", () => {
  // The rail read "spent 5h 150k 7d 150k $0.16"; the composer a "$0.16" chip
  // and "5h 50%" on every run.
  // Spend stays on the rail's status corner (strip.tsx), which Andrew asked for.
  const controls = src("composercontrols.tsx");
  assert.ok(!/<span[^>]*>\{money\(usage\.cost\)\}<\/span>/.test(controls), "the cost chip is back");
  assert.match(controls, /usage\.cost != null \? money\(usage\.cost\) : null/);
  const quota = src("quota.tsx");
  assert.match(quota, /if \(used < 80\) return null;/);
  assert.match(quota, /\{used\}% of \{label\} limit/);
});
