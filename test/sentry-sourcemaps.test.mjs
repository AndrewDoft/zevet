import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sentryCommands } from "../scripts/sentry-sourcemaps.mjs";

test("sentry commands inject and upload maps without shipping them", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "zevet-sentry-"));
  try {
    mkdirSync(path.join(root, "hub", "public"), { recursive: true });
    writeFileSync(path.join(root, "hub", "public", "board.js.map"), "{}");
    assert.deepEqual(sentryCommands(root, "0.2.119"), [
      ["sentry", ["sourcemap", "inject", path.join(root, "hub", "public")]],
      ["sentry", ["sourcemap", "upload", "--org", "masora", "--project", "electron", "--release", "0.2.119", path.join(root, "hub", "public")]],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
