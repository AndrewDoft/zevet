// The hub is never shown or asked for: a team name is the only identifier a
// person handles. Copy that names the hub, its address or its host is a
// regression — checked in the board's and the app's source strings, and (in
// setup-window.test.mjs) in the rendered setup window.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const HUB_COPY = /\bhub\b|sslip|34-74-69-129/i;

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs)$/.test(f)) out.push(p);
  }
  return out;
}

/** Everything a person could read in a source file: string literals and JSX
 *  text, with comments dropped and `${…}` holes emptied (an identifier called
 *  `hub` inside a template is code, not copy). */
export function visibleStrings(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;,{(])\/\/[^\n]*/g, "$1");
  const found = [];
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|>[^<>{}]+</g;
  for (const m of code.matchAll(re)) found.push(m[0].replace(/\$\{[^}]*\}/g, ""));
  return found;
}

describe("visibleStrings", () => {
  test("sees literals and JSX text, not comments or template holes", () => {
    const s = visibleStrings('// a hub\nconst a = "Lost the hub"; const b = `${hub}/x`; /* hub */ <p>the hub</p>');
    assert.ok(s.some((x) => HUB_COPY.test(x) && x.includes("Lost")));
    assert.ok(s.some((x) => HUB_COPY.test(x) && x.includes("the hub")));
    assert.ok(!s.some((x) => x.includes("${")));
    assert.ok(!s.some((x) => /^`\/x`$/.test(x) && HUB_COPY.test(x)));
  });
});

describe("no hub copy in what people read", () => {
  const files = [
    ...walk(path.join(ROOT, "board", "src")).filter((f) => !/fixture\.ts$/.test(f)),
    ...readdirSync(path.join(ROOT, "desktop"))
      .filter((f) => /^(main|preload|setup-.*|github-signin|google-signin)\.js$/.test(f))
      .map((f) => path.join(ROOT, "desktop", f)),
  ];

  test("the scan covers the board and the app", () => {
    assert.ok(files.length > 30, `only ${files.length} files`);
  });

  for (const f of files) {
    test(path.relative(ROOT, f).split(path.sep).join("/"), () => {
      const hits = visibleStrings(readFileSync(f, "utf8")).filter((s) => HUB_COPY.test(s) && !/^["'`]\.\.?\//.test(s)); // not a require() path
      assert.deepEqual(hits, []);
    });
  }

  test("setup.html has no hub, no host, no URL of its own", () => {
    const html = readFileSync(path.join(ROOT, "desktop", "setup.html"), "utf8")
      .replace(/<script>[\s\S]*?<\/script>/g, "")
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<meta[^>]*>/g, "");
    assert.doesNotMatch(html, /\bhub\b|sslip|https?:\/\//i);
  });
});
