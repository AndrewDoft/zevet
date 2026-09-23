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
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
