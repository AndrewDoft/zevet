// desktop/google-signin.js's `team` option — the counterpart to the same
// addition in github-signin.js. Only `start()` needs to carry it: the hub
// records `team` against the pairCode there, and `wait()`/`finish` identify
// the attempt by pairCode alone (see hub/server.mjs's `/auth/google/callback`
// comment on why — Google's redirect only ever carries `state`, not a body).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { GoogleSignIn } = require(path.join(ROOT, "desktop", "google-signin.js"));

function hubFetch(script) {
  let n = 0;
  return async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const answer = script(String(url), body, n++);
    return {
      status: answer.status || 200,
      ok: (answer.status || 200) < 300,
      async json() {
        return answer.body;
      },
    };
  };
}

describe("choosing a team", () => {
  test("a chosen team rides along on start", async () => {
    const bodies = [];
    const f = hubFetch((url, body) => {
      bodies.push(body);
      return { body: { ok: true, pairCode: "p".repeat(64), authUrl: "https://hub/auth/google/callback?state=p", expiresIn: 600, domain: "", team: "abc123" } };
    });
    const s = new GoogleSignIn({ hub: "http://hub", team: "abc123", fetchImpl: f });
    await s.start();
    assert.equal(bodies[0].team, "abc123");
  });

  test("no team chosen sends an empty one, not undefined — the hub then resolves the default team", async () => {
    const bodies = [];
    const f = hubFetch((url, body) => {
      bodies.push(body);
      return { body: { ok: true, pairCode: "p".repeat(64), authUrl: "https://hub/auth/google/callback?state=p", expiresIn: 600, domain: "usemasora.com" } };
    });
    const s = new GoogleSignIn({ hub: "http://hub", fetchImpl: f });
    await s.start();
    assert.equal(bodies[0].team, "");
  });
});
