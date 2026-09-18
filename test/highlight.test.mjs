// The highlighter, under adversarial input.
//
// hub/public/highlight.js makes one load-bearing promise — that nothing from a
// source file can escape into the page, because its output goes through
// innerHTML and its input is whatever is on a teammate's disk. So most of this
// file is attempts to falsify that, and the rest is attempts to make it throw
// or hang. Colour correctness is tested too, but it is the least of the three:
// a wrong colour is a wrong colour, a `<script>` is an incident.
//
// The round-trip test is the strongest single assertion here. Strip every tag
// from the output, un-escape the entities, and you must get the input back
// EXACTLY. That one equality catches, at once: a character dropped, a character
// duplicated, tokens emitted out of order, and — the one that matters — a `<`
// that reached the output unescaped.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The module is UMD-shaped so the browser can load it with a plain <script>.
// That makes it CommonJS here, which the suite (type: module) reaches through
// createRequire. Importing it the way the board does not is the point: if the
// UMD wrapper ever stops working under CJS, this file fails to load at all.
const require = createRequire(import.meta.url);
const MODULE_PATH = path.join(ROOT, "hub", "public", "highlight.js");
const loaded = require(MODULE_PATH);

// OBSERVED, not assumed: this package is "type": "module", so Node classifies a
// .js file under it as ESM and require() hands back an empty module namespace
// rather than module.exports — the wrapper's `typeof module === "object"` test
// is false there. The browser has no such notion: a classic <script src> runs
// the same bytes and gets the global. So the file really is loadable both ways,
// and this is the seam between the two. Take whichever branch actually ran.
const api = loaded && typeof loaded.highlight === "function" ? loaded : globalThis.zevetHighlight;
assert.ok(api, "highlight.js exported nothing under either UMD branch");
const { highlight, languageFor } = api;

// This runs FIRST, before any suite, because the failure it catches is the one
// that makes every other failure meaningless. A syntax error in the module, or
// a UMD wrapper that exports nothing, used to surface as forty confusing
// "highlight is not a function" assertions somewhere in the middle of the run.
// Now it is the first line of the report.
describe("module loads", () => {
  test("both entry points are functions", () => {
    assert.equal(typeof highlight, "function", "highlight is not a function — did the module fail to parse?");
    assert.equal(typeof languageFor, "function", "languageFor is not a function — did the module fail to parse?");
    assert.equal(typeof highlight("", "js"), "string");
    assert.equal(languageFor("a.js"), "js");
  });

  test("the global entry point is set", () => {
    assert.equal(typeof globalThis.zevetHighlight, "object");
    assert.equal(typeof globalThis.zevetHighlight.highlight, "function");
    assert.equal(typeof globalThis.zevetHighlight.languageFor, "function");
  });

  test("it works as a classic <script src>, which is how the board will load it", () => {
    // Not inferred from the Node load above — that reaches the same branch for
    // a different reason. This evaluates the file the way a browser does: a
    // fresh global with `self`, no `module`, no `require`, no ESM. If the UMD
    // wrapper ever stops working for the board, this is what says so.
    const src = readFileSync(MODULE_PATH, "utf8");
    const sandbox = {};
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "highlight.js" });
    assert.equal(typeof sandbox.zevetHighlight, "object", "no window.zevetHighlight after a classic script load");
    assert.equal(typeof sandbox.zevetHighlight.highlight, "function");
    assert.equal(sandbox.zevetHighlight.languageFor("board.css"), "css");
    assert.equal(sandbox.zevetHighlight.highlight("<b>", "html"), '<span class="tok-tag">&lt;b</span><span class="tok-tag">&gt;</span>');
  });
});

/* ────────────────────────────── helpers ────────────────────────────── */

/** Every tag in the output must be a span we wrote. Nothing else is legal. */
const TAG = /<[^>]*>/g;

function stripTags(html) {
  return html.replace(TAG, "");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/**
 * One pass, so an un-escaped `&amp;` cannot be re-read as the start of another
 * entity. Sequential replaces would turn "&amp;lt;" into "<" and quietly make
 * the round-trip test pass on input it should fail.
 */
function unescapeHtml(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ENTITIES[name]);
}

function roundTrip(html) {
  return unescapeHtml(stripTags(html));
}

/** The set of tok-KINDs present in an output string. */
function kinds(html) {
  const found = new Set();
  for (const m of html.matchAll(/<span class="tok-([a-z]+)">/g)) found.add(m[1]);
  return found;
}

