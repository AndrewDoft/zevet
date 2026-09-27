// P0 security fix: a shared team token ("authenticated but anonymous") used
// to be enough to read the board -- /api/state, /events, the ws upgrade,
// /ingest, whoami's people list. A teammate holding only that (an old
// install's config, or the anonymous default) could read everyone's name,
// prompts and tool calls without ever signing in or redeeming a key. Every
// team-scoped route now requires an actual personal session; teamFromSession
// in hub/server.mjs is the single choke point. This pins the two shapes that
// matter: shared-token-only is refused, a real session is served.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub, post, TOKEN } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const hubs = [];
after(async () => {
  await Promise.all(hubs.map((h) => h.stop()));
});

async function seededHub() {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-hub-session-"));
  const file = path.join(dir, "accounts.json");
  const seed = new Accounts({ file });
  const owner = seed.signIn({ login: "AndrewDoft", id: "1001" }); // claims the default team
  const h = await startHub({ ZEVET_ACCOUNTS: file });
  hubs.push(h);
  // startHub always sets ZEVET_TOKEN=TOKEN (an operator override), which per
  // resolveTeam wins over the secret's own derived token as the DEFAULT
  // team's shared credential -- so TOKEN, not deriveAuthToken(seed.secret),
  // is the value that actually authenticates as "shared, anonymous" here.
  return { hub: h, sessionToken: owner.token, sharedToken: TOKEN };
}

describe("team-scoped routes require a personal session, not just the shared token", () => {
  test("/api/state: shared token 401s, session 200s", async () => {
    const { hub, sessionToken, sharedToken } = await seededHub();
    const shared = await fetch(`${hub.base}/api/state`, { headers: { "x-zevet-token": sharedToken } });
    assert.equal(shared.status, 401, "a shared-token-only caller must not read the board");
    const session = await fetch(`${hub.base}/api/state`, { headers: { "x-zevet-token": sessionToken } });
    assert.equal(session.status, 200, "a real personal session must still read the board");
  });

  test("/events (SSE): shared token 401s, session 200s", async () => {
    const { hub, sessionToken, sharedToken } = await seededHub();
    const shared = await fetch(`${hub.base}/events`, { headers: { "x-zevet-token": sharedToken } });
    assert.equal(shared.status, 401);
    shared.body?.cancel();
    const session = await fetch(`${hub.base}/events`, { headers: { "x-zevet-token": sessionToken } });
    assert.equal(session.status, 200);
    session.body?.cancel();
  });

  // /ingest is deliberately EXCLUDED from the lock: client/hook.mjs derives
  // its token from the team secret, never a session (confirmed against
  // Andrew's own ~/.zevet/config.json — it carries a session for the DESKTOP
  // APP's own use, but the hook's credential is the derived secret either
  // way). Locking this route would silence every hook-only machine,
  // including his. Writing your own activity under a token only your team
  // holds is not the same leak as reading everyone else's.
  test("/ingest: both a shared token and a session are accepted (hooks have no session)", async () => {
    const { hub, sessionToken, sharedToken } = await seededHub();
    const shared = await post(hub.base, { actor: "kai", kind: "tool" }, sharedToken);
    assert.equal(shared.status, 200);
    const session = await post(hub.base, { actor: "kai", kind: "tool" }, sessionToken);
    assert.equal(session.status, 200);
  });

  test("/auth/whoami: a shared-token caller is still answered, but with no people list", async () => {
    const { hub, sessionToken, sharedToken } = await seededHub();
    const shared = await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": sharedToken } }).then((r) => r.json());
    assert.equal(shared.shared, true);
    assert.deepEqual(shared.people, [], "a shared-token caller must not see who else is on the team");
    const session = await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": sessionToken } }).then((r) => r.json());
    assert.ok(session.people.length >= 1, "a real session still sees the roster");
  });

  test("the websocket upgrade refuses a shared-token-only connection", async () => {
    const { hub, sessionToken, sharedToken } = await seededHub();
    const wsBase = hub.base.replace(/^http/, "ws");

    const denied = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(sharedToken)}`);
      ws.onopen = () => reject(new Error("a shared-token-only socket must not open"));
      ws.onerror = () => resolve(true); // the upgrade denial closes the raw socket
      ws.onclose = () => resolve(true);
    });
    assert.equal(denied, true);

    const allowed = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(sessionToken)}`);
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = (e) => reject(e instanceof Error ? e : new Error("session socket failed to open"));
    });
    assert.equal(allowed, true);
  });
});
