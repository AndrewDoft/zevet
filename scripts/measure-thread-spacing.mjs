import { chromium } from "playwright-core";

const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const messages = () => [
  { id: "u-before", role: "user", content: [{ type: "text", text: "Before" }] },
  { id: "a-real-shape", role: "assistant", content: [
    { type: "text", text: "Checking how purge cancels pending jobs, to decide where the root fix goes." },
    { type: "tool-call", toolCallId: "tool-1", toolName: "Read", args: {}, result: "ok" },
    { type: "text", text: "Prove the test: run with fix, then without." },
    { type: "tool-call", toolCallId: "tool-2", toolName: "Bash", args: {}, result: "ok" },
    { type: "text", text: "Red without fix, green with. Gate:" },
  ] },
  { id: "u-after", role: "user", content: [{ type: "text", text: "After" }] },
];
const entry = () => ({ key: 1, id: "measure", agent: "claude", model: "", root: "C:/dev/GitHub/zevet-spacing", hue: 210, lines: [], running: false, error: null, mode: "auto", usage: {}, startedAt: Date.now(), exitCode: 0, limits: [], sessionId: "measure", slashCommands: [], transcript: { messages: messages(), openIndex: -1, toolIndex: {}, byPartId: {}, running: false } });

async function measure(name, baseline) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto("http://127.0.0.1:5173/?dev=1", { waitUntil: "networkidle" });
  await page.evaluate(({ e, baseline }) => {
    window.__zevetStore.setState({ localRoot: e.root, myConsoles: [e], activeConsole: e });
    if (baseline) { const s = document.createElement("style"); s.textContent = `[data-slot="aui_message-group"]{row-gap:1.5rem!important}[data-slot="aui_assistant-message-content"]{row-gap:0!important}`; document.head.append(s); }
  }, { e: entry(), baseline });
  await page.locator('[data-role="assistant"]').waitFor();
  const metrics = await page.evaluate(() => {
    const r = (e) => e.getBoundingClientRect(); const g = (a, b) => r(b).top - r(a).bottom;
    const a = document.querySelector('[data-role="assistant"]'); const c = a.querySelector('[data-slot="aui_assistant-message-content"]');
    const children = [...c.children].filter((e) => !e.matches('[data-slot="aui_message-error"]'));
    const tool = children.find((e) => e.querySelector('[data-slot="tool-group-root"]') || e.matches('[data-slot="tool-group-root"]'));
    const texts = children.filter((e) => e !== tool); const turns = [...document.querySelectorAll('[data-role="user"], [data-role="assistant"]')];
    return { textGaps: texts.slice(1).map((e, i) => g(texts[i], e)), textToTool: tool ? g(texts[texts.length - 1], tool) : null, turnGaps: turns.slice(1).map((e, i) => g(turns[i], e)), childTags: children.map((e) => e.tagName + "." + e.className), slots: [...a.querySelectorAll("[data-slot]")].map((e) => e.dataset.slot) };
  });
  console.log(`${name}: ${JSON.stringify(metrics)}`);
  await page.screenshot({ path: `artifacts/thread-spacing-${name}.png`, fullPage: true }); await page.close();
}
await measure("main", true); await measure("branch", false); await browser.close();
