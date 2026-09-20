// The board's own page and source, checked for the things nothing else checks.
//
// ⚠️ WHY THIS FILE EXISTS. hub/public/index.html used to carry the board as
// ~2500 lines of inline JavaScript with no compiler, no bundler and no import
// graph between it and the user: a missing brace did not fail a build — there
// was no build — it shipped, and the whole window came up blank. The board is
// now a bundled React app built out of board/, so that failure mode is gone;
// what is left are the same structural contracts the old file pinned down,
// asserted against the artifacts the hub actually serves. A typo in a pane id,
// a second console host, or a composer that quietly dropped to a single-line
// input are all still silent failures: the pane never fills, or nobody has a
// console where they expect one. These tests catch them.
//
// This is deliberately NOT a DOM test. Running the board needs a browser, and
// there is one — see the CDP dogfooding runs — but a dependency-free parse and
// contract check that runs in the ordinary gate catches the failure that
// actually happens, which is a typo.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const INDEX = path.join(ROOT, "hub", "public", "index.html");
const PUBLIC = path.join(ROOT, "hub", "public");
const SRC = path.join(ROOT, "board", "src");
const html = readFileSync(INDEX, "utf8");

/** Every readable .tsx/.ts/.mjs/.css file under board/src, in a stable order. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(tsx|ts|mjs|css)$/.test(name)) out.push(full);
    }
  };
  walk(SRC);
  return out.sort();
}

const sourceText = () => sources().map((f) => readFileSync(f, "utf8")).join("\n");

/** Every inline <script> body on the page, in order. */
function inlineScripts(source) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(source))) out.push(m[1]);
  return out;
}

/** The src of every <script>, and href of every <link>, on the page. */
function loads(source) {
  const scripts = Array.from(source.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)).map((m) => m[1]);
  const links = Array.from(source.matchAll(/<link[^>]*\bhref="([^"]+)"/g)).map((m) => m[1]);
  return { scripts, links };
}

