// scripts/lib/ps-env.mjs: the env construction make-feed.mjs uses so its
// Authenticode check survives being launched from pwsh 7 (see that file for
// the failure mode -- inherited PSModulePath breaks Windows PowerShell's
// Security module autoload).
import { test } from "node:test";
import assert from "node:assert/strict";
import { psEnvWithoutModulePath } from "../scripts/lib/ps-env.mjs";

test("PSModulePath is dropped, whatever its casing", () => {
  const env = { PATH: "C:\\Windows", PSModulePath: "C:\\pwsh\\Modules" };
  assert.deepEqual(psEnvWithoutModulePath(env), { PATH: "C:\\Windows" });

  const shouty = { PATH: "C:\\Windows", PSMODULEPATH: "C:\\pwsh\\Modules" };
  assert.deepEqual(psEnvWithoutModulePath(shouty), { PATH: "C:\\Windows" });
});

test("every other variable survives untouched", () => {
  const env = { A: "1", B: "2", PSModulePath: "x" };
  assert.deepEqual(psEnvWithoutModulePath(env), { A: "1", B: "2" });
});

test("no PSModulePath present is not an error", () => {
  const env = { PATH: "C:\\Windows" };
  assert.deepEqual(psEnvWithoutModulePath(env), { PATH: "C:\\Windows" });
});

test("the input object is never mutated", () => {
  const env = { PSModulePath: "x", PATH: "y" };
  psEnvWithoutModulePath(env);
  assert.deepEqual(env, { PSModulePath: "x", PATH: "y" });
});

test("defaults to process.env when called with no argument", () => {
  const before = process.env.PSModulePath;
  process.env.PSModulePath = "C:\\pwsh\\Modules";
  try {
    const out = psEnvWithoutModulePath();
    assert.equal(out.PSModulePath, undefined);
    assert.equal(process.env.PSModulePath, "C:\\pwsh\\Modules", "process.env itself must not be mutated");
  } finally {
    if (before === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = before;
  }
});
