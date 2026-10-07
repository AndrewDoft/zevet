// The read-only model catalogue (Settings > Agents > Models), D-083.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCatalogue, formatPrice, formatPair, formatCost, median } from "../board/src/lib/model-catalogue.mjs";
import { MODEL_PRICES, priceOf } from "../board/src/lib/model-prices.mjs";

const agents = (o = {}) => [
  { name: "claude", ok: true, signedIn: true, ...o.claude },
  { name: "codex", ok: true, signedIn: false, ...o.codex },
  { name: "opencode", ok: true, signedIn: false, ...o.opencode },
];
const byId = (rows, id) => rows.find((r) => r.id === id);

test("price file: every entry has source, as_of and numeric prices", () => {
  assert.ok(MODEL_PRICES.length > 0);
  const seen = new Set();
  for (const p of MODEL_PRICES) {
    assert.match(p.source, /^https:\/\//, p.id);
    assert.match(p.as_of, /^\d{4}-\d{2}-\d{2}$/, p.id);
    assert.ok(Number.isFinite(p.input) && Number.isFinite(p.output) && p.input >= 0 && p.output >= 0, p.id);
    assert.ok(!seen.has(p.id), "duplicate " + p.id);
    seen.add(p.id);
  }
});

test("formatting: unknown is a dash, never a guess", () => {
  assert.equal(formatPrice(undefined), "—");
  assert.equal(formatPrice(null), "—");
  assert.equal(formatPrice(0), "free");
  assert.equal(formatPrice(4), "$4");
  assert.equal(formatPrice(0.1), "$0.10");
  assert.equal(formatPair(null), "—");
  assert.equal(formatPair({ input: 4, output: 20 }), "$4 / $20");
  assert.equal(formatCost(null), "—");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(1.234), "$1.23");
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([]), null);
});

test("a model with no price entry shows no price", () => {
  assert.equal(priceOf("some-new-model"), null);
  assert.equal(priceOf("claude-haiku-4-5-20251001").input, 1);
  const rows = buildCatalogue({ agents: agents({ claude: { models: [{ id: "claude-unknown-9", name: "Unknown" }] } }) });
  assert.equal(byId(rows, "claude-unknown-9").price, null);
});

test("availability: login or credential, and the CLI present", () => {
  let rows = buildCatalogue({ agents: agents() });
  assert.equal(byId(rows, "claude-opus-5").available, true);
  assert.deepEqual(byId(rows, "claude-opus-5").payers, ["Claude login"]);
  assert.equal(byId(rows, "gpt-6-sol").available, false, "codex not signed in, no key");
  assert.equal(byId(rows, "openrouter/thinkingmachines/inkling:free").available, true);

  rows = buildCatalogue({ agents: agents({ claude: { signedIn: false } }) });
  assert.equal(byId(rows, "claude-opus-5").available, false);

  rows = buildCatalogue({ agents: agents({ claude: { ok: false }, opencode: { ok: false } }) });
  assert.equal(byId(rows, "claude-opus-5").available, false, "CLI missing");
  assert.equal(byId(rows, "openrouter/thinkingmachines/inkling:free").available, false);
});

test("payers come from credentials and carry their ladder rung", () => {
  const credentials = [
    { id: "a", scope: "personal", provider: "openai", kind: "api_key", last4: "1111" },
    { id: "b", scope: "team", provider: "openai", kind: "api_key", last4: "2222", addedBy: "kai" },
    { id: "c", scope: "personal", provider: "anthropic", kind: "subscription_token", last4: "3333" },
  ];
  const rows = buildCatalogue({ agents: agents(), credentials, ladder: [{ credentialId: "b" }, { credentialId: "a" }] });
  const sol = byId(rows, "gpt-6-sol");
  assert.deepEqual(sol.payers, ["your key …1111 · rung 2", "team key @kai …2222 · rung 1"]);
  assert.equal(sol.available, true);
  assert.deepEqual(byId(rows, "claude-opus-5").payers, ["Claude login", "your subscription …3333"]);
});

test("run median is the median cost of this board's runs on that model", () => {
  const consoles = [
    { usage: { model: "claude-opus-5", cost: 0.1 } },
    { usage: { model: "claude-opus-5", cost: 0.5 } },
    { usage: { model: "claude-opus-5", cost: 0.3 } },
    { usage: { model: "claude-sonnet-5", cost: 9 } },
    { usage: { model: null, cost: 1 } },
  ];
  const rows = buildCatalogue({ agents: agents(), consoles });
  assert.equal(byId(rows, "claude-opus-5").runMedian, 0.3);
  assert.equal(byId(rows, "claude-haiku-4-5-20251001").runMedian, null);
});

test("settings mounts the catalogue under Agents", () => {
  const s = readFileSync(new URL("../board/src/components/settings.tsx", import.meta.url), "utf8");
  assert.match(s, /<CredentialsSection \/>\s*<ModelsSection \/>/);
});
