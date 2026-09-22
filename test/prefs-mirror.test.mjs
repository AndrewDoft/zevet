// board/src/lib/prefs-mirror.mjs is the pure logic behind mirroring every
// "zevet.*" localStorage preference into the desktop app's own storage, so it
// follows the person across a reload, an app update, or a change of hub
// instead of resetting with the origin.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { applyMirror, hydratePrefsMirror, mirroredStorage } = await import(
  pathToFileURL(path.join(ROOT, "board", "src", "lib", "prefs-mirror.mjs")).href
);

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

describe("applyMirror", () => {
  test("copies every string entry into storage", () => {
    const s = fakeStorage();
    applyMirror({ "zevet.view": "agent", "zevet.theme": "dark" }, s);
    assert.equal(s.map.get("zevet.view"), "agent");
    assert.equal(s.map.get("zevet.theme"), "dark");
  });

  test("ignores non-string values rather than stringifying them", () => {
    const s = fakeStorage();
    applyMirror({ "zevet.seenRuns.v1": ["a", "b"], "zevet.bad": null }, s);
    assert.equal(s.map.size, 0);
  });

  test("does nothing for null, undefined, or a non-object mirror", () => {
    const s = fakeStorage();
    applyMirror(null, s);
    applyMirror(undefined, s);
    applyMirror("not an object", s);
    assert.equal(s.map.size, 0);
  });

  test("one bad key does not stop the rest", () => {
    const written = [];
    const s = {
      setItem: (k, v) => {
        if (k === "zevet.bad") throw new Error("quota");
        written.push([k, v]);
      },
    };
    applyMirror({ "zevet.bad": "x", "zevet.ok": "y" }, s);
    assert.deepEqual(written, [["zevet.ok", "y"]]);
  });
});

describe("hydratePrefsMirror", () => {
  test("applies whatever the mirror's prefs() resolves to", async () => {
    const s = fakeStorage();
    await hydratePrefsMirror(s, { prefs: async () => ({ "zevet.view": "agent" }) });
    assert.equal(s.map.get("zevet.view"), "agent");
  });

  test("no-ops without a mirror, or one with no prefs()", async () => {
    const s = fakeStorage();
    await hydratePrefsMirror(s, undefined);
    await hydratePrefsMirror(s, {});
    assert.equal(s.map.size, 0);
  });

  test("a rejected prefs() call leaves storage untouched", async () => {
    const s = fakeStorage({ "zevet.view": "ide" });
    await hydratePrefsMirror(s, { prefs: async () => { throw new Error("no desktop"); } });
    assert.equal(s.map.get("zevet.view"), "ide");
  });
});

describe("mirroredStorage", () => {
  test("without a mirror, behaves exactly like the underlying storage", () => {
    const s = fakeStorage();
    const z = mirroredStorage(s, () => undefined);
    z.setItem("zevet.view", "agent");
    assert.equal(z.getItem("zevet.view"), "agent");
    assert.equal(s.map.get("zevet.view"), "agent");
    z.removeItem("zevet.view");
    assert.equal(z.getItem("zevet.view"), null);
  });

  test("mirrors a write through setPref, and a delete as a null value", () => {
    const s = fakeStorage();
    const calls = [];
    const mirror = { setPref: async (k, v) => { calls.push([k, v]); } };
    const z = mirroredStorage(s, () => mirror);
    z.setItem("zevet.theme", "dark");
    z.removeItem("zevet.theme");
    assert.deepEqual(calls, [["zevet.theme", "dark"], ["zevet.theme", null]]);
  });

  test("re-checks the accessor on every call, not just at construction", () => {
    const s = fakeStorage();
    let mirror;
    const z = mirroredStorage(s, () => mirror);
    z.setItem("zevet.view", "agent"); // no mirror yet — must not throw
    const calls = [];
    mirror = { setPref: async (k, v) => calls.push([k, v]) };
    z.setItem("zevet.view", "ide");
    assert.deepEqual(calls, [["zevet.view", "ide"]]);
  });

  test("a storage that throws does not stop the mirror call", () => {
    const s = {
      getItem: () => { throw new Error("private mode"); },
      setItem: () => { throw new Error("private mode"); },
      removeItem: () => { throw new Error("private mode"); },
    };
    const calls = [];
    const z = mirroredStorage(s, () => ({ setPref: async (k, v) => calls.push([k, v]) }));
    assert.equal(z.getItem("zevet.view"), null);
    z.setItem("zevet.view", "agent");
    assert.deepEqual(calls, [["zevet.view", "agent"]]);
  });
});
