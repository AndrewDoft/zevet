// The board's three themes live in CSS variables and were asserted against the
// page's inline <style>; the board is now a bundled React app, so the palettes
// are asserted against the built stylesheet the hub actually serves and the
// behaviour is pinned where it now lives: the store actions and components,
// not a <style> block. The numbers matter — the whole point of Masora's tokens
// is that text stays readable on every surface in both themes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, startHub } from "./helpers.mjs";

const css = readFileSync(path.join(ROOT, "hub", "public", "board.css"), "utf8");

/** The CSS block (with its selector) that declares the given token, from the
 *  built sheet. Selectors survive minification with attribute quotes stripped,
 *  so the dark root is matched literally. */
function tokens(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\{([^{}]*)\\}", "g");
  for (const m of css.matchAll(re)) {
    if (!m[1].includes("--paper:")) continue;
    const parsed = Object.fromEntries(
      [...m[1].matchAll(/--([\w-]+):\s*(#[\da-f]{6})\b/gi)].map((x) => [x[1].toLowerCase(), x[2].toLowerCase()]),
    );
    return parsed;
  }
  assert.fail(`missing theme block for ${selector}`);
}

const palettes = {
  light: tokens(":root"), // the rule after which the attribute selector follows
  dark: tokens(":root[data-theme=dark]"),
};
test("both themes exist with their scratch tokens", () => {
  assert.ok(palettes.light.paper && palettes.dark.paper, "paper token missing from a theme");
  assert.notEqual(palettes.light.ink, palettes.dark.ink, "the two themes must not share a palette");
});
// ⚠️ THE DARK PALETTE. The board's syntax and collaboration colours are inline
// code and collaborator names; they are not cosmetic. Both palettes must
// declare every one of them, or the contrast loop below has nothing to check
// and a missing --who-3 ships silently. The old test did not catch this, and
// neither does the one above it.
for (const required of ["who-0", "who-1", "who-2", "who-3", "who-4", "syntax-string", "syntax-number", "syntax-function"]) {
  test(`dark palette declares ${required}`, () => {
    assert.ok(palettes.dark[required], `${required} is gone from the dark theme`);
  });
}

function luminance(hex) {
  return hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
describe("readable text", () => {
  for (const [theme, colors] of Object.entries(palettes)) {
    test(`${theme} body, secondary, identity and fallback code text meet 4.5:1`, () => {
      for (const foreground of ["ink", "subtle", "cerulean", "alert", "success", "who-0", "who-1", "who-2", "who-3", "who-4", "syntax-string", "syntax-number", "syntax-function"]) {
        for (const background of ["paper", "fill", "raise-soft", "raise", "raise-line"]) {
          const ratio = contrast(colors[foreground], colors[background]);
          assert.ok(ratio >= 4.5, `${theme} ${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
        }
      }
      // Muted copy appears on the paper and raised surfaces. Selected rows,
      // inline code and filled controls use ink/subtle instead.
      //
      // It is --ink-muted rather than --muted because index.css now defines
      // the shadcn contract in terms of these tokens, and there --muted is a
      // background fill with --muted-foreground as its text. Two different
      // meanings under one name rendered grey on grey.
      for (const background of ["paper", "raise-soft", "raise"]) {
        assert.ok(
          contrast(colors["ink-muted"], colors[background]) >= 4.5,
          `${theme} ink-muted on ${background}`,
        );
      }
    });
  }
});

test("the hub serves the board's local fonts with intact bytes and rejects other files", async () => {
  const hub = await startHub();
  try {
    const names = [...css.matchAll(/src:url\(\/fonts\/([^"')/]+)\)/g)].map((m) => m[1]);
    assert.equal(names.length, 2);
    for (const name of names) {
      const response = await fetch(`${hub.base}/fonts/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("content-type"), "font/woff2");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "wOF2");
      assert.deepEqual(bytes, readFileSync(path.join(ROOT, "hub/public/fonts", name)));
    }
    for (const name of ["../server.mjs", "..%2fserver.mjs", "LICENSE", "space-grotesk-variable.woff2.bak"]) {
      const response = await fetch(`${hub.base}/fonts/${name}`);
      assert.equal(response.status, 404, name);
      await response.text();
    }
  } finally { await hub.stop(); }
});

const src = (file) => readFileSync(path.join(ROOT, "board", "src", file), "utf8");

describe("theme behaviours", () => {
  const board = src("lib/board.ts");

  test("saved theme and toggles update the existing editor and native chrome", () => {
    assert.ok(board.includes('pref("theme", "light")'), "the saved theme no longer seeds the store");
    assert.ok(board.includes('setPref("theme", t)'), "a toggle no longer persists the theme");
    assert.ok(board.includes('ed.setDark(t === "dark")'), "a toggle no longer drives the editor theme");
    assert.ok(board.includes('document.documentElement.setAttribute("data-theme", g.theme)'), "applyTheme no longer paints the page");
    assert.ok(board.includes("bridge.local.chrome(spec)"), "applyTheme no longer repaints native chrome");
    // The wall between this page and the native panel is the four tokens the
    // panel can never read for itself through the page's computed styles.
    assert.ok(board.includes("paper: (css.getPropertyValue(\"--paper\")"), "the chrome spec no longer forwards the paper token");
  });

  test("Settings keeps focus and does not lose the invitation draft to a rerender", () => {
    const settings = src("components/settings.tsx");
    assert.ok(settings.includes('id="settingsClose"'), "the close button id is gone");
    assert.ok(settings.includes('id="settingsInvite"'), "the invitation field id is gone");
    assert.ok(settings.includes('ref={invite}'), "the invitation must survive rerenders as an uncontrolled field");
    assert.ok(settings.includes('document.getElementById("settingsClose")?.focus()'), "opening must move focus into the sheet");
    assert.ok(settings.includes('document.getElementById("settingsLink")?.focus()'), "closing must return focus to the rail");
    const app = src("App.tsx");
    assert.ok(app.includes('inert={sheetOpen ? true : undefined}'), "the shell beyond the sheet must be inert while it is open");
  });

  test("Settings traps Tab in both directions and Escape closes it", () => {
    const settings = src("components/settings.tsx");
    assert.ok(settings.includes('if (ev.key !== "Tab") return;'), "the Tab trap is gone");
    assert.ok(settings.includes("list[list.length - 1]") && settings.includes("ev.shiftKey"), "the trap no longer wraps from the last control");
    const app = src("App.tsx");
    assert.ok(app.includes('if (ev.key === "Escape") closeSettings();'), "Escape no longer closes the sheet from the shell");
    assert.ok(settings.includes('id="sheetBack"'), "clicking outside the sheet no longer closes it");
  });
});
// ---------------------------------------------------------------------------
// THE TWO PALETTES ARE ONE PALETTE NOW.
//
// index.css used to declare its own oklch neutrals and flip them on `.dark`,
// which nothing ever set — so every shadcn and assistant-ui component stayed
// in light colours while the board went dark. The shadcn contract is defined
// in terms of masora's tokens now. That only works while every alias points at
// a token masora actually declares, and while the dark variant reads the
// attribute masora flips.
describe("the shadcn contract is wired to masora", () => {
  const index = readFileSync(path.join(ROOT, "board", "src", "index.css"), "utf8");

  test("the Tailwind dark variant follows data-theme, not a .dark class", () => {
    const variant = /@custom-variant dark \(([^)]*)\)/.exec(index);
    assert.ok(variant, "no dark variant is declared");
    assert.match(variant[1], /data-theme="dark"/);
    assert.ok(
      !/\.dark\b/.test(variant[1]),
      "the dark variant still keys off a .dark class, which nothing sets",
    );
  });

  test("every alias resolves to a token masora declares", () => {
    const root = index.slice(index.indexOf(":root {"), index.indexOf("@layer base"));
    const aliases = [...root.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g)];
    assert.ok(aliases.length > 20, "the shadcn aliases are gone from index.css");
    for (const [, alias, token] of aliases) {
      assert.ok(
        palettes.light[token] !== undefined,
        `--${alias} points at --${token}, which masora does not declare`,
      );
    }
  });

  test("the aliases cover what an installed component reads", () => {
    for (const required of [
      "background", "foreground", "card", "popover", "primary", "secondary",
      "muted", "muted-foreground", "accent", "destructive", "border", "input", "ring",
    ]) {
      assert.match(index, new RegExp(`--${required}:`), `--${required} is not defined`);
    }
  });
});
