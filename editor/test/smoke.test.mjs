/**
 * Smoke test for the committed bundle.
 *
 * WHICH OF THE TWO OPTIONS THIS DOES, HONESTLY:
 *
 * It does the STRONGER one. The bundle is fully EVALUATED — `new vm.Script(src)`
 * followed by `.runInContext(ctx)` against a stub context — not merely parsed.
 * CodeMirror turned out to need surprisingly little at import time: a `document`
 * that can make elements, a `navigator` to sniff, and (this was the one that
 * actually failed first) a global `crypto`, which lib0 reaches for to seed
 * Yjs client IDs. So the assertions below are about code that really ran, and
 * `zevetEditor` is read off the context rather than grepped out of the text.
 *
 * WHAT IT STILL DOES NOT PROVE, and I am not going to pretend otherwise:
 *
 *   - `createEditor` is never CALLED here. Constructing an EditorView needs a
 *     real layout engine — measured line heights, ranges, ResizeObserver — and
 *     the stub below is nowhere near that. Faking it well enough to not throw
 *     would prove that the fake is elaborate, not that the editor works.
 *   - Nothing here has rendered a pixel, moved a cursor, or synced two peers.
 *     Remote cursors, the theme inheriting the board's font, and the search
 *     panel are all UNVERIFIED by this suite. They need a browser.
 *
 * What it does prove is the thing that actually goes wrong with a committed
 * bundle: that editor.js exists, is current, loads without throwing, and
 * exposes the exact surface hub/public/index.html is about to be written
 * against. A stale or broken editor.js is silent otherwise — the hub has no
 * build step to catch it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { languageForPath, LANGUAGE_NAMES } from "../src/language.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, "..", "..", "hub", "public", "editor.js");
const BUNDLE_MAP = `${BUNDLE}.map`;

/**
 * The smallest stub that gets CodeMirror through module evaluation.
 *
 * A Proxy over a function, so that every property access returns another one of
 * itself and every call returns one too. That is crude on purpose: writing out
 * a believable DOM by hand means guessing which of the several hundred DOM
 * methods this dependency tree touches at import time, and getting it wrong
 * produces a test failure that looks like a bundle bug. The Proxy cannot be
 * wrong about a method it has never heard of.
 *
 * `style` and `classList` are the two exceptions — they must be plain objects,
 * because CodeMirror assigns into them (`el.style.foo = ...`), and assigning
 * into a callable Proxy is fine but reading back is not what the caller means.
 */