const LANGS = ["js", "json", "css", "html", "md", "py", "sh", "toml", "yaml", "rs", "go", "plain"];

/* ───────────────────── 1. escaping: the whole point ────────────────── */

describe("escaping", () => {
  // MUTATED, 2026-09-18, because a test that cannot fail is counted as coverage
  // and isn't any: escapeHtml() was replaced with `return String(s)` and the
  // suite went from 64/64 to 46 pass / 18 fail. All six tests in this block
  // were among them, and the HTML one reported, literally:
  //   literal <script in output: …<span class="tok-tag"><script</span>…
  // i.e. a live script tag in what goes to innerHTML. Then restored, 64/64.
  test("a bare script tag never reaches the output as markup", () => {
    const out = highlight("<script>alert(1)</script>", "js");
    assert.ok(!out.includes("<script"), `literal <script in output: ${out}`);
    assert.ok(!out.includes("</script"), `literal </script in output: ${out}`);
    // The escaped text is asserted with the spans removed, because the
    // tokeniser is free to split `<script>` across three spans (it does: punc,
    // plain, punc). What must hold is that the TEXT is the escaped form.
    assert.ok(stripTags(out).includes("&lt;script&gt;"), `expected escaped form, got: ${out}`);
    assert.equal(roundTrip(out), "<script>alert(1)</script>");
  });

  test("a span-breaking payload inside a string literal stays inside the string", () => {
    const src = 'const evil = "</span><img onerror=x>";';
    const out = highlight(src, "js");
    assert.ok(!out.includes("<img"), `literal <img in output: ${out}`);
    // The only closing tags in the output must be ones the renderer wrote, so
    // the count of </span> must equal the count of <span ...>.
    const opens = (out.match(/<span class="tok-[a-z]+">/g) || []).length;
    const closes = (out.match(/<\/span>/g) || []).length;
    assert.equal(opens, closes);
    assert.equal(roundTrip(out), src);
  });

  test("an HTML file containing a script tag is escaped, not executed", () => {
    const src = '<!doctype html>\n<body>\n<script>document.cookie = "x"</script>\n</body>';
    const out = highlight(src, "html");
    assert.ok(!out.includes("<script"), `literal <script in output: ${out}`);
    assert.ok(!out.includes("<body"), `literal <body in output: ${out}`);
    assert.equal(roundTrip(out), src);
  });

  test("all five escapable characters are escaped, in every language", () => {
    const src = `& < > " '`;
    for (const lang of LANGS) {
      const out = highlight(src, lang);
      assert.ok(!/[<>](?![a-z/])/.test(stripTags(out)), `raw angle bracket survived in ${lang}`);
      assert.equal(roundTrip(out), src, `round trip failed for ${lang}`);
    }
  });

  test("the only tags in the output are spans with a whitelisted class", () => {
    const sources = [
      ['<a href="#" onclick="x">hi</a>', "html"],
      ["`<b>` and <i>", "md"],
      ["# <!-- x -->\nkey: <v>", "yaml"],
      ["/* <style> */ a { content: '<>' }", "css"]
    ];
    for (const [src, lang] of sources) {
      const out = highlight(src, lang);
      for (const tag of out.match(TAG) || []) {
        assert.ok(
          /^<span class="tok-[a-z]+">$/.test(tag) || tag === "</span>",
          `unexpected tag ${JSON.stringify(tag)} from ${lang}`
        );
      }
    }
  });

  test("a payload that looks like our own markup is still just text", () => {
    // Someone's source file containing the exact string we emit must not be
    // able to close a span early and open an attribute of its own.
    const src = '</span><span class="tok-str" onload="alert(1)">';
    const out = highlight(src, "plain");
    assert.ok(!out.includes('onload="alert(1)"'), out);
    assert.ok(out.includes("&lt;/span&gt;"), out);
    assert.equal(roundTrip(out), src);
  });
});

/* ─────────────────── 2. representative snippets per language ───────── */

