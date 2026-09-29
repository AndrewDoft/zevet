// desktop/ consumes @masora/desktop-kit rather than carrying its own copies of
// the plumbing. Source assertions, in the repo's own style (see
// desktop-bridges.test.mjs for why): main.js cannot be imported outside Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const D = (f) => readFileSync(path.join(ROOT, "desktop", f), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

test("the kit is pinned to a tag, not a branch, and the lock records the commit", () => {
  const pkg = JSON.parse(D("package.json"));
  assert.match(pkg.dependencies["@masora/desktop-kit"], /^github:AndrewDoft\/desktop-kit#v\d+\.\d+\.\d+$/);
  const lock = JSON.parse(D("package-lock.json"));
  assert.match(lock.packages["node_modules/@masora/desktop-kit"].resolved, /desktop-kit\.git#[0-9a-f]{40}$/);
});

test("the signature, safe-open and IPC-guard modules are thin adapters over the kit", () => {
  for (const f of ["update-signing.js", "open-safe.js", "ipc-guard.js"]) {
    const src = strip(D(f));
    assert.match(src, /require\("@masora\/desktop-kit"\)/, `${f} does not use the kit`);
    assert.doesNotMatch(src, /node:crypto|shell\.openExternal|fileURLToPath/, `${f} reimplements what the kit owns`);
  }
  // The updater's trust checks (feed verify, sha, download) are the kit's; only platform install steps stay here.
  const upd = strip(D("app-update.js"));
  assert.match(upd, /class AppUpdater extends UpdaterCore/);
  assert.doesNotMatch(upd, /createHash|pipeline\(|verifySigned\(/, "app-update.js reimplements the kit's download/verify");
});

test("main.js takes the single-instance lock and the rotating log from the kit", () => {
  const main = strip(D("main.js"));
  assert.match(main, /singleInstance\(app,/);
  assert.doesNotMatch(main, /requestSingleInstanceLock/, "main.js still calls the raw lock");
  assert.match(main, /createLog\(\{ dir: app\.getPath\("logs"\), name: "zevet" \}\)/);
  assert.match(main, /for \(const level of \["warn", "error"\]\)[\s\S]{0,200}fileLog\[level\]\(\.\.\.a\)/, "warn/error are not teed to the file log");
  assert.match(main, /log: \(m\) => \{[\s\S]{0,200}fileLog\.info/, "the updater's log lines do not reach the file log");
});

test("family.js reads and writes the family dir through the kit, not with its own file code", () => {
  const fam = strip(D("family.js"));
  assert.match(fam, /require\("@masora\/desktop-kit"\)/);
  for (const call of ["kit.writeHeartbeat(", "kit.takeRequest(", "kit.writeRequest(", "kit.readKey(", "kit.masoraWeb(", "kit.isRunning("]) {
    assert.ok(fam.includes(call), `family.js no longer uses ${call}`);
  }
  assert.doesNotMatch(fam, /writeFileSync|renameSync|rmSync|mkdirSync/, "family.js writes family files itself");
  assert.doesNotMatch(fam, /function (familyDir|readJson)\b/, "family.js reimplements the kit's familyDir/readJson");
});
