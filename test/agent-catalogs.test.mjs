// The CLIs' cached model lists, read by ONE module for both the generator
// (board/scripts/sync-agent-models.mjs) and the running app (main.js
// `local:agents`).
//
// ⚠️ WHY THIS EXISTS. Several claude catalogue files coexist — "cc" for Claude
// Code, "ccd" for the desktop app — and each is refreshed on its own clock.
// The reader used to keep whichever "cc" file it read last, which is directory
// order, not age; Opus 5.5 sat in the fresh file and the picker never showed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { claudeModels, codexModels } = require(path.join(ROOT, "desktop", "agent-catalogs.js"));

function home(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-catalogs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function claudeFile(dir, name, surface, fetchedAt, ids) {
  mkdirSync(path.join(dir, ".claude", "cache", "model-catalog"), { recursive: true });
  const models = ids.map((id) =>
    typeof id === "string" ? { id, name: `Name ${id}`, description: "d", section: "main" } : id,
  );
  writeFileSync(
    path.join(dir, ".claude", "cache", "model-catalog", name),
    JSON.stringify({ version: 2, fetchedAt, catalog: { surface, config: { models } } }),
  );
}

test("the newest Claude Code catalogue wins, whatever order the directory lists them in", (t) => {
  const h = home(t);
  // Named so the stale one sorts LAST — a last-wins reader would pick it.
  claudeFile(h, "a-cc.json", "cc", 2000, ["claude-opus-5-5", "claude-opus-5"]);
  claudeFile(h, "z-cc.json", "cc", 1000, ["claude-opus-5"]);
  claudeFile(h, "b-ccd.json", "ccd", 3000, ["claude-opus-5", "claude-opus-4-8"]);
  assert.deepEqual(
    claudeModels(h).map((m) => m.id),
    ["claude-opus-5-5", "claude-opus-5"],
  );
});

test("a fresher desktop catalogue never outranks Claude Code's own", (t) => {
  const h = home(t);
  claudeFile(h, "x-ccd.json", "ccd", 9000, ["claude-opus-4-8"]);
  claudeFile(h, "y-cc.json", "cc", 1, ["claude-opus-5"]);
  assert.deepEqual(claudeModels(h).map((m) => m.id), ["claude-opus-5"]);
});

test("a file without its own timestamp is ranked by mtime, and the overflow drawer is left out", (t) => {
  const h = home(t);
  claudeFile(h, "only-ccd.json", "ccd", undefined, [
    { id: "claude-opus-5", name: "Opus 5", description: "For complex tasks", section: "main" },
    { id: "claude-opus-4-6", name: "Opus 4.6", section: "overflow" },
    { name: "no id at all" },
  ]);
  assert.deepEqual(claudeModels(h), [{ id: "claude-opus-5", name: "Opus 5", note: "For complex tasks" }]);
});

test("no cache is null, not an empty list", (t) => {
  const h = home(t);
  assert.equal(claudeModels(h), null);
  assert.equal(codexModels(h), null);
  mkdirSync(path.join(h, ".claude", "cache", "model-catalog"), { recursive: true });
  writeFileSync(path.join(h, ".claude", "cache", "model-catalog", "half-cc.json"), "{\"catalog\":");
  assert.equal(claudeModels(h), null);
});

test("codex keys on slug and hides what its own picker hides", (t) => {
  const h = home(t);
  mkdirSync(path.join(h, ".codex"), { recursive: true });
  writeFileSync(
    path.join(h, ".codex", "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "top", visibility: "list" },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
        { id: "gpt-legacy", display_name: "keyed on id, not a codex record" },
        { slug: "gpt-5.5" },
      ],
    }),
  );
  assert.deepEqual(codexModels(h), [
    { id: "gpt-6-astra", name: "GPT-6-Astra", note: "top" },
    { id: "gpt-5.5", name: "gpt-5.5", note: "" },
  ]);
});