// Each entry: a snippet that looks like real code in that language, and the
// kinds it must produce. These are minimums, not exact sets — a rule that adds
// a kind is not a regression, a rule that stops producing one is.
const SNIPPETS = {
  js: {
    code: [
      "// a line comment",
      "/* a block one */",
      "import { readFile } from 'node:fs';",
      "const limit = 0x1f, ratio = 1.5e3;",
      'function send(msg) { return `to ${msg}`; }',
      "send(\"hello\");"
    ].join("\n"),
    want: ["com", "str", "num", "kw", "fn", "punc", "plain"]
  },
  json: {
    code: '{\n  "name": "zevet",\n  "port": 8787,\n  "quiet": false,\n  "tags": ["a", "b"]\n}',
    want: ["attr", "str", "num", "kw", "punc", "plain"]
  },
  css: {
    code: [
      "/* board chrome */",
      ".rail a:hover {",
      "  color: #2f6f8f;",
      "  padding: 12px 0;",
      "  font-family: 'Jost', sans-serif;",
      "  background: var(--paper) !important;",
      "}"
    ].join("\n"),
    want: ["com", "str", "num", "kw", "fn", "attr", "tag", "punc", "plain"]
  },
  html: {
    code: [
      "<!doctype html>",
      "<!-- the board -->",
      '<div class="rail" data-n="3">',
      "  1 &lt; 2 and 3 < 4 &copy;",
      "</div>"
    ].join("\n"),
    want: ["com", "kw", "tag", "attr", "str", "num", "punc", "plain"]
  },
  md: {
    code: [
      "# zevet",
      "",
      "> quoted line",
      "",
      "1. first *item* with `code`",
      "- second __item__",
      "",
      "See [the readme](./README.md) and <br/>.",
      "",
      "```sh",
      "npm test",
      "```"
    ].join("\n"),
    want: ["kw", "com", "num", "attr", "str", "tag", "punc", "plain"]
  },
  py: {
    code: [
      "# a comment",
      "@dataclass",
      "class Run:",
      '    """doc"""',
      "    def start(self, n=3):",
      "        return send('go')"
    ].join("\n"),
    want: ["com", "attr", "kw", "fn", "str", "num", "punc", "plain"]
  },
  sh: {
    code: [
      "#!/usr/bin/env bash",
      "# install the hook",
      "set -euo pipefail",
      'if [ -n "$ZEVET_TOKEN" ]; then',
      "  curl --silent \"$ZEVET_HUB/healthz\" --max-time 5",
      "fi"
    ].join("\n"),
    want: ["com", "kw", "str", "attr", "fn", "num", "punc", "plain"]
  },
  toml: {
    code: [
      "# config",
      "[server]",
      'host = "127.0.0.1"',
      "port = 8787",
      "quiet = false",
      "started = 2026-09-18",
      "tags = [1, 2]"
    ].join("\n"),
    want: ["com", "tag", "attr", "str", "num", "kw", "punc", "plain"]
  },
  yaml: {
    code: [
      "# config",
      "server:",
      '  host: "127.0.0.1"',
      "  port: 8787",
      "  quiet: false",
      "  tags:",
      "    - one",
      "    - two"
    ].join("\n"),
    want: ["com", "attr", "str", "num", "kw", "punc", "plain"]
  },
  rs: {
    code: [
      "// a comment",
      "#[derive(Debug)]",
      "pub struct Run { id: u32 }",
      // `u32` is a type, not a literal — the first draft of this snippet had no
      // number in it at all and the num assertion failed on a rule that works.
      "const MAX: u32 = 42;",
      "fn main() {",
      '    println!("{}", "hi");',
      "}"
    ].join("\n"),
    want: ["com", "attr", "kw", "tag", "fn", "str", "num", "punc", "plain"]
  },
  go: {
    code: [
      "// a comment",
      "package main",
      'import "fmt"',
      "func main() {",
      '    fmt.Println(`raw`, "hi", 42)',
      "}"
    ].join("\n"),
    want: ["com", "kw", "fn", "str", "num", "punc", "plain"]
  }
};

describe("token kinds", () => {
  for (const [lang, { code, want }] of Object.entries(SNIPPETS)) {
    test(`${lang}: produces ${want.join(", ")}`, () => {
      const out = highlight(code, lang);
      const got = kinds(out);
      for (const k of want) assert.ok(got.has(k), `${lang} did not produce tok-${k}; got ${[...got].join(",")}`);
      assert.equal(roundTrip(out), code, `${lang} round trip`);
    });
  }

  test("between them the snippets exercise all nine kinds", () => {
    // If a kind is never produced by any language, either the kind is dead or
    // a rule stopped firing. Both are worth a red.
    const all = new Set();
    for (const [lang, { code }] of Object.entries(SNIPPETS)) {
      for (const k of kinds(highlight(code, lang))) all.add(k);
    }
    for (const k of ["com", "str", "num", "kw", "fn", "punc", "attr", "tag", "plain"]) {
      assert.ok(all.has(k), `no language produced tok-${k}`);
    }
  });

  test("an unknown language renders as one plain span", () => {
    const out = highlight("anything at all", "klingon");
    assert.equal(out, '<span class="tok-plain">anything at all</span>');
  });
});

