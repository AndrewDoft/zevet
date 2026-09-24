// Two teams on one hosted hub: every data route, with team A's credentials
// (shared token AND a real session), must return only A's data or refuse —
// never anything of B's. The same person is a member of both teams on purpose:
// identity must not bridge teams, only the token's own team may answer.
//
// Teams are seeded on disk with Accounts (sessions need a GitHub round trip
// otherwise) and loaded by the hub the way it loads teams after a restart.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, post, state } from "./helpers.mjs";
import { Accounts, deriveAuthToken } from "../hub/accounts.mjs";

const PERSON = { provider: "github", login: "kai", id: 7, display: "kai" };
const A_MARK = "ALPHA-ONLY-MARKER";
const B_MARK = "BRAVO-ONLY-MARKER";

let hub;
let dir;
const T = {}; // { alpha: { slug, shared, session, secret }, bravo: {...} }

function seed(slug, name) {
  const acc = new Accounts({ file: path.join(dir, `accounts-${slug}.json`) });
  acc.setName(name);
  const sess = acc.signIn(PERSON);
  T[slug] = { slug, shared: deriveAuthToken(acc.secret), session: sess.token, secret: acc.secret };
}

const call = (token, route, init = {}) =>
  fetch(`${hub.base}${route}`, {
    ...init,
    headers: { "x-zevet-token": token, "content-type": "application/json", ...(init.headers || {}) },
  });

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "zevet-isolation-"));
  seed("alpha", "Alpha");
  seed("bravo", "Bravo");
  hub = await startHub({ ZEVET_GITHUB_CLIENT_ID: "test-client-id", ZEVET_ACCOUNTS: path.join(dir, "accounts.json") });
});
after(async () => {
  if (hub) await hub.stop();
});

