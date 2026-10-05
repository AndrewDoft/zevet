import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sentryArtifacts, sentryCommands } from "../scripts/sentry-sourcemaps.mjs";

describe("Sentry sourcemap release artifacts", () => {
  test("selects only bundles with maps and never uploads JavaScript", () => {
    const files = [
      "hub/public/board.js", "hub/public/board.js.map",
      "hub/public/editor.js", "hub/public/editor.js.map",
      "desktop/dist/main.js", "desktop/dist/main.js.map",
      "desktop/dist/other.js",
    ];
    const artifacts = sentryArtifacts(files);
    assert.deepEqual(artifacts, [
      { project: "electron", bundle: "desktop/dist/main.js", map: "desktop/dist/main.js.map" },
      { project: "electron", bundle: "hub/public/board.js", map: "hub/public/board.js.map" },
      { project: "zevet-hub", bundle: "hub/public/editor.js", map: "hub/public/editor.js.map" },
    ]);
  });

  test("injects bundles, then uploads maps under the Zevet release", () => {
    const commands = sentryCommands("0.2.119", [
      { project: "electron", bundle: "hub/public/board.js", map: "hub/public/board.js.map" },
      { project: "zevet-hub", bundle: "hub/public/editor.js", map: "hub/public/editor.js.map" },
    ]);
    assert.deepEqual(commands, [
      ["sourcemap", "inject", "hub/public/board.js", "hub/public/board.js.map", "hub/public/editor.js", "hub/public/editor.js.map"],
      ["sourcemap", "upload", "--org", "masora", "--project", "electron", "--release", "0.2.119", "hub/public/board.js.map"],
      ["sourcemap", "upload", "--org", "masora", "--project", "zevet-hub", "--release", "0.2.119", "hub/public/editor.js.map"],
    ]);
  });
});
