// The empty conversation's "Recent activity" card sits in the CENTRE of its
// pane, both axes, at every window size. Driven in a HEADLESS browser against
// the built board (hub/public); skipped, never passed, where none can launch.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { startHub, ROOT } from "./helpers.mjs";

const require = createRequire(path.join(ROOT, "package.json"));
let browser = null;
let skip = false;
try {
  const { chromium } = require("playwright-core");
  for (const channel of ["msedge", "chrome"]) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {}
  }
  if (!browser) skip = "no headless Edge/Chrome available";
} catch {
  skip = "playwright-core is not installed";
}
let hub = null;
after(async () => {
  if (browser) await browser.close();
  if (hub) await hub.stop();
});

describe("startup activity card", { skip }, () => {
  for (const [w, h] of [[1240, 820], [1600, 1000], [1000, 700]]) {
    test(`centred in the conversation pane at ${w}x${h}`, async () => {
      hub ??= await startHub();
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      // A desktop bridge that claims to be there and answers every call with nothing.
      await ctx.addInitScript(() => {
        const noop = () => Promise.resolve(undefined);
        window.zevetLocal = new Proxy({ available: true }, {
          get: (t, k) => (k in t ? t[k] : typeof k === "string" && /^on[A-Z]/.test(k) ? () => () => {} : noop),
        });
      });
      const p = await ctx.newPage();
      const errs = [];
      p.on("pageerror", (e) => errs.push(String(e)));
      await p.goto(hub.base);
      await p.waitForSelector(".startup-activity [data-slot=activity-graph]", { timeout: 15000 });
      const r = await p.evaluate(() => {
        const c = (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; };
        return {
          card: c(document.querySelector("[data-slot=activity-graph]")),
          pane: c(document.querySelector(".chat-thread")),
        };
      });
      const dir = path.join(tmpdir(), "zevet-startup-activity");
      mkdirSync(dir, { recursive: true });
      await p.screenshot({ path: path.join(dir, `${w}x${h}.png`) });
      await ctx.close();
      assert.deepEqual(errs, []);
      assert.ok(Math.abs(r.card.x - r.pane.x) <= 2, `x: card ${r.card.x} pane ${r.pane.x}`);
      assert.ok(Math.abs(r.card.y - r.pane.y) <= 2, `y: card ${r.card.y} pane ${r.pane.y}`);
    });
  }
});
