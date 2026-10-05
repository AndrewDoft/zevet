// "kai cant see my agents and i cant see his" (Andrew, 2026-10-05). Two members
// of one team, each posting hook events from their own machine: each one's
// board snapshot must carry the OTHER's agents (one row per session, with its
// mission and current tool), and the owner must be able to see per member when
// the hub last heard an event and last served a board — so a machine that never
// reports is visible without asking its owner.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { startHub, runScript, tempDir, ROOT } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const hubs = [];
after(async () => {
  await Promise.all(hubs.map((h) => h.stop()));
});

async function twoMembers() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-vis-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const a = seed.signIn({ login: "AndrewDoft", id: "1001" });
  seed.allow("kabbott2");
  const b = seed.signIn({ login: "kabbott2", id: "1002" });
  const hub = await startHub({ ZEVET_ACCOUNTS: file });
  hubs.push(hub);
  return { hub, a: a.token, b: b.token };
}

const send = (hub, token, body, headers = {}) =>
  fetch(`${hub.base}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": token, ...headers },
    body: JSON.stringify(body),
  });
const board = (hub, token) => fetch(`${hub.base}/api/state`, { headers: { "x-zevet-token": token } }).then((r) => r.json());
const whoami = (hub, token) => fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": token } }).then((r) => r.json());

test("each member's board shows the other member's agents, one row per session", async () => {
  const { hub, a, b } = await twoMembers();
  await send(hub, a, { actor: "AndrewDoft", machine: "andrew-pc", repo: "zevet", branch: "main", kind: "prompt", detail: "fix the hub", session: "s-andrew-1" });
  await send(hub, a, { actor: "AndrewDoft", machine: "andrew-pc", repo: "zevet", branch: "main", kind: "tool", tool: "Edit", target: "hub/server.mjs", session: "s-andrew-1" });
  await send(hub, a, { actor: "AndrewDoft", machine: "andrew-pc", repo: "zevet", branch: "main", kind: "prompt", detail: "second agent", session: "s-andrew-2" });
  await send(hub, b, { actor: "kabbott2", machine: "kai-mac", repo: "masora", branch: "kai/x", kind: "prompt", detail: "write the invoice page", session: "s-kai-1" });
  await send(hub, b, { actor: "kabbott2", machine: "kai-mac", repo: "masora", branch: "kai/x", kind: "tool", tool: "Bash", detail: "npm test", session: "s-kai-1" });

  const forKai = await board(hub, b);
  const andrews = forKai.agents.filter((x) => x.actor === "AndrewDoft");
  assert.equal(andrews.length, 2, "Kai sees both of Andrew's agents, not one merged row");
  const first = andrews.find((x) => x.session === "s-andrew-1");
  assert.equal(first.mission, "fix the hub");
  assert.equal(first.current, "Edit  hub/server.mjs");
  assert.equal(first.state, "working");

  const forAndrew = await board(hub, a);
  const kais = forAndrew.agents.filter((x) => x.actor === "kabbott2");
  assert.equal(kais.length, 1);
  assert.equal(kais[0].repo, "masora");
  assert.equal(kais[0].current, "Bash  npm test");
  assert.ok(forAndrew.roster.some((r) => r.actor === "kabbott2"), "and Kai is on Andrew's roster");
});

test("events from a hook with no session id still group by agent, repo and branch", async () => {
  const { hub, a, b } = await twoMembers();
  await send(hub, b, { actor: "kabbott2", machine: "kai-mac", repo: "masora", branch: "main", kind: "prompt", detail: "old hook" });
  const rows = (await board(hub, a)).agents.filter((x) => x.actor === "kabbott2");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mission, "old hook");
});

test("a finished turn reads finished", async () => {
  const { hub, a, b } = await twoMembers();
  await send(hub, b, { actor: "kabbott2", repo: "masora", kind: "prompt", detail: "x", session: "s1" });
  await send(hub, b, { actor: "kabbott2", repo: "masora", kind: "turn_end", session: "s1" });
  assert.equal((await board(hub, a)).agents[0].state, "finished");
});

test("the owner sees per member when an event and a board connection last arrived; a member does not see others'", async () => {
  const { hub, a, b } = await twoMembers();
  const before = (await whoami(hub, a)).people.find((p) => p.key === "kabbott2");
  assert.deepEqual(before.presence, { eventAt: null, boardAt: null, machine: "", build: "" }, "never heard from Kai");

  await send(hub, b, { actor: "kabbott2", machine: "kai-mac", kind: "prompt", detail: "hi" }, { "x-zevet-build": "0.2.116" });
  await board(hub, b);

  const kai = (await whoami(hub, a)).people.find((p) => p.key === "kabbott2");
  assert.ok(kai.presence.eventAt > 0, "last event recorded");
  assert.ok(kai.presence.boardAt > 0, "last board connection recorded");
  assert.equal(kai.presence.machine, "kai-mac");
  assert.equal(kai.presence.build, "0.2.116");

  const asKai = await whoami(hub, b);
  assert.equal(asKai.people.find((p) => p.key === "AndrewDoft".toLowerCase()).presence, undefined, "a non-owner gets no one else's presence");
  assert.ok(asKai.me.presence.eventAt > 0, "but sees their own, so the app can tell the hub has heard from this machine");
});

test("the real hook, as Kai, puts a session-tagged agent on Andrew's board and its build in the owner's view", async () => {
  const { hub, a, b } = await twoMembers();
  const r = await runScript("hook.mjs", {
    stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "from kai's hook", session_id: "sess-9", cwd: ROOT }),
    env: { ZEVET_HUB: hub.base, ZEVET_SESSION: b, ZEVET_ACTOR: "kabbott2", ZEVET_HOME: tempDir("zevet-kai-").dir, ZEVET_SECRET: "", ZEVET_TOKEN: "" },
  });
  assert.equal(r.code, 0);
  const row = (await board(hub, a)).agents.find((x) => x.session === "sess-9");
  assert.equal(row?.actor, "kabbott2");
  assert.equal(row.mission, "from kai's hook");
  const kai = (await whoami(hub, a)).people.find((p) => p.key === "kabbott2");
  assert.equal(kai.presence.build, JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
});
