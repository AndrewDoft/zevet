// Muse Spark (Meta Model API) in the composer's model picker.
//
// The picker itself renders in a browser (see composer.test.mjs's own note),
// so this pins the same things that file does: the wiring between the pieces,
// read as source. What it protects against is the exact failure class this
// feature is built to avoid — a model listed as if it always runs, or shown
// when it should be hidden.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { MUSE_MODELS } from "../board/src/lib/muse-models.mjs";

const BOARD = path.join(ROOT, "board", "src");
const constants = readFileSync(path.join(BOARD, "lib", "constants.ts"), "utf8");
const modelChoice = readFileSync(path.join(BOARD, "components", "model-choice.tsx"), "utf8");
const composerControls = readFileSync(path.join(BOARD, "components", "composercontrols.tsx"), "utf8");
const providers = readFileSync(path.join(BOARD, "components", "icons", "providers.tsx"), "utf8");
const mainJs = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
const hubServer = readFileSync(path.join(ROOT, "hub", "server.mjs"), "utf8");
const settingsTsx = readFileSync(path.join(BOARD, "components", "settings.tsx"), "utf8");

describe("Meta's own model ids", () => {
  test("only the two ids the quickstart itself names for a plain client", () => {
    assert.deepEqual(MUSE_MODELS.map((m) => m.id), ["muse-spark-1.3", "muse-spark-1.1"]);
  });

  test("each row carries a real display name, not left to the raw-id fallback", () => {
    for (const m of MUSE_MODELS) {
      assert.notEqual(m.name, m.id, `${m.id} has no display name`);
    }
  });
});

describe("the picker offers Meta", () => {
  test("MODELS.meta is wired from MUSE_MODELS", () => {
    assert.match(constants, /meta:\s*MUSE_MODELS\.map\(\(m\) => m\.id\)/);
  });

  test("Meta gets a provider label, same as every other group", () => {
    assert.match(modelChoice, /meta:\s*"Meta"/);
  });

  test("Meta's mark already exists (built for opencode's muse-spark rows) and resolves by agent name alone", () => {
    assert.match(providers, /meta:\s*\{\s*Mark:\s*MetaLogo/);
  });
});

describe("Meta is shown only when usable, unlike Gemini's permanent Connect chip", () => {
  test("the Chat picker only adds a meta row when localAgents reports it signed in", () => {
    // Not `{ name: "meta", ok: false, signedIn: false, detail: "" }` unconditionally
    // (that is Gemini's own line, immediately above) — a conditional push gated on
    // `meta?.signedIn`.
    assert.match(composerControls, /meta\?\.signedIn/);
    assert.match(composerControls, /localAgents\.find\(\(a\) => a\.name === "meta"\)/);
  });

  test("mutation check: the gate is a real condition, not always-true", () => {
    // The spread-if idiom used here is `...(cond ? [x] : [])`. Hardcoding
    // `cond` to true would make the row behave exactly like Gemini's
    // permanent chip, which is the regression this feature exists to avoid.
    assert.match(composerControls, /\.\.\.\(meta\?\.signedIn \? \[\{ name: "meta"/);
    assert.doesNotMatch(composerControls, /\.\.\.\(true \? \[\{ name: "meta"/);
  });

  test("the adapter is honestly absent: ok stays false even when signed in", () => {
    assert.match(composerControls, /\{ name: "meta", ok: false, signedIn: true, detail: meta\.detail \}/);
  });
});

describe("a Meta key can be saved in Settings like any other provider's", () => {
  test("desktop/main.js maps meta:api_key to MODEL_API_KEY", () => {
    assert.match(mainJs, /"meta:api_key":\s*"MODEL_API_KEY"/);
  });

  test("MODEL_API_KEY is cleared before a chosen credential is applied, like every other provider's env var", () => {
    const m = /ALL_CREDENTIAL_ENV_VARS\s*=\s*\[([^\]]+)\]/.exec(mainJs);
    assert.ok(m, "ALL_CREDENTIAL_ENV_VARS not found in desktop/main.js");
    assert.match(m[1], /"MODEL_API_KEY"/);
  });

  test("hub/server.mjs's duplicated table agrees (see its own comment on why it's duplicated)", () => {
    assert.match(hubServer, /"meta:api_key":\s*"MODEL_API_KEY"/);
  });

  test("Settings offers Meta — API key in the add-credential picker", () => {
    assert.match(settingsTsx, /provider:\s*"meta",\s*kind:\s*"api_key"/);
  });
});
