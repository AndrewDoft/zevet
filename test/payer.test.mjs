// Who pays (D-073): per-engine identity from fixture login files (never a real
// secret), the sealed per-session frame through a REAL hub, and the cards.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { startHub, post } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";
import * as docCrypto from "../client/doc-crypto.mjs";
import { billsLine, payerOfActor, payerOfSession } from "../board/src/lib/payer.mjs";

const require = createRequire(import.meta.url);
const { payerFor, payerBody, openPayer, applyPayerFrame } = require("../desktop/payer.js");

const key = randomBytes(32);
const TOKEN = "sk-ant-oat01-FIXTURE-NOT-A-REAL-TOKEN";
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/** A fake home with whichever login files a case needs. */
function home(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-payer-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), JSON.stringify(body));
  }
  return dir;
}
const CLAUDE = {
  ".claude/.credentials.json": { claudeAiOauth: { accessToken: TOKEN, subscriptionType: "max" } },
  ".claude.json": { oauthAccount: { emailAddress: "andrew@example.com" } },
};

describe("identity per engine, from the engine's own login files", () => {
  test("claude: email and tier, never the token", () => {
    const p = payerFor("claude", { home: home(CLAUDE), env: {} });
    assert.equal(p.label, "Claude · andrew@example.com (Max)");
    assert.equal(p.account, "andrew@example.com (Max)");
    assert.ok(!JSON.stringify(p).includes(TOKEN));
    assert.equal(payerFor("claude-code", { home: home(CLAUDE), env: {} }).label, p.label);
  });
  test("claude: tier alone, email alone, neither (unknown shows nothing)", () => {
    const tier = { ".claude/.credentials.json": CLAUDE[".claude/.credentials.json"] };
    assert.equal(payerFor("claude", { home: home(tier), env: {} }).label, "Claude · Max");
    const email = { ".claude.json": CLAUDE[".claude.json"] };
    assert.equal(payerFor("claude", { home: home(email), env: {} }).label, "Claude · andrew@example.com");
    assert.equal(payerFor("claude", { home: home({}), env: {} }).label, "");
    assert.equal(payerFor("claude", { home: home({ ".claude.json": "not an object" }), env: {} }).label, "");
  });
  test("claude: a saved credential names itself; the second Max account is not guessed", () => {
    assert.equal(payerFor("claude", { home: home(CLAUDE), env: {}, credential: "Team key" }).label, "Claude · Team key");
    assert.equal(payerFor("claude", { home: home(CLAUDE), env: {}, engine: "engine2" }).label, "");
  });
  test("codex: plan from the id_token claims, API key login, garbage", () => {
    const plus = home({ ".codex/auth.json": { tokens: { id_token: jwt({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }), access_token: TOKEN } } });
    const p = payerFor("codex", { home: plus, env: {} });
    assert.equal(p.label, "Codex · ChatGPT Plus");
    assert.ok(!JSON.stringify(p).includes(TOKEN) && !JSON.stringify(p).includes("a@b.c"));
    assert.equal(payerFor("codex", { home: home({ ".codex/auth.json": { tokens: { id_token: jwt({}) } } }), env: {} }).label, "Codex · ChatGPT");
    assert.equal(payerFor("codex", { home: home({ ".codex/auth.json": { OPENAI_API_KEY: "sk-fixture" } }), env: {} }).label, "Codex · API key");
    assert.equal(payerFor("codex", { home: home({ ".codex/auth.json": { tokens: { id_token: "garbage" } } }), env: {} }).label, "");
    assert.equal(payerFor("codex", { home: home({}), env: {} }).label, "");
  });
  test("opencode: a free model, a provider, no model", () => {
    assert.equal(payerFor("opencode", { model: "openrouter/some-model:free" }).label, "OpenCode · free model");
    assert.equal(payerFor("opencode", { model: "anthropic/claude-x" }).label, "OpenCode · anthropic");
    assert.equal(payerFor("opencode", { model: "" }).label, "");
  });
  test("zevet model, and an engine nobody knows", () => {
    assert.equal(payerFor("zevet").label, "Zevet model");
    assert.equal(payerFor("mystery").label, "");
  });
});

