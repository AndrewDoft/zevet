// The release gate beyond the test suite: versions agree, the client-file
// lists agree, and the tree being checked is exercised through fixtures so no
// test depends on the state of the developer's own checkout.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers.mjs";
import { checkVersions, checkClientFiles } from "../scripts/release-check.mjs";

function layOut(t, { version = "0.2.5", desktop = version, files = ["hook.mjs"] } = {}) {
  const d = tempDir("zevet-release-");
  t.after(() => d.cleanup());
  writeFileSync(path.join(d.dir, "package.json"), JSON.stringify({ version }));
  mkdirSync(path.join(d.dir, "desktop"), { recursive: true });
  writeFileSync(path.join(d.dir, "desktop", "package.json"), JSON.stringify({ version: desktop }));
  mkdirSync(path.join(d.dir, "hub"), { recursive: true });
  mkdirSync(path.join(d.dir, "client"), { recursive: true });
  const list = `const CLIENT_FILES = [\n${files.map((f) => `  "${f}",`).join("\n")}\n];`;
  writeFileSync(path.join(d.dir, "hub", "server.mjs"), `${list}\n`);
  writeFileSync(path.join(d.dir, "client", "doctor.mjs"), `${list}\n`);
  for (const f of files) writeFileSync(path.join(d.dir, "client", f), "// x\n");
  return d.dir;
}

describe("release-check", () => {
  test("agreeing versions and lists pass", async (t) => {
    const root = layOut(t);
    assert.equal(checkVersions(root), null);
    assert.equal(checkClientFiles(root), null);
  });

  test("a version skew is named, not shipped", async (t) => {
    const root = layOut(t, { version: "0.2.5", desktop: "0.2.4" });
    assert.match(checkVersions(root), /0\.2\.5.*0\.2\.4/);
  });

  test("hub/doctor drift is named", async (t) => {
    const root = layOut(t);
    const fs = await import("node:fs");
    fs.writeFileSync(path.join(root, "client", "extra.mjs"), "// x\n");
    fs.writeFileSync(
      path.join(root, "hub", "server.mjs"),
      'const CLIENT_FILES = [\n  "hook.mjs",\n  "extra.mjs",\n];\n',
    );
    assert.match(checkClientFiles(root), /doctor expects/);
  });

  test("a listed file missing from disk is named", async (t) => {
    const root = layOut(t, { files: ["hook.mjs", "ghost.mjs"] });
    (await import("node:fs")).rmSync(path.join(root, "client", "ghost.mjs"));
    assert.match(checkClientFiles(root), /ghost\.mjs/);
  });
});
