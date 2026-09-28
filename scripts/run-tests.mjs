#!/usr/bin/env node
// Runs the suite and makes a CANCELLED test loud.
//
// node --test reports a test that never got to run — most often a `before()`
// hook throwing, which happens whenever scripts/drive/drive.mjs cannot find
// Electron — as "cancelled", a category the printed summary keeps SEPARATE
// from "fail". A person skimming a CI log for "fail 0" reads that as green
// and never looks at the "cancelled" line sitting right above it. This
// wrapper reads that line itself and refuses to call the run clean if it is
// not zero, on top of node's own exit code (kept, not replaced: a real
// failure must still fail this the way it always has).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fresh clone: the tests that need root (playwright-core) or editor (yjs) deps
// used to die with MODULE_NOT_FOUND. Install them; if that fails (offline), say
// so — those tests then SKIP with their own reason instead of failing.
for (const [dir, marker] of [[".", "playwright-core"], ["editor", "yjs"]]) {
  if (existsSync(path.join(ROOT, dir, "node_modules", marker))) continue;
  console.error(`run-tests: ${dir}/node_modules/${marker} missing — running npm ci in ${dir}`);
  const r = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: path.join(ROOT, dir),
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) console.error(`run-tests: npm ci in ${dir} failed — the tests that need it will be SKIPPED, not passed.`);
}

const child = spawn(
  process.execPath,
  ["--test", "test/**/*.test.mjs", "editor/test/**/*.test.mjs"],
  { cwd: ROOT, stdio: ["inherit", "pipe", "pipe"] },
);

let out = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  out += chunk;
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  out += chunk;
});

child.on("close", (code) => {
  // node --test prints this summary with an "ℹ " prefix on a TTY (spec
  // reporter) and a bare "# " prefix once stdout is piped, as it always is
  // here (CI, and this script's own spawn) — the TAP reporter. Both must match
  // or CI always hits the "no cancelled line" branch below regardless of the
  // actual run.
  const m = out.match(/^(?:ℹ|#) cancelled (\d+)/m);
  if (!m) {
    console.error("\nGATE RED — node --test's summary had no 'cancelled' line to read; cannot call this green.");
    process.exit(1);
  }
  const skipped = Number((out.match(/^(?:ℹ|#) skipped (\d+)/m) || [])[1] || 0);
  if (skipped > 0) console.error(`\nNOTE — ${skipped} test${skipped === 1 ? "" : "s"} SKIPPED (not passed); the reason is on each skipped line above.`);
  const cancelled = Number(m[1]);
  if (cancelled > 0) {
    console.error(
      `\nGATE RED — ${cancelled} test${cancelled === 1 ? "" : "s"} cancelled (a hook threw before they ran, ` +
        "commonly a missing Electron build — see desktop/node_modules/electron/path.txt). " +
        "Cancelled is not the same as passed.",
    );
    process.exit(1);
  }
  process.exit(code ?? 1);
});
