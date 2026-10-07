// Microsoft sign-in, the client halves: the board's link flow, the desktop poller, and that the buttons and
// bridge calls exist beside GitHub and Google. Behaviour where it is cheap to drive, source assertions where
// the code only runs inside Electron or React.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";
import { linkAccount, identityLabel } from "../board/src/lib/identity.mjs";

const require = createRequire(import.meta.url);
const { GoogleSignIn } = require("../desktop/google-signin.js");
const src = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("the board links a Microsoft account through /auth/microsoft/*, never Google's routes", async () => {
  const calls = [];
  const fetchImpl = async (route, init) => {
    calls.push(route);
    if (route.endsWith("/start")) return res(200, { pairCode: "p", authUrl: "https://login.microsoftonline.com/x", interval: 1, expiresIn: 60 });
    return res(200, { ok: true, linked: true, login: "kai@contoso.example", merged: false });
  };
  const r = await linkAccount("microsoft", { fetchImpl, sleep: async () => {}, open: () => {}, onWaiting: () => {} });
  assert.deepEqual(r, { ok: true, login: "kai@contoso.example", merged: false });
  assert.deepEqual(calls, ["/auth/microsoft/start", "/auth/microsoft/finish"]);
});

test("a linked Microsoft identity is labelled as one", () => {
  assert.equal(identityLabel({ provider: "microsoft", login: "kai@contoso.example" }), "Microsoft · kai@contoso.example");
  assert.equal(identityLabel({ provider: "google", login: "a@b.c" }), "Google · a@b.c");
  assert.equal(identityLabel({ provider: "github", login: "octo" }), "GitHub · @octo");
});

test("the desktop poller talks to the hub's Microsoft routes and says Microsoft when it is off", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (url.endsWith("/start")) return res(200, { pairCode: "p", authUrl: "https://login.microsoftonline.com/x", expiresIn: 60, interval: 1 });
    return res(200, { ok: true, token: "t", secret: "s", login: "kai@contoso.example", owner: false });
  };
  const s = new GoogleSignIn({ hub: "https://hub.example", provider: "microsoft", fetchImpl, sleep: async () => {} });
  await s.start();
  const done = await s.wait();
  assert.equal(done.token, "t");
  assert.deepEqual(seen, ["https://hub.example/auth/microsoft/start", "https://hub.example/auth/microsoft/finish"]);

  const off = new GoogleSignIn({ hub: "https://hub.example", provider: "microsoft", fetchImpl: async () => res(503, {}) });
  await assert.rejects(off.start(), /Microsoft sign-in is off/);
  const dflt = new GoogleSignIn({ hub: "https://hub.example", fetchImpl: async () => res(503, {}) });
  await assert.rejects(dflt.start(), /Google sign-in is off/);
});

test("Continue-with-Microsoft is wired beside Google everywhere a person signs in", () => {
  assert.match(src("board", "src", "components", "logos.tsx"), /data-brand="microsoft"/);
  const settings = src("board", "src", "components", "settings.tsx");
  assert.match(settings, /provider="microsoft"/);
  assert.match(settings, /whoState\.microsoftSignIn/);
  assert.match(src("board", "src", "components", "identity.tsx"), /<LinkButton provider="microsoft"/);
  const setup = src("desktop", "setup.html");
  assert.match(setup, /id="microsoft"/);
  assert.match(setup, /window\.zevet\[which \+ "Start"\]/);
  const table = src("desktop", "ipc-table.js");
  const main = src("desktop", "main.js");
  for (const c of ["Start", "Wait", "Cancel", "Logout"]) {
    assert.match(table, new RegExp(`zevet:microsoft${c}`), c);
    assert.match(main, new RegExp(`zevet:microsoft${c}`), c);
  }
});
