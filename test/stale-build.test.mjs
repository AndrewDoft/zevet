// A hub deploy reaches an open board — but only when a reload cannot lose work.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, startHub } from "./helpers.mjs";

const { createStaleReload, holdsWork, IDLE_MS } = await import(
  pathToFileURL(path.join(ROOT, "board", "src", "lib", "stale-build.mjs")).href
);

/** The slice of a Document holdsWork reads. */
function fakeDoc({ dialog = false, inputs = [], editable = [], hidden = false } = {}) {
  return {
    hidden,
    querySelector: (sel) => (dialog && /role="dialog"/.test(sel) ? {} : null),
    querySelectorAll: (sel) => (sel === "input, textarea" ? inputs : editable),
  };
}
const field = (value, type = "text") => ({ type, value });

function rig(over = {}) {
  let t = 1_000_000;
  const r = { reloads: 0, dirty: false, doc: fakeDoc(), build: "new", advance: (ms) => (t += ms) };
  const ctl = createStaleReload({
    mine: "old",
    fetchBuild: async () => r.build,
    doc: over.doc ?? r.doc,
    now: () => t,
    editorDirty: () => r.dirty,
    reload: () => r.reloads++,
    ...over,
  });
  return Object.assign(r, { ctl, tick: () => ctl.tick() });
}

describe("reloading a stale board", () => {
  test("reloads when the build differs and the board has been idle", async () => {
    const r = rig();
    r.advance(IDLE_MS);
    await r.tick();
    assert.equal(r.reloads, 1);
  });

  test("does nothing while the build matches, or the poll fails", async () => {
    const r = rig();
    r.advance(IDLE_MS);
    r.build = "old";
    await r.tick();
    const bad = rig({ fetchBuild: async () => { throw new Error("offline"); } });
    bad.advance(IDLE_MS);
    await bad.tick();
    assert.equal(r.reloads + bad.reloads, 0);
  });

  test("waits out the two idle minutes, and input restarts them", async () => {
    const r = rig();
    r.advance(IDLE_MS - 1);
    await r.tick();
    assert.equal(r.reloads, 0, "1 ms short of idle");
    r.advance(IDLE_MS);
    r.ctl.touch();
    r.advance(IDLE_MS - 1);
    await r.tick();
    assert.equal(r.reloads, 0, "typing restarted the clock");
    r.advance(1);
    await r.tick();
    assert.equal(r.reloads, 1);
  });

  test("a hidden window is idle at once", async () => {
    const r = rig({ doc: fakeDoc({ hidden: true }) });
    await r.tick();
    assert.equal(r.reloads, 1);
  });

  test("an open dialog blocks it, hidden or not", async () => {
    const r = rig({ doc: fakeDoc({ dialog: true, hidden: true }) });
    await r.tick();
    assert.equal(r.reloads, 0);
  });

  test("an unsaved editor buffer blocks it", async () => {
    const r = rig();
    r.advance(IDLE_MS);
    r.dirty = true;
    await r.tick();
    assert.equal(r.reloads, 0);
    r.dirty = false;
    await r.tick();
    assert.equal(r.reloads, 1, "and it goes through once the buffer is saved");
  });

  test("a non-empty input or agent/terminal prompt blocks it", async () => {
    const r = rig({ doc: fakeDoc({ inputs: [field("ask claude to fix the")], hidden: true }) });
    await r.tick();
    assert.equal(r.reloads, 0);
  });

  test("a board with no stamped build never reloads", async () => {
    const r = rig({ mine: "" });
    r.advance(IDLE_MS);
    await r.tick();
    assert.equal(r.reloads, 0);
  });
});

describe("what counts as work in progress", () => {
  test("empty, whitespace, checkbox and hidden inputs do not", () => {
    assert.equal(holdsWork(fakeDoc({ inputs: [field(""), field("  "), field("on", "checkbox"), field("x", "hidden")] }), false), false);
  });
  test("typed text does, in an input or a contenteditable prompt", () => {
    assert.equal(holdsWork(fakeDoc({ inputs: [field("hi")] }), false), true);
    assert.equal(holdsWork(fakeDoc({ editable: [{ textContent: "hi", classList: { contains: () => false } }] }), false), true);
  });
  test("the file editor's own text does not (its dirty flag speaks for it)", () => {
    assert.equal(holdsWork(fakeDoc({ editable: [{ textContent: "const a", classList: { contains: (c) => c === "cm-content" } }] }), false), false);
  });
});

describe("the hub side", () => {
  test("GET /version and /healthz report the build, and the page carries it", async () => {
    const hub = await startHub({ HUB_BUILD_ID: "b-123" });
    try {
      const v = await fetch(`${hub.base}/version`);
      assert.equal(v.headers.get("cache-control"), "no-store");
      assert.deepEqual(await v.json(), { build: "b-123" });
      assert.equal((await (await fetch(`${hub.base}/healthz`)).json()).build, "b-123");
      const page = await (await fetch(`${hub.base}/`)).text();
      assert.match(page, /<meta name="zevet-build" content="b-123" \/>/);
    } finally {
      await hub.stop();
    }
  });

  test("without an override the build comes from the committed source stamps", async () => {
    const hub = await startHub();
    try {
      const a = (await (await fetch(`${hub.base}/version`)).json()).build;
      assert.match(a, /^[0-9a-f]{12}$/);
      assert.ok(readFileSync(path.join(ROOT, "hub", "public", "board.js.srchash"), "utf8").trim());
    } finally {
      await hub.stop();
    }
  });

  test("App.tsx wires the poll to the board's own editor dirty flag", () => {
    const app = readFileSync(path.join(ROOT, "board", "src", "App.tsx"), "utf8");
    assert.match(app, /createStaleReload/);
    assert.match(app, /edView\?\.dirty/);
  });
});