describe("the board page", () => {
  test("every script and style it references exists on disk", () => {
    const { scripts, links } = loads(html);
    assert.ok(scripts.length >= 1, "expected at least one script on the board");
    for (const name of [...scripts, ...links]) {
      const clean = name.replace(/^\//, "");
      assert.ok(existsSync(path.join(PUBLIC, clean.replace(/\?.*$/, ""))), `the page loads ${name} and it is not there`);
    }
  });

  test("the page is one bundled module plus the three legacy frames it loads", () => {
    // The board is now board.js, a Vite bundle. It shares the page with the
    // three un-bundled frames the hub still serves separately (there is a
    // whole other build for editor.js) — and with no inline script: the bundle
    // is where `var` stays contained now.
    assert.equal(inlineScripts(html).length, 0, "the board must not gain an inline script");
    const { scripts } = loads(html);
    const modules = scripts.filter((s) => s.startsWith("/board.js"));
    assert.equal(modules.length, 1, "there must be exactly one board bundle");
    assert.deepEqual(
      scripts.filter((s) => !s.startsWith("/board.js")).sort(),
      ["/agent-sprites.js", "/editor.js", "/highlight.js"],
      "the legacy frames are exactly the three the hub serves",
    );
    assert.equal(html.match(/board\.css/g).length, 1, "the stylesheet must be included exactly once");
  });

  const ids = [
    // The app looks each of these up by id. Renaming one in the source is a
    // silent failure: the lookup returns undefined and the pane simply never
    // fills. ("changed" was here until the changed-file list was removed in
    // favour of the tree, and "streams"/"streamsTitle" until teammate cards
    // folded into the roster and consoles moved to the rail and chat; the
    // absences are the contract now, not oversights.)
    "people", "workspaces", "tree", "detail", "detailTitle", "collisions",
    "chat", "consolesSlot", "strip", "themer", "settingsLink",
  ];
  for (const id of ids) {
    test(`#${id} is written into the board`, () => {
      assert.ok(
        new RegExp(`id="${id}"`).test(sourceText()),
        `the board renders #${id} and no source defines it`,
      );
    });
  }

  test("exactly one composer exists, and it is not in the rail", () => {
    // ⚠️ THE CONTRACT THE CONVERSATION RESTS ON, restated. It used to be that
    // ONE console component moved between the rail and #chat and must never be
    // in both, because two mounts meant two composers disagreeing about the
    // draft. They are two different components now — the rail is navigation,
    // #chat is the assistant-ui Thread — so the rule that carries the same
    // weight is this one: the rail must not grow a composer back.
    const app = readFileSync(path.join(SRC, "App.tsx"), "utf8");
    assert.equal((app.match(/id="consolesSlot"/g) || []).length, 1, "there must be exactly one rail host");
    assert.ok(app.includes('viewMode === "ide"'), "the rail host must be gated on the ide view");
    assert.equal((app.match(/<Consoles/g) || []).length, 1, "the rail is the only place Consoles mounts");
    assert.equal((app.match(/<Conversation/g) || []).length, 1, "the chat column is the only place Conversation mounts");

    const rail = readFileSync(path.join(SRC, "components", "consoles.tsx"), "utf8");
    assert.ok(!rail.includes("<textarea"), "the rail grew a composer back");
    assert.ok(!/sendPrompt/.test(rail), "the rail must not send prompts; the Thread does");

    const css = readFileSync(path.join(ROOT, "hub", "public", "board.css"), "utf8");
    assert.ok(/\.chatcol\{[^}]*display:none\}/.test(css), "the chat column must be hidden in ide view");
    assert.ok(css.includes("data-view=agent] .chatcol{display:flex"), "only the agent view may show the chat column");
  });

  test("one runtime provider wraps the whole shell", () => {
    // The rail's rows and the strip read thread state too, so the provider
    // cannot be scoped to the chat column. Two providers would give the rail
    // and the conversation separate runtimes and separate ideas of which
    // thread is in front.
    const app = readFileSync(path.join(SRC, "App.tsx"), "utf8");
    assert.equal((app.match(/<ConsoleRuntimeProvider>/g) || []).length, 1);
    assert.ok(
      app.indexOf("<ConsoleRuntimeProvider>") < app.indexOf('className="shell"'),
      "the provider must wrap the shell, not sit inside it",
    );
  });

  test("the tree and follow-mode open files the same way", () => {
    // Both rows call toggleSelection rather than each doing their own
    // openEditor/openLocalFile dance, which is how paths drift. (The second
    // caller is the follow handler; the third is the definition.)
    const src = sourceText();
    assert.ok((src.match(/toggleSelection\(/g) || []).length >= 3, "expected one definition and two call sites");
  });

  test("the composer is a textarea, so a prompt can have newlines in it", () => {
    // The composer is the registry's now rather than a hand-rolled textarea,
    // so the claim is checked where it lives. ComposerPrimitive.Input renders
    // a textarea and handles Enter/Shift+Enter itself; what is pinned here is
    // that the Thread still uses it, because a Thread rebuilt around a plain
    // <input> would silently lose multi-line prompts.
    const thread = readFileSync(
      path.join(SRC, "components", "assistant-ui", "elements", "thread.aui.tsx"),
      "utf8",
    );
    assert.ok(thread.includes("<ComposerPrimitive.Input"), "the Thread lost its composer input");
    assert.ok(!/<input\b[^>]*aui_composer/.test(thread), "the composer became a single-line input");
  });

  test("prose() renders bold and code and nothing else", async () => {
    // The parser is lifted out of the app and run directly, because the claim
    // being tested is a SECURITY claim — that model output cannot become
    // markup — and "I read it and it looked fine" is not a test. The component
    // that renders the parts is checked separately for not trusting them.
    const { inlineParts } = await import(
      pathToFileURL(path.join(ROOT, "board", "src", "lib", "prose.mjs")).href
    );
    const render = (s) => inlineParts(s).map((p) => `${p.kind}:${p.text}`);

    assert.deepEqual(render("plain words"), ["text:plain words"]);
    assert.deepEqual(render("a **bold** b"), ["text:a ", "b:bold", "text: b"]);
    assert.deepEqual(render("run `npm test` now"), ["text:run ", "code:npm test", "text: now"]);

    // The one that matters. Angle brackets are text, in every position.
    const evil = '<img src=x onerror="alert(1)">';
    assert.deepEqual(render(evil), [`text:${evil}`]);
    assert.deepEqual(render(`**${evil}**`), [`b:${evil}`]);
    // A <b> whose TEXT is a tag is still only text.
    assert.ok(!render(evil).some((k) => k.startsWith("img:")));

    // Unbalanced markers stay literal rather than eating the rest of the line.
    assert.deepEqual(render("2 ** 3 = 8"), ["text:2 ** 3 = 8"]);
    assert.deepEqual(render("a ` b"), ["text:a ` b"]);
    // Markers do not span lines, so a stray backtick cannot swallow a
    // paragraph — the reason both patterns exclude \n.
    assert.deepEqual(render("a `b\nc` d"), ["text:a `b\nc` d"]);

    // And React is never handed a string to trust as HTML.
    const proseTsx = readFileSync(path.join(SRC, "components", "prose.tsx"), "utf8");
    assert.ok(!proseTsx.includes("dangerouslySetInnerHTML"), "agent words must not become markup");
  });

  test("agent view is a stylesheet, not a second renderer", () => {
    // Every agent-view rule is a CSS selector on the body attribute, in the
    // built stylesheet the hub serves. If this ever needs a JS branch per
    // pane, the two views have forked and the comment in the stylesheet is
    // lying.
    const css = readFileSync(path.join(ROOT, "hub", "public", "board.css"), "utf8");
    assert.ok(/body\[data-view=?["']?agent["']?\]/.test(css));
    const board = readFileSync(path.join(SRC, "lib", "board.ts"), "utf8");
    assert.ok(board.includes('setAttribute("data-view"'), "the view must be a body attribute, not drawn by JS");
  });
});

/* ==========================================================================
 * THE SETUP WINDOW
 *
 * desktop/setup.html has the same problem the board used to have and had no
 * test at all: ~140 lines of inline script with no build step between it and
 * the user, reached on a FIRST RUN, where a ReferenceError is not a degraded
 * feature — it is an app that cannot be configured and a person with
 * nowhere to go.
 *
 * ⚠️ THE id CHECK IS NOT PEDANTRY. `$("gh")` on an element that is not there
 * returns null and throws on the next line, and the board shipped exactly
 * this bug in a different alphabet the day before: a stylesheet rule written
 * `.chat` for an element whose id was `chat`, which silently applied to
 * nothing and was found in a screenshot rather than by a test.
 * ========================================================================= */
describe("the setup window", () => {
  const html = readFileSync(path.join(ROOT, "desktop", "setup.html"), "utf8");

  test("its inline script parses", () => {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    new vm.Script(blocks[0][1], { filename: "setup.html" });
  });

  test("every element the script reaches for exists in the markup", () => {
    const ids = new Set([...html.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
    assert.ok(ids.size > 8, "the id scrape found almost nothing — has $() been renamed?");
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `setup.html calls $("${id}") and has no such element`);
    }
  });

  test("GitHub sign-in is the primary action and the secret is the fallback", () => {
    // The ordering IS the feature. A refactor that puts the secret field back
    // at the top has undone the change while leaving every line of it in place.
    assert.ok(/id="gh"[^>]*class="[^"]*primary/.test(html), "the GitHub button must be the primary one");
    assert.ok(html.indexOf('id="gh"') < html.indexOf('id="token"'), "the secret field must come after the GitHub button");
    assert.ok(/<details[^>]*id="manual"/.test(html), "the secret field must be folded away behind a disclosure");
  });

  test("the setup window never asks the main process for a credential back", () => {
    // It writes credentials and is never given one. `zevet:config` redacts
    // them for the same reason, and the board window — which loads REMOTE
    // html from the hub — shares this preload.
    for (const name of ["secret", "session"]) {
      assert.equal(
        new RegExp(`\b(c|cfg)\.${name}\b`).test(html),
        false,
        `setup.html reads .${name} off the config, which is redacted and will be undefined`,
      );
    }
  });
});