// desktop/browser-task/runner.py against a local fixture site, headless Chromium and a scripted fake model
// (tests live in desktop/browser-task/test_runner.py; this file only runs them).
// They need the pinned `browser-use` in a venv (ZEVET_BROWSER_PY, else $TEMP/bu-venv) and a Chromium. Without
// either the tests SKIP with the reason printed here -- never pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const DIR = path.join(ROOT, "desktop", "browser-task");
const PIN = /browser-use==([\d.]+)/.exec(fs.readFileSync(path.join(DIR, "requirements.txt"), "utf8"))[1];
const python = [process.env.ZEVET_BROWSER_PY, path.join(os.tmpdir(), "bu-venv", "v", "Scripts", "python.exe"), path.join(os.tmpdir(), "bu-venv", "v", "bin", "python")]
  .filter(Boolean).find((p) => fs.existsSync(p));
const py = (args, timeout = 150_000) => spawnSync(python, ["-I", "-B", ...args], { cwd: DIR, encoding: "utf8", timeout, windowsHide: true });

let why = "";
if (!python) why = "no venv with browser-use (set ZEVET_BROWSER_PY to a python with browser-use==" + PIN + ")";
else {
  const v = py(["-c", "import importlib.metadata as m;print(m.version('browser-use'))"], 60_000);
  if (v.status !== 0 || v.stdout.trim() !== PIN) why = `browser-use ${PIN} is not importable in ${python} (got ${JSON.stringify((v.stdout || v.stderr).trim().slice(-120))})`;
}
if (why) console.error(`\nbrowser-task-runner: SKIPPED -- ${why}\n`);

const names = why ? ["(all)"] : py(["test_runner.py", "--list"], 60_000).stdout.split(/\r?\n/).filter(Boolean);
for (const name of names) {
  test(`runner.py: ${name}`, { skip: why || false, timeout: 170_000 }, () => {
    const r = py(["test_runner.py", name]);
    if (r.status === 77) assert.fail("no Chromium found (set ZEVET_BROWSER_CHROME)"); // a missing browser is a failure once the venv exists: say so
    assert.equal(r.status, 0, `${name} failed:\n${(r.stderr || "").split(/\r?\n/).filter((l) => !/^(INFO|WARNING)\s/.test(l)).slice(-25).join("\n")}`);
    assert.match(r.stdout, new RegExp(`PASS ${name}`));
  });
}