function domStub() {
  const node = () =>
    new Proxy(function stubNode() {}, {
      get(_target, prop) {
        if (prop === "style") return {};
        if (prop === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
        if (prop === Symbol.toPrimitive || prop === "toString") return () => "[stub]";
        return node();
      },
      set: () => true,
      apply: () => node(),
    });

  const document = {
    createElement: () => node(),
    createElementNS: () => node(),
    createTextNode: () => node(),
    createRange: () => node(),
    documentElement: node(),
    head: node(),
    body: node(),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const ctx = {
    document,
    // lib0 seeds Yjs client IDs from this. Its absence was the first and only
    // hard failure when this test was written, which is worth recording: the
    // browser has it, node has it, a bare vm context does not.
    crypto: globalThis.crypto,
    navigator: { userAgent: "node", platform: "node", maxTouchPoints: 0, language: "en" },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

/** Evaluated once; every test below shares it. */
let loaded = null;
function loadBundle() {
  if (loaded) return loaded;
  const src = readFileSync(BUNDLE, "utf8");
  const ctx = domStub();
  new vm.Script(src, { filename: "hub/public/editor.js" }).runInContext(ctx);
  loaded = { ctx, src, api: ctx.zevetEditor };
  return loaded;
}

test("the committed bundle", async (t) => {
  await t.test("exists and is not empty", () => {
    assert.ok(existsSync(BUNDLE), `${BUNDLE} is missing — run \`npm run build\` in editor/`);
    const bytes = readFileSync(BUNDLE).length;
    assert.ok(bytes > 10_000, `editor.js is only ${bytes} bytes, which cannot be CodeMirror + Yjs`);
  });

  await t.test("ships its source map", () => {
    // Committed alongside the bundle on purpose: a minified 800 KiB stack trace
    // from a teammate's console is otherwise unreadable, and the hub serves
    // hub/public verbatim, so the map is only there if it is in git.
    assert.ok(existsSync(BUNDLE_MAP), "editor.js.map is missing — the build emits it; commit it");
  });

  await t.test("evaluates and defines the zevetEditor global", () => {
    const { api } = loadBundle();
    assert.equal(typeof api, "object", "zevetEditor was not defined on the context");
  });

  await t.test("exposes exactly the agreed surface", () => {
    const { api } = loadBundle();
    // The contract the board UI task is being written against. Listed
    // explicitly rather than snapshotted, so that removing one is a failure
    // with a name in it.
    for (const key of [
      "createEditor",
      "languageForPath",
      "languages",
      "Y",
      "Awareness",
      "syncProtocol",
      "awarenessProtocol",
      "encoding",
      "decoding",
    ]) {
      assert.ok(key in api, `zevetEditor.${key} is missing from the bundle`);
    }
    assert.equal(typeof api.createEditor, "function");
    assert.equal(typeof api.languageForPath, "function");
    assert.equal(typeof api.Awareness, "function", "Awareness should be the class, not the module");
  });

  await t.test("the bundled Yjs is a working Yjs, not just a present one", () => {
    // Cheap end-to-end proof that the yjs inside the bundle survived
    // minification and the NODE_ENV define: two docs, one update, same text.
    // If this passes, the collaborative path's foundation is real.
    const { api } = loadBundle();
    const a = new api.Y.Doc();
    a.getText("content").insert(0, "hello");
    const b = new api.Y.Doc();
    api.Y.applyUpdate(b, api.Y.encodeStateAsUpdate(a));
    assert.equal(b.getText("content").toString(), "hello");
  });

  await t.test("the sync and awareness protocols are usable from the bundle", () => {
    // The other task frames its own websocket messages with these. Proving the
    // encoder/decoder round-trips here means a failure there is their framing,
    // not this bundle.
    const { api } = loadBundle();
    const enc = api.encoding.createEncoder();
    const doc = new api.Y.Doc();
    api.syncProtocol.writeSyncStep1(enc, doc);
    const bytes = api.encoding.toUint8Array(enc);
    assert.ok(bytes.length > 0, "writeSyncStep1 produced nothing");
    const dec = api.decoding.createDecoder(bytes);
    assert.equal(api.decoding.readVarUint(dec), api.syncProtocol.messageYjsSyncStep1);

    const awareness = new api.Awareness(doc);
    assert.equal(typeof awareness.setLocalStateField, "function");
    awareness.destroy();
  });

  await t.test("every language name maps to a real extension in the bundle", () => {
    // The drift guard described at the top of src/language.js: a name that
    // languageForPath can return but LANGUAGE_EXTENSIONS has no entry for would
    // silently render as plain text with only a console.warn to show for it.
    const { api } = loadBundle();
    for (const name of LANGUAGE_NAMES) {
      assert.ok(api.languages.includes(name), `language "${name}" has no extension in index.js`);
    }
  });
});

test("languageForPath", async (t) => {
  // Imported directly from src/language.js — no DOM, no bundle. That file has
  // no imports precisely so this can be a plain unit test.

  await t.test("maps every extension the editor claims to support", () => {
    const expected = {
      "a.js": "javascript",
      "a.jsx": "javascript",
      "a.ts": "javascript",
      "a.tsx": "javascript",
      "a.mjs": "javascript",
      "a.cjs": "javascript",
      "a.py": "python",
      "a.json": "json",
      "a.html": "html",
      "a.htm": "html",
      "a.css": "css",
      "a.md": "markdown",
      "a.rs": "rust",
    };
    for (const [file, lang] of Object.entries(expected)) {
      assert.equal(languageForPath(file), lang, `${file} should be ${lang}`);
    }
  });

  await t.test("works on real relative paths, both separators", () => {
    assert.equal(languageForPath("src/db.ts"), "javascript");
    assert.equal(languageForPath("src\\hub\\server.mjs"), "javascript");
    assert.equal(languageForPath("./deep/nested/thing.py"), "python");
  });

  await t.test("is case-insensitive about the extension", () => {
    assert.equal(languageForPath("README.MD"), "markdown");
    assert.equal(languageForPath("Component.TSX"), "javascript");
  });

  await t.test("returns null rather than guessing", () => {
    // The important half of the contract. Each of these has been a wrong guess
    // in some editor or other; here they are all honestly plain text.
    for (const file of [
      "Makefile",
      "LICENSE",
      ".gitignore", // a dotfile's name, not an extension
      "notes.txt",
      "a.rb",
      "a.go",
      "server.conf",
      "archive.tar.gz",
      "no-extension.",
      "",
    ]) {
      assert.equal(languageForPath(file), null, `${JSON.stringify(file)} should be null`);
    }
  });

  await t.test("survives junk input without throwing", () => {
    for (const junk of [null, undefined, 42, {}, []]) {
      assert.equal(languageForPath(junk), null);
    }
  });

  await t.test("reads the extension from the basename, not the path", () => {
    // "src/v1.2/README" must not be read as a ".2/README" extension.
    assert.equal(languageForPath("src/v1.2/README"), null);
    assert.equal(languageForPath("a.js/b.py"), "python");
  });
});
