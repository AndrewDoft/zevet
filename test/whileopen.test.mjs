// The tree reply for folder A must not land after the person has moved to folder B.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const { whileOpen } = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "whileopen.mjs")).href);

test("A's reply resolving after B was opened is dropped; B's lands", async () => {
  let root = "A";
  const landed = [];
  const ask = (dir, reply, delay) =>
    new Promise((r) => setTimeout(() => r(reply), delay)).then(whileOpen(() => root, dir, (v) => landed.push(`${dir}:${v}`)));
  const a = ask("A", "tree-a", 30);
  root = "B";
  const b = ask("B", "tree-b", 5);
  await Promise.all([a, b]);
  assert.deepEqual(landed, ["B:tree-b"]);
});

test("the rejection branch is guarded the same way", async () => {
  let root = "B";
  const errs = [];
  await Promise.reject(new Error("x")).catch(whileOpen(() => root, "A", () => errs.push("A")));
  assert.deepEqual(errs, []);
});
