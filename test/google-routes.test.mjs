// The Google sign-in routes, as an open endpoint on a public hub.
//
// These two tests exist because of a specific pair of mistakes, and both are
// about the same thing: `/auth/google/start` is the only route on this hub
// that SUCCEEDS and allocates shared state at the same time.
//
//   1. `rateLimited` counts AUTH FAILURES, deliberately — `refuse()` in
//      hub/server.mjs explains why gating every request on it would lock a
//      whole office out over one typo. But a route that never fails
//      authentication is never throttled by it, so a clean address could mint
//      pair codes until the 200-entry table was full and every real teammate
//      got "too many sign-ins in flight" for ten minutes. A global ceiling is
//      not a defence when one caller can occupy all of it.
//
//   2. The callback would redeem the same `state` over and over, and each
//      attempt made this process open a real TLS connection to Google and wait
//      up to ten seconds for it — an unauthenticated caller spending OUR
//      outbound requests, once per pair code they hold.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startHub, ROOT } from "./helpers.mjs";

/* A client id is all it takes to turn the routes on; nothing here reaches
   Google, because nothing here gets as far as an exchange. */
const GOOGLE_ENV = {
  ZEVET_GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  ZEVET_GOOGLE_CLIENT_SECRET: "test-secret",
  ZEVET_GOOGLE_REDIRECT: "https://hub.invalid/auth/google/callback",
};

const hubs = [];
after(async () => {
  for (const h of hubs) await h.stop();
});

async function googleHub() {
  const h = await startHub(GOOGLE_ENV);
  hubs.push(h);
  return h;
}

const start = (base) => fetch(`${base}/auth/google/start`, { method: "POST" });

describe("starting a Google sign-in", () => {
  test("one address cannot fill the table for everybody else", async () => {
    const hub = await googleHub();

    // Eight is the per-address budget. The first eight are a person opening
    // the flow more times than anyone really does.
    const ok = [];
    for (let i = 0; i < 8; i++) ok.push(await start(hub.base).then((r) => r.status));
    assert.deepEqual(ok, Array(8).fill(200), "a normal run of starts must not be refused");

    const ninth = await start(hub.base);
    assert.equal(ninth.status, 429, "the ninth in flight from one address must be refused");
    const body = await ninth.json();
    assert.match(body.error, /from this address/, "the refusal must name the reason");

    // ⚠️ THE CAP THAT FIRED BELONGS TO THIS CALLER, not to the hub. The
    // global table is still nearly empty, so a second teammate is unaffected —
    // which is the entire difference between this and the ceiling it replaced.
  });

  test("a refused start is not an auth failure, so it cannot lock the address out", async () => {
    const hub = await googleHub();
    for (let i = 0; i < 9; i++) await start(hub.base);
    // The token-authenticated surface must still answer this address normally:
    // hitting the sign-in budget says nothing about whether you hold a token.
    const res = await fetch(`${hub.base}/healthz`);
    assert.equal(res.status, 200, "the address must not be rate limited off the hub");
  });
});

describe("redeeming a Google sign-in", () => {
  test("the pair is marked used BEFORE the outbound exchange, not after", () => {
    /* Source-asserted on purpose: proving this by driving the route would mean
       letting the hub make a real request to oauth2.googleapis.com, which is
       exactly the call this guard exists to bound. The ORDER is the whole
       property — marking after the exchange would leave the window between two
       concurrent requests wide open, which is the window an attacker uses. */
    const src = readFileSync(path.join(ROOT, "hub", "server.mjs"), "utf8");
    const guard = src.indexOf("if (pair.tried)");
    const mark = src.indexOf("pair.tried = true;");
    const exchange = src.indexOf("const ex = await exchangeCode({");
    assert.ok(guard > 0, "the already-used guard is gone");
    assert.ok(mark > 0, "nothing marks a pair as used");
    assert.ok(exchange > 0, "the exchange call moved; re-check this test");
    assert.ok(guard < mark, "the guard must come before the mark");
    assert.ok(mark < exchange, "the pair must be marked BEFORE the exchange, never after");
  });

  test("an unknown state never reaches an exchange", async () => {
    const hub = await googleHub();
    const res = await fetch(`${hub.base}/auth/google/callback?state=deadbeef&code=whatever`);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /expired or was already used/);
  });
});
