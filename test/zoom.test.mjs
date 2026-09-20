// Zoom.
//
// There was none: buildMenu() had appMenu, a custom zevet menu, editMenu and
// windowMenu, and Electron's zoom accelerators come from the View menu, so
// Ctrl+=, Ctrl+- and Ctrl+0 were bound to nothing. Ctrl+wheel is off unless the
// app handles `zoom-changed`. Both were reported as "the zoom is broken", and
// so was the layout collapse underneath them, because zooming a shell that had
// no height made the dead space change size.
//
// main.js cannot be require()d here — it pulls in electron, which only loads
// inside an Electron process — so this reads the source, the way
// desktop-packaging.test.mjs does. It pins the wiring, not the behaviour: that
// the accelerators exist at all, that they go through applyZoom rather than
// setZoomLevel directly (so the level is remembered and the overlay follows),
// and that the clamp is present.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
const css = readFileSync(path.join(ROOT, "board", "src", "styles", "masora.css"), "utf8");

describe("the accelerators exist", () => {
  // ⚠️ MEASURED, and it cost a round trip. The first version bound
  // "CommandOrControl+Plus" on a visible item and "CommandOrControl+=" on a
  // hidden duplicate. Three Ctrl+= presses against a running build left
  // config.zoom at 0, because Electron does not register an accelerator for an
  // invisible menu item — and "Plus" matches only the SHIFTED press, + and =
  // being one key. The unshifted spelling is the one that has to be on the
  // visible item.
  for (const accel of ["CommandOrControl+=", "CommandOrControl+-", "CommandOrControl+0"]) {
    test(`${accel} is bound`, () => {
      assert.ok(main.includes(`accelerator: "${accel}"`), `${accel} is not bound in buildMenu()`);
    });
  }

  test("no zoom accelerator hides on an invisible item", () => {
    const view = main.slice(main.indexOf('label: "View"'), main.indexOf('role: "windowMenu"'));
    assert.ok(!/visible: false/.test(view), "an invisible menu item registers no accelerator");
  });

  test("they live in a View menu the template actually includes", () => {
    const template = main.slice(main.indexOf("function buildMenu()"), main.indexOf("Menu.setApplicationMenu"));
    assert.match(template, /label: "View"/);
    assert.match(template, /role: "togglefullscreen"/);
  });
});

describe("ctrl+wheel", () => {
  test("zoom-changed is handled", () => {
    // Electron fires this for the gesture and applies nothing itself. Without
    // a handler the wheel turns and the page does not move.
    assert.match(main, /webContents\.on\("zoom-changed"/);
  });

  test("it steps in both directions", () => {
    const handler = main.slice(main.indexOf('"zoom-changed"'), main.indexOf('"zoom-changed"') + 260);
    assert.match(handler, /direction === "in"/);
    assert.match(handler, /-ZOOM_STEP/);
  });
});

describe("the level survives", () => {
  test("it is restored on every load, not just the first", () => {
    // A reload resets zoomLevel to 0. Restoring once at window creation would
    // spring the board back to 100% on every refresh.
    assert.match(main, /did-finish-load[\s\S]{0,120}applyZoom/);
  });

  test("applying persists it", () => {
    const fn = main.slice(main.indexOf("function applyZoom"), main.indexOf("function stepZoom"));
    assert.match(fn, /rememberZoom\(next\)/);
    assert.match(fn, /setZoomLevel\(next\)/);
  });

  test("every path goes through applyZoom rather than setting the level raw", () => {
    const raw = [...main.matchAll(/setZoomLevel\(/g)].length;
    assert.equal(raw, 1, "setZoomLevel should be called in exactly one place, inside applyZoom");
  });
});

describe("the clamp", () => {
  test("a level outside the range is pulled back", () => {
    const fn = main.slice(main.indexOf("function clampZoom"), main.indexOf("const zoomFactor"));
    assert.match(fn, /ZOOM_MIN/);
    assert.match(fn, /ZOOM_MAX/);
    assert.match(fn, /Number\.isFinite/);
  });
});

describe("the title bar overlay tracks the zoom", () => {
  // Windows draws the overlay in device pixels over a page Chrome has scaled,
  // so a zoomed board grows its own title row past the window controls unless
  // the overlay height is scaled to match.
  test("its height is computed from the zoom factor, never hardcoded to 46", () => {
    const overlayCalls = [...main.matchAll(/setTitleBarOverlay\(\{[\s\S]{0,320}?\}\)/g)].map((m) => m[0]);
    assert.ok(overlayCalls.length > 0, "no setTitleBarOverlay call found");
    for (const call of overlayCalls) {
      assert.ok(
        /zoomFactor\(/.test(call),
        `an overlay is set with a fixed height, which drifts once zoomed:\n${call}`,
      );
    }
  });

  test("chromeFor scales the height it returns", () => {
    const fn = main.slice(main.indexOf("function chromeFor"), main.indexOf("/** The remembered zoom"));
    assert.match(fn, /TITLE_BAR_HEIGHT \* zoomFactor\(level\)/);
  });
});

describe("the layout survives being zoomed", () => {
  // The other half of "the zoom is broken". body is a one-row grid; the React
  // rebuild put #root between it and .shell without a height, so .shell sized
  // to its content and the rest of the window was empty. Zooming changed how
  // much empty, which is what made it look like a zoom bug.
  test("#root is given a height", () => {
    const rule = css.slice(css.indexOf("#root {"), css.indexOf("#root {") + 220);
    assert.ok(css.includes("#root {"), "#root has no rule at all");
    assert.match(rule, /height: 100%/);
    assert.match(rule, /grid-template-rows: 1fr/);
  });
});

describe("the spellings an accelerator cannot reach", () => {
  // Ctrl+Shift+= (the "+" most keyboards actually produce) and the numpad's
  // own keys. An accelerator string names a character; before-input-event
  // names the key, which is what survives a different keyboard layout.
  test("before-input-event is handled", () => {
    assert.match(main, /webContents\.on\("before-input-event"/);
  });

  test("it only acts on a modified keyDown", () => {
    const h = main.slice(main.indexOf('"before-input-event"'), main.indexOf('"before-input-event"') + 520);
    assert.match(h, /input\.type !== "keyDown"/);
    assert.match(h, /input\.meta : input\.control/, "Cmd on macOS, Ctrl elsewhere");
  });

  test("it covers the shifted and numpad spellings", () => {
    const fn = main.slice(main.indexOf("function onZoomKey"), main.indexOf("function stepZoom"));
    for (const key of ['"+"', '"="', '"Add"', '"-"', '"Subtract"', '"0"']) {
      assert.ok(fn.includes(key), `onZoomKey does not handle ${key}`);
    }
  });

  test("actual size is distinguished from no-match", () => {
    // onZoomKey returns 0 for Ctrl+0 and undefined for everything else, so the
    // caller must test undefined. Testing falsiness would make Ctrl+0 a no-op —
    // which is exactly the bug that looks like "reset doesn't work".
    const h = main.slice(main.indexOf('"before-input-event"'), main.indexOf('"before-input-event"') + 620);
    assert.match(h, /delta === undefined/);
    assert.match(h, /delta === 0/);
  });
});
