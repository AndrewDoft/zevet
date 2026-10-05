import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const out = "artifacts/thread-spacing";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});

const cases = [
  { name: "before", turnGap: 24, partGap: 0 },
  { name: "after", turnGap: 32, partGap: 16 },
];

for (const item of cases) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.setContent(`<!doctype html><style>
    * { box-sizing: border-box; } body { margin: 0; font: 16px/1.5 system-ui; }
    #thread { width: 680px; padding: 16px; }
    #turns { display: flex; flex-direction: column; gap: ${item.turnGap}px; }
    .turn { padding: 12px; border: 1px solid #ddd; }
    .assistant-content { display: flex; flex-direction: column; gap: ${item.partGap}px; }
    p { margin: 12px 0; } p:first-child { margin-top: 0; } p:last-child { margin-bottom: 0; }
  </style><main id="thread"><div id="turns">
    <div class="turn" data-role="user">Question</div>
    <div class="turn" data-role="assistant"><div class="assistant-content"><p>Answer paragraph.</p><div>Tool group</div><p>Follow-up paragraph.</p></div></div>
    <div class="turn" data-role="user">Next question</div>
  </div></main>`);
  const metrics = await page.evaluate(() => {
    const turns = [...document.querySelectorAll(".turn")];
    const gaps = turns.slice(1).map((turn, index) => turn.getBoundingClientRect().top - turns[index].getBoundingClientRect().bottom);
    const parts = [...document.querySelector(".assistant-content").children];
    const partGaps = parts.slice(1).map((part, index) => part.getBoundingClientRect().top - parts[index].getBoundingClientRect().bottom);
    return { turnGaps: gaps, partGaps };
  });
  await page.screenshot({ path: `${out}/${item.name}.png`, fullPage: true });
  console.log(`${item.name}: ${JSON.stringify(metrics)}`);
  await page.close();
}
await browser.close();