describe("the sealed frame", () => {
  const p = { label: "Claude · andrew@example.com (Max)", account: "andrew@example.com (Max)" };
  test("opens for its session only, under its key only, and hides the label", () => {
    const body = payerBody(docCrypto, key, "andrew", "sess-a", p);
    assert.equal(body.kind, "payer");
    assert.ok(!JSON.stringify(body).includes("andrew@example.com"));
    assert.equal(openPayer(docCrypto, key, body).label, p.label);
    assert.equal(openPayer(docCrypto, key, { ...body, session: "sess-b" }), null);
    assert.equal(openPayer(docCrypto, randomBytes(32), body), null);
  });
  test("an unknown payer is a release; the store applies, drops, skips mine, resets on hello", () => {
    assert.equal(payerBody(docCrypto, key, "andrew", "sess-a", { label: "" }).release, true);
    const store = new Map();
    const opts = { docCrypto, key, isMine: (s) => s === "sess-mine" };
    const frame = (s) => payerBody(docCrypto, key, "andrew", s, p);
    assert.equal(applyPayerFrame(store, "payer", frame("sess-a"), opts), true);
    assert.equal(applyPayerFrame(store, "payer", frame("sess-mine"), opts), false);
    assert.deepEqual([...store.values()].map((x) => x.session), ["sess-a"]);
    assert.equal(applyPayerFrame(store, "payer-release", { actor: "andrew", session: "sess-a" }, opts), true);
    assert.equal(store.size, 0);
    applyPayerFrame(store, "payer", frame("sess-a"), opts);
    applyPayerFrame(store, "hello", {}, opts);
    assert.equal(store.size, 0);
  });
});

/* ---- through a real hub --------------------------------------------------- */
const hubs = [];
const streams = [];
after(async () => {
  for (const s of streams) s.close();
  await Promise.all(hubs.map((h) => h.stop()));
});
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function channel(base, token) {
  const ctl = new AbortController();
  const frames = [];
  const res = await fetch(`${base}/events?steer=1`, { headers: { "x-zevet-token": token }, signal: ctl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const f = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const e = /^event:\s*(.+)$/m.exec(f);
          const d = /^data:\s*(.+)$/m.exec(f);
          if (e && d) frames.push({ name: e[1].trim(), data: JSON.parse(d[1]) });
        }
      }
    } catch {
      /* closed */
    }
  })();
  const s = { frames, close: () => ctl.abort() };
  streams.push(s);
  await waitFor(() => frames.some((f) => f.name === "hello"));
  return s;
}
async function team() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-payer-hub-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const andrew = seed.signIn({ login: "AndrewDoft", id: "1001" }).token;
  seed.allow("bob");
  const bob = seed.signIn({ login: "bob", id: "2002" }).token;
  const events = path.join(dir, "events.jsonl");
  const hub = await startHub({ ZEVET_ACCOUNTS: file, ZEVET_EVENTS: events });
  hubs.push(hub);
  return { hub, andrew, bob, events };
}
const label = "Claude · andrew@example.com (Max)";
const mk = (session, over = {}) => payerBody(docCrypto, key, "andrew", session, { label, account: "x", ...over });
const stateOf = (hub, token) => fetch(`${hub.base}/api/state`, { headers: { "x-zevet-token": token } }).then((r) => r.json());

