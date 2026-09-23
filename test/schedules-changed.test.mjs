// main.js pushes "local:schedulesChanged" after a due schedule runs, but
// nothing subscribed: no wrapper in preload.js, no listener in board.ts, so
// the Schedules card / RepoTimeline sat stale until an unrelated poll caught
// up. Source assertions across the three files the wiring spans.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const read = (rel) => readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

test("preload exposes onSchedulesChanged, wired to the same channel main.js sends", () => {
  const main = read("desktop/main.js");
  assert.match(main, /boardWindow\.webContents\.send\("local:schedulesChanged", list\);/);
  const preload = read("desktop/preload.js");
  assert.match(preload, /onSchedulesChanged:\s*\(fn\)\s*=>\s*subscribe\("local:schedulesChanged",\s*fn\)/);
});

test("board.ts refreshes the schedule list on the push instead of waiting for the next poll", () => {
  const board = read("board/src/lib/board.ts");
  const wired = board.slice(
    board.indexOf('bridge.local.onSchedulesChanged === "function"'),
    board.indexOf('bridge.local.onPermitRequest === "function"'),
  );
  assert.match(wired, /bridge\.local\.onSchedulesChanged\(\(\) => \{/);
  assert.match(wired, /void refreshSchedules\(\);/);
});