/* ─────────────────────── 3. it must not throw ──────────────────────── */

const MALFORMED = {
  "unterminated double quote": 'const a = "oops;\nconst b = 2;',
  "unterminated single quote": "x = 'oops\ny = 2",
  "unterminated template": "const a = `oops ${b} and on",
  "unterminated block comment": "/* never closed\nconst a = 1;",
  "unterminated html comment": "<!-- never closed\n<div>",
  "unterminated tag": '<div class="x',
  "unterminated fence": "```js\nconst a = 1;",
  "unterminated python docstring": 'def f():\n    """open',
  "empty": "",
  "only whitespace": "   \n\t\n  ",
  "only newlines": "\n\n\n",
  "lone backslash": "\\",
  "lone quote": '"',
  "nul and friends": "a\u0000b\u0001c",
  "astral plane": "const emoji = '😀🧵';",
  "crlf": "const a = 1;\r\nconst b = 2;\r\n",
  "unbalanced braces": "}}}{{{",
  "regex vs division": "const r = /ab+c/i; const q = a / b / c;",
  "html inside js string": 'const s = "<div onclick=\'x\'>";',
  "yaml url with hash": "url: http://example.com/#frag",
  "css nested at rule": "@media (min-width: 600px) { .a { color: red } }",
  "deep nesting": "{".repeat(200) + "}".repeat(200)
};

describe("totality", () => {
  for (const [name, src] of Object.entries(MALFORMED)) {
    test(`${name}: no language throws, and every one round-trips`, () => {
      for (const lang of LANGS) {
        let out;
        assert.doesNotThrow(() => {
          out = highlight(src, lang);
        }, `${lang} threw on ${name}`);
        assert.equal(typeof out, "string");
        assert.equal(roundTrip(out), src, `${lang} lost characters on ${name}`);
      }
    });
  }

  test("non-string input does not throw", () => {
    for (const v of [null, undefined, 42, true, {}, [], Symbol.iterator ? [1, 2] : []]) {
      assert.doesNotThrow(() => highlight(v, "js"));
      assert.equal(typeof highlight(v, "js"), "string");
    }
    assert.equal(highlight(null, "js"), "");
    assert.equal(highlight(undefined, "js"), "");
  });

  test("a non-string language falls back to plain", () => {
    for (const v of [null, undefined, 42, {}]) {
      assert.equal(highlight("a<b", v), '<span class="tok-plain">a&lt;b</span>');
    }
  });

  test("pseudo-random junk round-trips in every language", () => {
    // Deterministic: a seeded LCG, so a failure here is reproducible rather
    // than a once-a-month mystery.
    let seed = 20260918;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = "abc123 \n\t{}[]()<>\"'`/*#-+=:;,.!@$%^&|~\\_?";
    for (let i = 0; i < 300; i++) {
      let s = "";
      const n = Math.floor(rand() * 120);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      for (const lang of LANGS) {
        const out = highlight(s, lang);
        assert.equal(roundTrip(out), s, `${lang} lost characters on ${JSON.stringify(s)}`);
        assert.ok(!/<(?!\/?span)/.test(out), `unescaped tag from ${lang} on ${JSON.stringify(s)}`);
      }
    }
  });
});

/* ───────────────────────── 4. it must not hang ─────────────────────── */

