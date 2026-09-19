// The committed editor bundle must match the source it was built from.
//
// ⚠️ WHY THIS EXISTS. `hub/public/editor.js` is 815 KiB of generated code that
// is COMMITTED to git, because the hub has no build step — it deploys with
// `git pull && docker restart` and serves hub/public as static files. Nothing
// rebuilds it automatically: not `npm test`, not CI, not the desktop build.
//
// So the failure is: edit `editor/src/`, forget `npm run build` in `editor/`,
// commit. The diff shows the new source. The hub serves the old behaviour.
// Everything is green and the board is running code nobody can see in the
// repository. DECISIONS.md D-005 named this "the most likely way this rots"
// and shipped without a guard; this is the guard.
//
// It hashes the INPUTS rather than rebuilding, because rebuilding needs
// `editor/node_modules` — 200 MB of build-time dependencies the gate does not
// install and should not have to. `editor/build.mjs` writes the same hash
// beside the bundle every time it runs, so the two agree exactly when the
// bundle is current.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const SRC = path.join(ROOT, "editor", "src");
const BUNDLE = path.join(ROOT, "hub", "public", "editor.js");
const STAMP = path.join(ROOT, "hub", "public", "editor.js.srchash");

/** The same computation build.mjs does, and it has to stay the same one. */
function hashSources() {
  const h = createHash("sha256");
  for (const name of readdirSync(SRC).sort()) {
    h.update(name);
    h.update(readFileSync(path.join(SRC, name)));
  }
  return h.digest("hex");
}

describe("the committed editor bundle", () => {
  test("the bundle and its source map are both present", () => {
    assert.ok(existsSync(BUNDLE), "hub/public/editor.js is missing — run `npm run build` in editor/");
    assert.ok(existsSync(`${BUNDLE}.map`), "the source map is missing");
  });

  test("it was built from the source that is in the tree", () => {
    assert.ok(
      existsSync(STAMP),
      "hub/public/editor.js.srchash is missing — run `npm run build` in editor/",
    );
    const stamped = readFileSync(STAMP, "utf8").trim();
    assert.equal(
      hashSources(),
      stamped,
      "editor/src has changed since the bundle was built.\n" +
        "        Run `npm run build` in editor/ and commit hub/public/editor.js,\n" +
        "        editor.js.map and editor.js.srchash together.",
    );
  });

  test("the bundle is the IIFE the board expects, not a module", () => {
    // The board is a plain script-tag page: it reads `window.zevetEditor`.
    // A bundle rebuilt with the wrong `format` would load without error and
    // define nothing, and the editor would simply never appear.
    const head = readFileSync(BUNDLE, "utf8").slice(0, 400);
    assert.match(head, /zevetEditor/, "the bundle does not set the global the board reads");
    assert.doesNotMatch(head, /^\s*import\s/m, "the bundle looks like an ES module");
  });
});
