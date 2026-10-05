// One human, one member: an operator-declared email link folds a GitHub owner and the Masora sign-in of the same person.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHub } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const SECRET = "m".repeat(40);
const dir = () => mkdtempSync(path.join(tmpdir(), "zevet-links-"));
const seed = (file) => {
  const a = new Accounts({ file });
  a.signIn({ login: "AndrewDoft", id: "82284630", display: "andrew" });
  a.signInMasora({ sub: "p1", email: "andrew@acme.test", name: "Andrew Doft", admin: true });
  return a;
};

test("linkEmail folds the duplicate into one member, keeps the history names, and is idempotent", () => {
  const file = path.join(dir(), "accounts.json");
  const a = seed(file);
  assert.equal(a.list().length, 2);
  const first = a.linkEmail("andrewdoft", "andrew@acme.test", "Andrew");
  assert.ok(first.length >= 2, first.join("|"));
  assert.equal(a.list().length, 1);
  const resolve = a.actorResolver();
  for (const old of ["andrew", "AndrewDoft", "Andrew Doft"]) assert.equal(resolve(old), "Andrew");
  assert.deepEqual(a.linkEmail("andrewdoft", "andrew@acme.test", "Andrew"), []);
  assert.equal(new Accounts({ file }).list().length, 1);
});

test("an unknown member or an unrelated email changes nothing", () => {
  const a = seed(path.join(dir(), "accounts.json"));
  assert.deepEqual(a.linkEmail("nobody", "andrew@acme.test"), []);
  a.linkEmail("andrewdoft", "someone-else@acme.test");
  assert.equal(a.list().length, 2);
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(over) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ typ: "zevet_hub_assertion", aud: "zevet-hub", iat: now, exp: now + 600, jti: Math.random().toString(36).slice(2), sub: "p1", wid: "W1", workspace: "Acme", admin: true, ...over });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

let h;
after(async () => { if (h) await h.stop(); });
test("hub: Masora sign-in of the linked person lands on the GitHub owner, not a second row", async () => {
  const file = path.join(dir(), "accounts.json");
  new Accounts({ file }).signIn({ login: "AndrewDoft", id: "82284630", display: "andrew" });
  h = await startHub({ ZEVET_ACCOUNTS: file, ZEVET_MASORA_SECRET: SECRET, ZEVET_MASORA_TEAMS: "W1=default", ZEVET_IDENTITY_LINKS: "andrewdoft=andrew@acme.test=Andrew" });
  const r = await fetch(`${h.base}/auth/masora`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion: mint({ email: "andrew@acme.test", name: "Andrew Doft" }) }) });
  const { token } = await r.json();
  const w = await fetch(`${h.base}/auth/whoami`, { headers: { "x-zevet-token": token } }).then((x) => x.json());
  assert.equal(w.people.length, 1);
  assert.equal(w.me.name, "Andrew");
});
