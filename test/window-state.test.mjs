// window-state.js: the board window reopens where it was left. Fake window and screen; no Electron.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { load, clamp, save, track, DEFAULT, MIN } = createRequire(import.meta.url)("../desktop/window-state.js");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zv-ws-")), "window-state.json");
const screen1080 = () => ({ x: 0, y: 0, width: 1920, height: 1040 });

function fakeWin({ bounds = { x: 100, y: 80, width: 1000, height: 700 }, normal = bounds, maximized = false, minimized = false, destroyed = false } = {}) {
  const handlers = {};
  return {
    isDestroyed: () => destroyed, isMinimized: () => minimized, isFullScreen: () => false, isMaximized: () => maximized,
    getBounds: () => bounds, getNormalBounds: () => normal,
    on: (ev, fn) => { handlers[ev] = fn; }, fire: (ev) => handlers[ev](),
  };
}

describe("window-state", () => {
  test("no file, a corrupt file, or nonsense numbers all fall back to the default size", () => {
    const f = tmp();
    assert.deepEqual(load(f), DEFAULT);
    fs.writeFileSync(f, "{not json");
    assert.deepEqual(load(f), DEFAULT);
    fs.writeFileSync(f, JSON.stringify({ width: "wide", height: null }));
    assert.deepEqual(load(f), DEFAULT);
  });

  test("a saved size, position and maximized flag round-trip; a tiny saved size is raised to the minimum", () => {
    const f = tmp();
    fs.writeFileSync(f, JSON.stringify({ x: 40, y: 50, width: 900, height: 600, maximized: true }));
    assert.deepEqual(load(f), { x: 40, y: 50, width: 900, height: 600, maximized: true });
    fs.writeFileSync(f, JSON.stringify({ width: 10, height: 10 }));
    assert.deepEqual(load(f), { width: MIN.width, height: MIN.height });
  });

  test("a window saved on a monitor that is gone is pulled back onto the screen that is left", () => {
    const off = clamp({ x: 3000, y: -400, width: 1240, height: 820 }, screen1080);
    assert.deepEqual(off, { x: 680, y: 0, width: 1240, height: 820 });
    const big = clamp({ x: 10, y: 10, width: 5000, height: 3000 }, screen1080);
    assert.deepEqual(big, { x: 0, y: 0, width: 1920, height: 1040 });
    const fine = { x: 100, y: 100, width: 800, height: 600 };
    assert.deepEqual(clamp(fine, screen1080), fine);
  });

  test("no saved position leaves placement to the OS", () => {
    assert.deepEqual(clamp({ width: 1240, height: 820 }, () => assert.fail("must not ask the screen")), { width: 1240, height: 820 });
  });

  test("save writes the live bounds, or the restored bounds when maximized", () => {
    const writes = [];
    const write = (f, s) => writes.push(s);
    save("f", fakeWin(), write);
    save("f", fakeWin({ maximized: true, normal: { x: 5, y: 6, width: 700, height: 500 } }), write);
    assert.deepEqual(writes, [{ x: 100, y: 80, width: 1000, height: 700 }, { x: 5, y: 6, width: 700, height: 500, maximized: true }]);
  });

  test("a minimized or destroyed window is never saved (minimized bounds are off-screen garbage)", () => {
    let writes = 0;
    const write = () => { writes++; };
    save("f", fakeWin({ minimized: true }), write);
    save("f", fakeWin({ destroyed: true }), write);
    assert.equal(writes, 0);
  });

  test("a write that throws never reaches the window", () => {
    save("f", fakeWin(), () => { throw new Error("disk full"); });
  });

  test("resize and move are debounced into one write; close writes at once and cancels the pending one", () => {
    const writes = [];
    let timer = null, cleared = 0;
    const w = fakeWin();
    track(w, "f", (f, s) => writes.push(s), { setTimer: (fn) => (timer = fn), clearTimer: () => { cleared++; timer = null; } });
    w.fire("resize"); w.fire("move"); w.fire("resize");
    assert.equal(writes.length, 0);
    timer();
    assert.equal(writes.length, 1);
    w.fire("move");
    w.fire("close");
    assert.equal(writes.length, 2);
    assert.equal(timer, null, "the pending debounce was cancelled");
    assert.ok(cleared >= 3);
  });
});
