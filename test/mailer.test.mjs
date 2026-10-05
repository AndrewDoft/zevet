// The invite mailer — a stubbed `fetch`, never a real Resend call: this file
// asserts the request/response CONTRACT (see docs/resend.md), not that
// Resend is up. The live send is exercised once, deliberately, against the
// real Masoretes team (an invite to andrew@usemasora.com) as part of shipping
// this feature — that is the one place a real network call is warranted.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sendInviteEmail } from "../hub/mailer.mjs";

const ARGS = {
  apiKey: "re_test_key",
  from: "Masora <invites@usemasora.com>",
  to: "andrew@usemasora.com",
  teamName: "Masoretes",
  key: "ABCD-EFGH",
  macUrl: "https://usemasora.com/download/Zevet.dmg",
  winUrl: "https://usemasora.com/download/Zevet-Setup.exe",
};

function ok200(id = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794") {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id }) });
}

describe("sendInviteEmail — the request it sends", () => {
  test("posts to the Resend endpoint with Bearer auth and the documented body shape", async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return ok200()();
    };
    const r = await sendInviteEmail({ ...ARGS, fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.id, "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794");

    assert.equal(seen.url, "https://api.resend.com/emails");
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers.Authorization, "Bearer re_test_key");
    assert.equal(seen.init.headers["Content-Type"], "application/json");
    const body = JSON.parse(seen.init.body);
    assert.equal(body.from, ARGS.from);
    assert.deepEqual(body.to, [ARGS.to], "`to` is an array, per docs/resend.md");
    assert.equal(body.subject, "Join Masoretes on Zevet");
    assert.match(body.html, /ABCD-EFGH/);
    assert.match(body.text, /ABCD-EFGH/);
    assert.match(body.html, /Zevet\.dmg/);
    assert.match(body.html, /Zevet-Setup\.exe/);
  });

  test("never throws, and answers false, when RESEND_API_KEY is missing", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return ok200()();
    };
    const r = await sendInviteEmail({ ...ARGS, apiKey: "", fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(called, false, "must not call Resend at all with no key");
  });

  test("a 403 (unverified sending domain) degrades to ok:false with Resend's message, not a throw", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: "The usemasora.com domain is not verified. Please, add and verify your domain.", name: "validation_error" }),
    });
    const r = await sendInviteEmail({ ...ARGS, fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.match(r.error, /not verified/);
  });

  test("a network failure (fetch rejects) is caught, not thrown", async () => {
    const fetchImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.resend.com");
    };
    const r = await sendInviteEmail({ ...ARGS, fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOTFOUND/);
  });

  test("no recipient is refused before any network call", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return ok200()();
    };
    const r = await sendInviteEmail({ ...ARGS, to: "", fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(called, false);
  });
});
