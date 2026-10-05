// GitHub Actions windows-latest has been intermittently crashing a real NSIS
// installer with STATUS_ACCESS_VIOLATION (0xC0000005, decimal 3221225477) on
// its first execution -- reproduced 2026-09-28 against a completely
// unmodified, hook-free electron-builder installer (a v0.2.70 build with no
// customInit/preInit at all), which rules out anything in this repo's own
// NSIS code or Node spawn args. Cause not identified (Defender real-time
// scanning disabled in build.yml did not stop it recurring); shape matches a
// transient runner-image issue, not a logic bug -- a real logic bug produces
// a wrong RESULT (wrong install path, wrong version), never this exact,
// specific crash code.
//
// So: retry ONLY this exact exit code, nothing else. A real assertion
// failure, or the installer legitimately refusing (any other nonzero exit),
// still fails on the first attempt -- this must never turn into "keep
// retrying until something looks like success".
import { spawnSync } from "node:child_process";

export const ACCESS_VIOLATION_EXIT_CODE = 3221225477;

/**
 * spawnSync an installer, retrying up to `attempts` times total, but only
 * when the previous attempt's exit code was exactly
 * ACCESS_VIOLATION_EXIT_CODE. Returns the spawnSync result of the last
 * attempt (success or not) -- callers assert on `.status` exactly as they
 * would on a plain spawnSync result.
 */
export function spawnInstallerWithRetry(file, args, opts, attempts = 3) {
  let result;
  for (let i = 1; i <= attempts; i++) {
    result = spawnSync(file, args, opts);
    if (result.status !== ACCESS_VIOLATION_EXIT_CODE) return result;
    console.log(`installer exited ${ACCESS_VIOLATION_EXIT_CODE} (attempt ${i}/${attempts}) -- known transient runner crash, retrying: ${file} ${args.join(" ")}`);
  }
  return result;
}
