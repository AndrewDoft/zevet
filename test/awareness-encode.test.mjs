// The shared editor's presence sync. y-protocols' encodeAwarenessUpdate reads
// `.states` and `.meta` off the Awareness it is given; board.ts passed a
// `{ clientID }` stand-in, which threw "Cannot read properties of undefined
// (reading 'get')" on every local awareness change (seen live 2026-09-23:
// clicking "Start an agent" threw it three times and blanked the editor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const board = readFileSync(path.join(ROOT, "board", "src", "lib", "board.ts"), "utf8");
const req = createRequire(path.join(ROOT, "editor", "package.json"));

test("board.ts hands encodeAwarenessUpdate the Awareness, never a stand-in", () => {
  const calls = board.match(/encodeAwarenessUpdate\(([^,]+),/g) || [];
  assert.ok(calls.length >= 2, "both call sites found");
  for (const c of calls) assert.ok(!/\{\s*clientID/.test(c), `stand-in object passed: ${c}`);
});

test("y-protocols really needs the Awareness (why the stand-in threw)", async () => {
  const Y = await import(pathToFileURL(req.resolve("yjs")).href);
  const { Awareness, encodeAwarenessUpdate } = await import(pathToFileURL(req.resolve("y-protocols/awareness")).href);
  const a = new Awareness(new Y.Doc());
  a.setLocalStateField("user", { name: "t" });
  assert.throws(() => encodeAwarenessUpdate({ clientID: a.clientID }, [a.clientID]), /reading 'get'/);
  assert.ok(encodeAwarenessUpdate(a, [a.clientID]).length > 0);
  a.destroy(); // Awareness runs an interval; without this the test never exits.
});