describe("a teammate's card gets it through the hub, which stays blind", () => {
  test("relayed sealed to a teammate, replayed to a late joiner, gone on release", async () => {
    const { hub, bob } = await team();
    const live = await channel(hub.base, bob);
    assert.equal((await post(hub.base, mk("sess-a"))).status, 200);
    await waitFor(() => live.frames.some((f) => f.name === "payer"));
    const store = new Map();
    for (const f of live.frames) applyPayerFrame(store, f.name, f.data, { docCrypto, key });
    assert.deepEqual([...store.values()].map((x) => [x.actor, x.session, x.label]), [["andrew", "sess-a", label]]);

    const late = await channel(hub.base, bob);
    await waitFor(() => late.frames.some((f) => f.name === "payer"));

    assert.equal((await post(hub.base, payerBody(docCrypto, key, "andrew", "sess-a", null))).status, 200);
    await waitFor(() => live.frames.some((f) => f.name === "payer-release"));
    const after = await channel(hub.base, bob);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(after.frames.some((f) => f.name === "payer"), false);
  });
  test("never in clear: not on the wire, not in the log, not on the board; not an agent turn", async () => {
    const { hub, andrew, bob, events } = await team();
    const ch = await channel(hub.base, bob);
    await post(hub.base, { actor: "andrew", kind: "turn_end", repo: "zevet", session: "sess-a", agent: "claude-code", machine: "m" });
    const before = JSON.stringify((await stateOf(hub, andrew)).agents);
    await post(hub.base, mk("sess-a"));
    await waitFor(() => ch.frames.some((f) => f.name === "payer"));
    const state = await stateOf(hub, andrew);
    let log = "";
    try {
      log = readFileSync(events, "utf8");
    } catch {
      /* none yet */
    }
    for (const where of [JSON.stringify(ch.frames), JSON.stringify(state), log]) assert.ok(!where.includes("andrew@example.com"));
    assert.equal(JSON.stringify(state.agents), before, "a payer is not an agent turn");
  });
  test("must be sealed base64 for a session; anything else is refused", async () => {
    const { hub } = await team();
    const bad = [
      { kind: "payer", actor: "andrew", payer: "AAAA" },
      { kind: "payer", actor: "andrew", session: "s", payer: "not base64!" },
      { kind: "payer", actor: "andrew", session: "s", payer: "A".repeat(4000) },
      { kind: "payer", actor: "andrew", session: "s" },
    ];
    for (const b of bad) assert.equal((await post(hub.base, b)).status, 400, JSON.stringify(b).slice(0, 60));
  });
});

describe("the words on the board", () => {
  const payers = [
    { actor: "Kai", session: "s1", label: "Claude · k@x.com (Max)", account: "k@x.com (Max)" },
    { actor: "Kai", session: "s2", label: "Codex · ChatGPT Plus", account: "ChatGPT Plus" },
  ];
  test("session lookup is exact, case-blind on the person; engine lookup picks the engine's label", () => {
    assert.equal(payerOfSession(payers, "kai", "s2"), "Codex · ChatGPT Plus");
    assert.equal(payerOfSession(payers, "kai", "nope"), "");
    assert.equal(payerOfActor(payers, "Kai", "claude-code"), "Claude · k@x.com (Max)");
    assert.equal(payerOfActor(payers, "Kai", "opencode"), "");
  });
  test("billing line names whose account; unknown says nothing", () => {
    assert.equal(billsLine("Kai", "Claude · k@x.com (Max)"), "Bills Kai: Claude · k@x.com (Max)");
    assert.equal(billsLine("", "Zevet model"), "Bills you: Zevet model");
    assert.equal(billsLine("Kai", ""), "");
  });
});

describe("cards and wiring", () => {
  // Andrew, 2026-10-08: "no need for the billing stuff anywhere but settings".
  // The payer still travels (desktop + hub, below); the board just never draws it.
  test("billing is not drawn outside settings", () => {
    for (const f of ["steer.tsx", "spawn.tsx", "people.tsx", "conversation.tsx", "strip.tsx"]) {
      const src = read(`board/src/components/${f}`);
      assert.doesNotMatch(src, /PayerNote|TeamPayer|ComposerPayer|useTeammatePayer|data-payer|>Bills</, f);
    }
    assert.doesNotMatch(read("board/src/components/people.tsx"), /row\.account\]/, "rail rows name the account");
    assert.doesNotMatch(read("board/src/components/strip.tsx"), /key="cost"/, "the rail shows spend");
  });
  test("the console still carries its payer, a teammate's through the sealed store", () => {
    const board = read("board/src/lib/board.ts");
    assert.match(board, /l\.payerFor\(c\.agent, c\.model, c\.engine\)/);
    assert.match(board, /l\.sharePayer\(c\.sessionId, c\.agent, c\.model, c\.engine\)/);
  });
  test("the desktop puts the executing machine's payer on both approval cards and seals the shared one", () => {
    const main = read("desktop/main.js");
    assert.match(main, /kind: "ask"[^\n]*payer: payerOf\(String\(req\.agent \|\| ""\)\)\.label/);
    assert.match(main, /kind: "spawn-ask"[^\n]*payer: payerOf\(/);
    assert.match(main, /payerLib\.payerBody\(docCrypto, a\.key, actor, session, p\)/);
  });
});