describe("pathological input", () => {
  // Each of these is 200KB on ONE line — no newline anywhere for a
  // line-anchored rule to grab, and each one is shaped to make a naive rule
  // backtrack: a sea of quote openings, a sea of comment openings, a sea of
  // escapes. The budget is generous on purpose; the assertion that matters is
  // that it terminates at all, and the elapsed time is printed so a slow
  // machine's number is visible rather than inferred.
  const SIZE = 200 * 1024;
  const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

  const CASES = {
    "realistic code": fill('foo(1, "bar", 0x1f); '),
    "quotes only": fill('"'),
    "escaped quotes": fill('\\"'),
    "comment openers": fill("/*"),
    "backticks": fill("`"),
    "angle brackets": fill("<a>"),
    "one long identifier": fill("a"),
    "colons and dashes": fill("- a: "),
    "hash marks": fill("#")
  };

  for (const [name, src] of Object.entries(CASES)) {
    test(`${name}: 200KB on one line finishes fast and loses nothing`, () => {
      assert.equal(src.length, SIZE);
      for (const lang of ["js", "css", "html", "md", "yaml", "sh"]) {
        const t0 = process.hrtime.bigint();
        const out = highlight(src, lang);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.equal(roundTrip(out), src, `${lang} lost characters on ${name}`);
        assert.ok(ms < 2000, `${lang} took ${ms.toFixed(0)}ms on ${name} (budget 2000ms)`);
        if (ms > 200) console.log(`  [slow but within budget] ${lang}/${name}: ${ms.toFixed(0)}ms`);
      }
    });
  }

  test("a 2000-line file is not quadratic", () => {
    const src = Array.from({ length: 2000 }, (_, i) => `const v${i} = f(${i}, "s${i}"); // note ${i}`).join("\n");
    const t0 = process.hrtime.bigint();
    const out = highlight(src, "js");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(roundTrip(out), src);
    assert.ok(ms < 2000, `took ${ms.toFixed(0)}ms (budget 2000ms)`);
  });

  test("input past the size cap still renders, escaped", () => {
    const src = "<b>".repeat(400000); // 1.2MB, over MAX_INPUT
    const out = highlight(src, "html");
    assert.ok(!out.includes("<b>"), "raw markup survived the size cap");
    assert.equal(roundTrip(out), src);
  });
});

/* ──────────────────────────── 5. languageFor ───────────────────────── */

describe("languageFor", () => {
  const CASES = {
    "app.js": "js",
    "app.jsx": "js",
    "server.mjs": "js",
    "hook.cjs": "js",
    "db.ts": "js",
    "Board.tsx": "js",
    "package.json": "json",
    "board.css": "css",
    "index.html": "html",
    "page.htm": "html",
    "README.md": "md",
    "run.py": "py",
    "install.sh": "sh",
    "Cargo.toml": "toml",
    "ci.yaml": "yaml",
    "ci.yml": "yaml",
    "main.rs": "rs",
    "main.go": "go"
  };

  test("maps the extensions it claims to", () => {
    for (const [name, want] of Object.entries(CASES)) assert.equal(languageFor(name), want, name);
  });

  test("is case insensitive on the extension and path-aware", () => {
    assert.equal(languageFor("APP.JS"), "js");
    assert.equal(languageFor("src/hub/server.MJS"), "js");
    assert.equal(languageFor("C:\\dev\\GitHub\\zevet\\hub\\server.mjs"), "js");
    assert.equal(languageFor("/home/a/b/main.go"), "go");
  });

  test("anything else is plain", () => {
    for (const name of [
      "LICENSE",
      "Dockerfile",
      "Makefile",
      "archive.tar.gz",
      "image.png",
      ".gitignore", // a leading dot is not an extension
      ".env",
      "",
      "noext",
      "trailing.",
      "weird.",
      "a.unknownext"
    ]) {
      assert.equal(languageFor(name), "plain", name);
    }
  });

  test("non-string input is plain, not a crash", () => {
    for (const v of [null, undefined, 42, {}, []]) assert.equal(languageFor(v), "plain");
  });
});

/* ─────────────────────── 6. the round trip, at scale ───────────────── */

describe("round trip", () => {
  test("every snippet in this file survives every language", () => {
    // Cross-product on purpose: a CSS snippet tokenised as YAML is exactly the
    // kind of mismatch a file-viewer produces when the extension lies, and it
    // must still come back byte-identical.
    for (const { code } of Object.values(SNIPPETS)) {
      for (const lang of LANGS) {
        assert.equal(roundTrip(highlight(code, lang)), code);
      }
    }
  });

  test("this test file survives being highlighted as itself", () => {
    // Real input, not a fixture: whatever is in this file right now, including
    // every payload above.
    const self = require("node:fs").readFileSync(fileURLToPath(import.meta.url), "utf8");
    const out = highlight(self, "js");
    assert.equal(roundTrip(out), self);
    assert.ok(!out.includes("<script"));
  });

  test("the highlighter survives being highlighted by itself", () => {
    const src = require("node:fs").readFileSync(path.join(ROOT, "hub", "public", "highlight.js"), "utf8");
    const out = highlight(src, "js");
    assert.equal(roundTrip(out), src);
  });
});
