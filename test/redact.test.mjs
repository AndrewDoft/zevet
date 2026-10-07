// Client-side secret redaction (D-NEXT-W2-13). Every fixture is invented. Each
// rule gets one case that is reachable ONLY through that rule: `matchedRules`
// must name exactly it, so deleting the rule is the only way the case can
// fail, and no other rule can be covering for it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { redact, redactDeep, matchedRules, RULES } from "../client/redact.mjs";
import { ROOT } from "./helpers.mjs";

const A40 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // 36 alnum, fake
const CASES = {
  "pem-private-key": ["key:\n-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKEFAKE\nFAKEFAKE\n-----END RSA PRIVATE KEY-----\nok", "key:\n[redacted:pem-private-key]\nok"],
  "anthropic-key": ["use sk-ant-FAKEFAKEFAKE0123456789 now", "use [redacted:anthropic-key] now"],
  "openrouter-key": ["use sk-or-FAKEFAKEFAKE0123456789 now", "use [redacted:openrouter-key] now"],
  "openai-key": ["use sk-FAKEFAKEFAKE0123456789 now", "use [redacted:openai-key] now"],
  "stripe-key": ["use sk_live_FAKEFAKEFAKE0123456789 now", "use [redacted:stripe-key] now"],
  "xai-key": ["use xai-FAKEFAKEFAKE0123456789 now", "use [redacted:xai-key] now"],
  "github-token": ["use ghp_FAKEFAKEFAKE0123456789 now", "use [redacted:github-token] now"],
  "aws-access-key": ["use AKIAFAKEFAKEFAKE0123 now", "use [redacted:aws-access-key] now"],
  "google-api-key": [`use AIza${A40.slice(0, 35)} now`, "use [redacted:google-api-key] now"],
  "slack-token": ["use xoxb-1234567890-FAKE now", "use [redacted:slack-token] now"],
  jwt: ["use eyJhbGciOiJIUzI1.eyJzdWIiOiJGQUtF.c2lnbmF0dXJl now", "use [redacted:jwt] now"],
  "bearer-token": ['curl -H "Authorization: Bearer fake.opaque~value" x', 'curl -H "Authorization: Bearer [redacted:bearer-token]" x'],
  "env-secret": ["DATABASE_PASSWORD=hunter2 and more words\nPORT=3000", "DATABASE_PASSWORD=[redacted:env-secret]\nPORT=3000"],
  "credential-assignment": ["password: hunter2", "[redacted:credential-assignment]"],
};

describe("every rule, and only that rule", () => {
  for (const [name] of RULES) {
    test(name, () => {
      const [input, want] = CASES[name];
      assert.deepEqual(matchedRules(input), [name], "the fixture reaches another rule, or none");
      assert.equal(redact(input), want);
    });
  }

  test("every rule has a case", () => {
    assert.deepEqual(Object.keys(CASES).sort(), RULES.map(([n]) => n).sort());
  });

  test("the other prefixes of the same rule", () => {
    for (const t of ["gho_", "ghu_", "ghs_", "ghr_"]) assert.match(redact(`${t}FAKEFAKEFAKE0123456789`), /^\[redacted:github-token\]$/);
    assert.equal(redact("github_pat_FAKEFAKEFAKE0123456789"), "[redacted:github-token]");
    assert.equal(redact("export OPENAI_API_KEY=sk-FAKEFAKEFAKE0123456789"), "export OPENAI_API_KEY=[redacted:env-secret]");
  });
});

describe("ordinary code survives", () => {
  const keep = [
    "git checkout 0123456789abcdef0123456789abcdef01234567", // a 40-hex sha
    "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "const skip = require('skip-list'); // task-queue, ask-user, risk-model",
    "npm run test -- --grep keyboard",
    "PORT=3000 node server.js",
    "const apiUrl = process.env.API_URL;",
    "src/auth/tokenizer.ts line 40",
  ];
  for (const text of keep) test(text.slice(0, 50), () => assert.equal(redact(text), text));
});

test("non-strings pass through, and redactDeep keeps the shape", () => {
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(""), "");
  const out = redactDeep([{ content: "run with sk-FAKEFAKEFAKE0123456789", status: "pending", n: 1 }]);
  assert.deepEqual(out, [{ content: "run with [redacted:openai-key]", status: "pending", n: 1 }]);
});

test("opencode-plugin.mjs carries the same rules block as redact.mjs", () => {
  const block = (f) => {
    const s = readFileSync(path.join(ROOT, "client", f), "utf8");
    return s.slice(s.indexOf("// <redact-rules>"), s.indexOf("// </redact-rules>"));
  };
  assert.ok(block("redact.mjs").length > 500);
  assert.equal(block("opencode-plugin.mjs"), block("redact.mjs"));
});

test("the hook redacts before the event leaves the machine", async () => {
  // Real hook, real hub: what the board holds is what the hook sent.
  const { startHub, state, TOKEN } = await import("./helpers.mjs");
  const { tempDir } = await import("./helpers.mjs");
  const hub = await startHub();
  const home = tempDir("zevet-redact-home-");
  try {
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: home.dir, prompt: "deploy with ghp_FAKEFAKEFAKE0123456789 please" });
    const r = spawnSync(process.execPath, [path.join(ROOT, "client", "hook.mjs")], {
      input,
      encoding: "utf8",
      env: { ...process.env, ZEVET_HUB: hub.base, ZEVET_TOKEN: TOKEN, ZEVET_HOME: home.dir, HOME: home.dir, USERPROFILE: home.dir },
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr);
    const ev = (await state(hub.base)).body.events;
    assert.equal(ev.length, 1, `hook sent nothing: ${r.stderr}`);
    assert.equal(ev[0].detail, "deploy with [redacted:github-token] please");
  } finally {
    await hub.stop();
    home.cleanup();
  }
});
