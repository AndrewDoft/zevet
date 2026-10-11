// A subscription is used only through the vendor's own CLI; an API key is BYOK. These checks keep the
// desktop from growing back a path that reads a Claude/Codex login or speaks for it to a vendor API.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const DESKTOP = path.join(ROOT, "desktop");
const sources = readdirSync(DESKTOP)
  .filter((f) => /\.(js|mjs|cjs)$/.test(f))
  .map((f) => [f, readFileSync(path.join(DESKTOP, f), "utf8")]);
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("desktop never impersonates or reads a subscription login", () => {
  const banned = [
    [/oauth-2025/, "the Claude OAuth beta header"],
    [/anthropic-ratelimit-unified/, "plan-utilization headers read with a borrowed login"],
    [/claudeAiOauth/, "the OAuth block of Claude's credential file"],
    [/chatgpt\.com\/backend-api/, "ChatGPT's private backend"],
    [/app_EMoamEEZ/, "a borrowed OAuth client id"],
    [/sk-ant-oat/, "OAuth token handling (key-detect refuses it, in its own file)"],
  ];
  for (const [re, what] of banned) {
    test(`no ${what}`, () => {
      const hits = sources.filter(([f, s]) => f !== "key-detect.js" && re.test(code(s))).map(([f]) => f);
      assert.deepEqual(hits, []);
    });
  }
  test("no desktop module opens Claude's .credentials.json", () => {
    const hits = sources.filter(([, s]) => /(?<![\w-])\.credentials\.json/.test(code(s))).map(([f]) => f);
    assert.deepEqual(hits, []);
  });
  test("credential-usage.js stays deleted", () => {
    assert.ok(!readdirSync(DESKTOP).includes("credential-usage.js"));
  });
});

describe("the router takes a rung only when the CLI says it is signed in", () => {
  const main = code(readFileSync(path.join(DESKTOP, "main.js"), "utf8"));
  const ladder = main.slice(main.indexOf("async function zevetLadder"), main.indexOf("function startZevetConsole"));
  test("zevetLadder asks cliStatus, not the presence of an auth file", () => {
    assert.match(ladder, /cliStatus\.get\(name\)\)\.loggedIn === true/);
    assert.ok(!/signedIn\b[^=]*detect|detect\.detectAgents|loadDetect/.test(ladder));
  });
  test("the status commands are the vendors' own, read-only", () => {
    const cs = readFileSync(path.join(DESKTOP, "cli-status.js"), "utf8");
    assert.match(cs, /claude: \["auth", "status"\]/);
    assert.match(cs, /codex: \["login", "status"\]/);
  });
});
