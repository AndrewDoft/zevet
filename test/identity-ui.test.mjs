// The agents tab, driven in a HEADLESS browser against a real hub: double-click
// your own name, type, Enter — and a teammate's board shows the new name.
//
// Skipped (reported as skipped, never as passed) where no installed Edge/Chrome
// can be launched headless; CI images without one still run everything else.
// No window is ever shown: `headless: true` only.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { startHub, tempDir, TOKEN, ROOT } from "./helpers.mjs";
import { Accounts } from "../hub/accounts.mjs";

const require = createRequire(path.join(ROOT, "package.json"));

let browser = null;
let skip = false;
try {
  const { chromium } = require("playwright-core");
  for (const channel of ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      /* try the next one */
    }
  }
  if (!browser) skip = "no headless Edge/Chrome available";
} catch {
  skip = "playwright-core is not installed";
}

const dirs = [];
let hub = null;
after(async () => {
  if (browser) await browser.close();
  if (hub) await hub.stop();
  for (const d of dirs) d.cleanup();
});

async function page(base, token, cfg) {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "zevet_session", value: token, url: base }]);
  if (cfg) await ctx.addInitScript((c) => void (window.__zevetCfg = c), cfg);
  const p = await ctx.newPage();
  await p.goto(base);
  return { p, ctx };
}

describe("renaming yourself in the agents tab", { skip }, () => {
  test("double-click your own name, Enter saves; Esc cancels; a teammate sees the new name", async () => {
    const d = tempDir();
    dirs.push(d);
    const file = path.join(d.dir, "accounts.json");
    const seed = new Accounts({ file });
    const me = seed.signIn({ provider: "github", login: "AndrewDoft", id: "1", display: "AndrewDoft" });
    seed.allow("kai");
    const kai = seed.signIn({ provider: "github", login: "kai", id: "7", display: "kai" });
    hub = await startHub({ ZEVET_ACCOUNTS: file });
    const ing = await fetch(`${hub.base}/ingest`, {
      method: "POST",
      headers: { "x-zevet-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ actor: "andrew", kind: "prompt", repo: "r", detail: "hello" }),
    });
    assert.equal(ing.status, 200);

    // This machine reports "andrew"; the signed-in person is AndrewDoft. The board tells the
    // hub the actor is theirs, so both are ONE row (it used to stay two until combined by hand).
    const mine = await page(hub.base, me.token, { actor: "andrew", login: "andrewdoft" });
    const row = mine.p.locator("button.person-row .person-row-name:visible", { hasText: /^AndrewDoft$/ }).first();
    await row.waitFor({ timeout: 15000 });

    assert.equal(await mine.p.locator("button.person-row .person-row-name:visible", { hasText: /^andrew$/ }).count(), 0, "andrew and AndrewDoft must be one person");

    // Escape cancels: nothing changes.
    await row.dblclick();
    const input = mine.p.locator("input.person-row-edit:visible");
    await input.waitFor();
    await input.fill("Nope");
    await input.press("Escape");
    await mine.p.locator("input.person-row-edit:visible").waitFor({ state: "detached" });
    assert.equal(await mine.p.locator("button.person-row .person-row-name:visible", { hasText: /^AndrewDoft$/ }).first().count(), 1);

    // A teammate's board first, so the live push is what updates it.
    const theirs = await page(hub.base, kai.token, { actor: "kai", login: "kai" });
    await theirs.p.locator(".person-row-name:visible", { hasText: /^AndrewDoft$/ }).first().waitFor({ timeout: 15000 });

    // Enter saves.
    await mine.p.locator("button.person-row .person-row-name:visible", { hasText: /^AndrewDoft$/ }).first().dblclick();
    await mine.p.locator("input.person-row-edit:visible").fill("Andrew D");
    await mine.p.locator("input.person-row-edit:visible").press("Enter");
    await mine.p.locator("button.person-row .person-row-name:visible", { hasText: /^Andrew D$/ }).first().waitFor({ timeout: 15000 });
    assert.equal(await mine.p.locator(".person-row-state", { hasText: /^you$/ }).count() >= 1, true, "still marked as you");
    await theirs.p.locator(".person-row-name:visible", { hasText: /^Andrew D$/ }).first().waitFor({ timeout: 15000 });

    // A teammate's row is not editable.
    await theirs.p.locator(".person-row-name:visible", { hasText: /^Andrew D$/ }).first().dblclick();
    assert.equal(await theirs.p.locator("input.person-row-edit:visible").count(), 0);

    // The name is the person's on the hub, not this browser's.
    const w = await (await fetch(`${hub.base}/auth/whoami`, { headers: { "x-zevet-token": kai.token } })).json();
    assert.ok(w.people.some((x) => x.login === "Andrew D"));

    await mine.ctx.close();
    await theirs.ctx.close();
  });
});

describe("the owner's Settings: combine two people, rename anyone", { skip }, () => {
  test("Combine folds a board name into a person; Rename changes a display name on the hub", async () => {
    const d = tempDir();
    dirs.push(d);
    const file = path.join(d.dir, "accounts.json");
    const seed = new Accounts({ file });
    const me = seed.signIn({ provider: "github", login: "AndrewDoft", id: "1", display: "AndrewDoft" });
    seed.allow("kai");
    seed.signIn({ provider: "github", login: "kai", id: "7", display: "kai" });
    const h = await startHub({ ZEVET_ACCOUNTS: file });
    try {
      for (const actor of ["andrew", "AndrewDoft"]) {
        await fetch(`${h.base}/ingest`, {
          method: "POST",
          headers: { "x-zevet-token": TOKEN, "content-type": "application/json" },
          body: JSON.stringify({ actor, kind: "prompt", repo: "r", detail: "hi" }),
        });
      }
      const roster = async () => (await (await fetch(`${h.base}/api/state?token=${me.token}`)).json()).roster.map((r) => r.actor);
      assert.deepEqual(await roster(), ["andrew", "AndrewDoft"]);

      const { p, ctx } = await page(h.base, me.token, { login: "andrewdoft" });
      await p.locator('button[aria-label="Settings"]').first().click();
      await p.locator("#sheet").waitFor();
      await p.locator("#sheet").getByText("Account & Team", { exact: false }).first().click();

      const combine = p.locator('input[aria-label="Name to combine"]');
      await combine.waitFor({ timeout: 15000 });
      await combine.fill("andrew");
      await combine.press("Enter");
      await p.waitForFunction(async () => (await (await fetch("/api/state", { credentials: "same-origin" })).json()).roster.length === 1, null, { timeout: 15000 });
      assert.deepEqual(await roster(), ["AndrewDoft"]);

      await p.locator('input[aria-label="New display name"]').fill("Andrew D");
      await p.locator('input[aria-label="New display name"]').press("Enter");
      await p.waitForFunction(async () => (await (await fetch("/api/state", { credentials: "same-origin" })).json()).roster.some((r) => r.actor === "Andrew D"), null, { timeout: 15000 });
      assert.deepEqual(await roster(), ["Andrew D"], "the alias must keep absorbing both old names after a rename");
      await ctx.close();
    } finally {
      await h.stop();
    }
  });
});

