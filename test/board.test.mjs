// The board's own inline script, checked for the things nothing else checks.
//
// ⚠️ WHY THIS FILE EXISTS. hub/public/index.html carries ~2500 lines of inline
// JavaScript and it is the only part of zevet with no compiler, no bundler and
// no import graph between it and the user. A missing brace in it does not fail
// a build — there is no build — it ships, and the whole window comes up blank
// with a message in a console nobody has open. Every other test in this
// directory can be green while the product does not start.
//
// So the first test here is the important one: the page's script must PARSE.
// The rest assert the small number of structural contracts that the renderer
// depends on and that a careless edit to the markup would quietly break — an
// element id the script looks up by name, and the one-host-per-view rule that
// keeps a single console from being drawn in two columns at once.
//
// This is deliberately NOT a DOM test. Running the board needs a browser, and
// there is one — see the CDP dogfooding runs — but a dependency-free parse and
// contract check that runs in the ordinary gate catches the failure that
// actually happens, which is a typo.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers.mjs";

const PAGE = path.join(ROOT, "hub", "public", "index.html");
const html = readFileSync(PAGE, "utf8");

/** Every inline <script> body on the page, in order. */
function inlineScripts(source) {
  const out = [];
  // Only scripts with no `src`: the others are separate files with their own
  // tests, and their contents are not in this document to parse.
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

describe("the board page", () => {
  test("every inline script parses", () => {
    const scripts = inlineScripts(html);
    assert.ok(scripts.length >= 1, "expected at least one inline script on the board");
    scripts.forEach((body, i) => {
      // `new vm.Script` compiles without running: a syntax error throws here,
      // and nothing in the page's script — which touches `document` on the
      // first line — is executed.
      assert.doesNotThrow(
        () => new vm.Script(body, { filename: `index.html#script${i}` }),
        `inline script ${i} does not parse`,
      );
    });
  });

  test("the page is one script plus the bundles it loads", () => {
    // If this number changes, the parse test above is still correct but
    // somebody has added a second inline script — which is worth noticing,
    // because the page's one IIFE is the reason `var` at the top level is not
    // a global.
    assert.equal(inlineScripts(html).length, 1);
  });

  const ids = [
    // The renderer looks each of these up by id. Renaming one in the markup is
    // a silent failure: `$()` returns null and the pane simply never fills.
    "people", "workspaces", "tree", "detail", "detailTitle", "collisions",
    "streams", "chat", "changed", "strip", "themer", "settingsLink",
    "streamsTitle",
  ];
  for (const id of ids) {
    test(`#${id} is in the markup`, () => {
      assert.ok(
        new RegExp(`id="${id}"`).test(html),
        `the script reads #${id} and the markup does not define it`,
      );
    });
  }

  test("the console has exactly one host per view", () => {
    // ⚠️ THE CONTRACT AGENT VIEW RESTS ON. The conversation moves between the
    // middle column (#chat) and the rail (#streams); it is never in both. A
    // second renderMyConsole call against a fixed host is how that rule gets
    // broken, and the symptom — two live transcripts of one agent, with two
    // composers that disagree about the draft — is confusing enough to be
    // worth a test that reads like this one.
    const calls = html.match(/renderMyConsole\(/g) || [];
    assert.equal(calls.length, 2, "expected one definition and one call site");
  });

  test("the changed-file list and the tree open files the same way", () => {
    // Both rows call toggleSelection rather than each doing their own
    // openEditor/openLocalFile dance, which is what they did before and is how
    // the two paths drifted.
    const calls = html.match(/toggleSelection\(/g) || [];
    assert.ok(calls.length >= 3, "expected one definition and two call sites");
  });

  test("the composer is a textarea, so a prompt can have newlines in it", () => {
    assert.ok(
      /el\("textarea", "console-input"\)/.test(html),
      "the composer went back to a single-line input",
    );
    // Enter sends. Losing this makes the field behave like a form nobody
    // expects, and it was the whole reason the input was single-line.
    assert.ok(/ev\.key === "Enter" && !ev\.shiftKey/.test(html));
  });

  test("prose() renders bold and code and nothing else", () => {
    // The function is lifted out of the page and run against a fake document,
    // because the claim being tested is a SECURITY claim — that model output
    // cannot become markup — and "I read it and it looked fine" is not a test.
    // A fake DOM is enough: the only DOM calls it makes are createElement and
    // createTextNode, and the thing under test is which of the two it picks.
    const src = html.slice(html.indexOf("var INLINE_MD"), html.indexOf("function serverNow"));
    assert.ok(src.includes("function prose"), "prose() moved; this test needs re-aiming");

    const mk = (tag) => ({ tag, kids: [], className: "", appendChild(n) { this.kids.push(n); } });
    const sandbox = {
      el: (t) => mk(t),
      tx: (n, s) => { n.text = String(s); return n; },
      document: { createTextNode: (s) => ({ tag: "#text", text: s }) },
    };
    vm.createContext(sandbox);
    new vm.Script(src + "\n globalThis.prose = prose;").runInContext(sandbox);

    const render = (s) => {
      const root = mk("div");
      sandbox.prose(root, s);
      return root.kids.map((k) => `${k.tag}:${k.text}`);
    };

    assert.deepEqual(render("plain words"), ["#text:plain words"]);
    assert.deepEqual(render("a **bold** b"), ["#text:a ", "b:bold", "#text: b"]);
    assert.deepEqual(render("run `npm test` now"), ["#text:run ", "code:npm test", "#text: now"]);

    // The one that matters. Angle brackets are text, in every position.
    const evil = '<img src=x onerror="alert(1)">';
    assert.deepEqual(render(evil), [`#text:${evil}`]);
    assert.deepEqual(render(`**${evil}**`), [`b:${evil}`]);
    // A <b> whose TEXT is a tag is still only text: tx() sets textContent.
    assert.ok(!render(evil).some((k) => k.startsWith("img:")));

    // Unbalanced markers stay literal rather than eating the rest of the line.
    assert.deepEqual(render("2 ** 3 = 8"), ["#text:2 ** 3 = 8"]);
    assert.deepEqual(render("a ` b"), ["#text:a ` b"]);
    // Markers do not span lines, so a stray backtick cannot swallow a
    // paragraph — the reason both patterns exclude \n.
    assert.deepEqual(render("a `b\nc` d"), ["#text:a `b\nc` d"]);
  });

  test("agent view is a stylesheet, not a second renderer", () => {
    // Every agent-view rule is a CSS selector on the body attribute. If this
    // ever needs a JS branch per pane, the two views have forked and the
    // comment in the stylesheet is lying.
    assert.ok(html.includes('body[data-view="agent"]'));
    assert.ok(/document\.body\.setAttribute\("data-view", viewMode\)/.test(html));
  });
});