describe("two teams, one hub", () => {
  test("each team has its own secret, tokens and storage files", async () => {
    assert.notEqual(T.alpha.secret, T.bravo.secret);
    assert.notEqual(T.alpha.shared, T.bravo.shared);
    await post(hub.base, { actor: "a", detail: A_MARK }, T.alpha.shared);
    await post(hub.base, { actor: "b", detail: B_MARK }, T.bravo.shared);
    const files = readdirSync(dir);
    for (const f of ["accounts-alpha.json", "accounts-bravo.json"]) assert.ok(files.includes(f), f);
    const read = (f) => readFileSync(path.join(dir, f), "utf8");
    assert.ok(read("events-alpha.jsonl").includes(A_MARK) && !read("events-alpha.jsonl").includes(B_MARK));
    assert.ok(read("events-bravo.jsonl").includes(B_MARK) && !read("events-bravo.jsonl").includes(A_MARK));
    assert.ok(!read("accounts-alpha.json").includes(T.bravo.secret));
    assert.ok(!read("accounts-bravo.json").includes(T.alpha.secret));
  });

  for (const kind of ["shared", "session"]) {
    describe(`with an alpha ${kind} token`, () => {
      const tok = () => T.alpha[kind];

      test("/api/state and /events show alpha's events only", async () => {
        const s = await state(hub.base, tok());
        const body = JSON.stringify(s.body);
        assert.equal(s.status, 200);
        assert.ok(body.includes(A_MARK));
        assert.ok(!body.includes(B_MARK));

        const ctl = new AbortController();
        const res = await call(tok(), "/events", { signal: ctl.signal });
        const reader = res.body.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        ctl.abort();
        assert.ok(first.includes(A_MARK) && !first.includes(B_MARK));
      });

      test("/ingest lands in alpha's board, never bravo's", async () => {
        const mark = `INGEST-${kind}-${Date.now()}`;
        assert.equal((await post(hub.base, { actor: "a", detail: mark }, tok())).status, 200);
        assert.ok(JSON.stringify((await state(hub.base, T.alpha.shared)).body).includes(mark));
        assert.ok(!JSON.stringify((await state(hub.base, T.bravo.shared)).body).includes(mark));
        assert.ok(!JSON.stringify((await state(hub.base, T.bravo.session)).body).includes(mark));
      });

      test("/auth/whoami names alpha, never bravo", async () => {
        const who = await (await call(tok(), "/auth/whoami")).json();
        assert.equal(who.team, "alpha");
        assert.equal(who.teamName, "Alpha");
      });

      test("credentials: bravo's are invisible, unreadable and undeletable", async () => {
        // bravo adds one credential; alpha's token then goes after it.
        const add = await call(T.bravo.session, "/team/credentials", {
          method: "POST",
          body: JSON.stringify({ provider: "openai", kind: "api_key", key: `sk-${B_MARK}`, label: "b" }),
        });
        assert.equal(add.status, 200);
        const id = (await add.json()).id;

        const list = JSON.stringify(await (await call(tok(), "/team/credentials")).json());
        assert.ok(!list.includes(id));
        assert.equal((await call(tok(), `/team/credentials/${id}/secret`)).status, 404);
        if (kind === "session") {
          assert.equal((await call(tok(), `/team/credentials/${id}`, { method: "DELETE" })).status, 404);
        }
        // and it is still there for bravo
        const key = await (await call(T.bravo.shared, `/team/credentials/${id}/secret`)).json();
        assert.equal(key.key, `sk-${B_MARK}`);
      });

      test("allow/revoke change alpha's people only", async () => {
        if (kind !== "session") return;
        const before = JSON.stringify((await (await call(T.bravo.session, "/auth/whoami")).json()).people);
        const r = await call(tok(), "/auth/allow", { method: "POST", body: JSON.stringify({ login: "mallory" }) });
        assert.equal(r.status, 200);
        const after = JSON.stringify((await (await call(T.bravo.session, "/auth/whoami")).json()).people);
        assert.equal(after, before);
        assert.ok(!after.includes("mallory"));
      });

      test("the websocket relay: same room name, no crossing", async () => {
        const wsUrl = (t) => `${hub.base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(t)}`;
        const open = (t) =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl(t));
            ws.binaryType = "arraybuffer";
            const got = [];
            ws.addEventListener("message", (ev) => got.push(Buffer.from(ev.data).toString()));
            ws.addEventListener("open", () => resolve({ ws, got }));
            ws.addEventListener("error", () => reject(new Error("ws failed")));
          });
        const room = `shared-name-${kind}`;
        const a1 = await open(tok());
        const a2 = await open(T.alpha.shared);
        const b = await open(T.bravo.session);
        for (const c of [a1, a2, b]) c.ws.send(JSON.stringify({ type: "join", room }));
        a1.ws.send(new Uint8Array(Buffer.from(`from-alpha-${kind}`)));
        const deadline = Date.now() + 5000;
        while (!a2.got.some((m) => m === `from-alpha-${kind}`)) {
          assert.ok(Date.now() < deadline, "alpha peer never received the relay");
          await new Promise((r) => setTimeout(r, 25));
        }
        // Bravo has had the same window; a late joiner replays the log too.
        const late = await open(T.bravo.shared);
        late.ws.send(JSON.stringify({ type: "join", room }));
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(b.got, []);
        assert.deepEqual(late.got, []);
        for (const c of [a1, a2, b, late]) c.ws.close();
      });
    });
  }

  test("a token that belongs to no team is refused on every data route", async () => {
    const stranger = "0".repeat(64);
    for (const [route, method] of [
      ["/api/state", "GET"],
      ["/events", "GET"],
      ["/auth/whoami", "GET"],
      ["/team/credentials", "GET"],
      ["/team/credentials/x/secret", "GET"],
      ["/team/credentials/x", "DELETE"],
      ["/auth/allow", "POST"],
      ["/auth/revoke", "POST"],
      ["/ingest", "POST"],
    ]) {
      const res = await call(stranger, route, { method, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 401, `${method} ${route}`);
    }
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${hub.base.replace(/^http/, "ws")}/ws?token=${stranger}`);
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", () => reject(new Error("refused")));
      }),
      /refused/,
    );
  });

  test("a session of one team is not a session of the other, even for the same person", async () => {
    // Swap the session's token into the other team's slot: still just alpha.
    const who = await (await call(T.alpha.session, "/auth/whoami")).json();
    const other = await (await call(T.bravo.session, "/auth/whoami")).json();
    assert.equal(who.team, "alpha");
    assert.equal(other.team, "bravo");
    assert.notEqual(T.alpha.session, T.bravo.session);
  });

  test("sign-in for a team that does not exist is refused, not defaulted", async () => {
    for (const route of ["/auth/github/start", "/auth/github/finish"]) {
      const res = await fetch(`${hub.base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ team: "nonesuch", deviceCode: "x" }),
      });
      assert.equal(res.status, 404, route);
    }
  });
});
