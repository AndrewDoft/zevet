const BS = String.fromCharCode(92); // one backslash, spelled so no layer of quoting can eat it

/** The test files named by failures' `location:` lines (TAP), or null when there is nothing safe to
 *  rerun: no failure, a failure that names no file, or so many files that it is no contention. */
export function failingFiles(tap, { max = 12 } = {}) {
  if (!/^\s*not ok \d+/m.test(tap)) return null;
  // TAP quotes Windows paths with every backslash doubled.
  const locs = [...tap.matchAll(/location: '(.+?\.test\.mjs):\d+:\d+'/g)].map((m) => m[1].split(BS + BS).join(BS));
  const files = [...new Set(locs)];
  return files.length && files.length <= max ? files : null;
}

const count = (out, name) => {
  const m = out.match(new RegExp(String.raw`^(?:ℹ|#) ${name} (\d+)`, "m"));
  return m ? Number(m[1]) : null;
};

/** What a finished node --test run means: "green", "rerun" (with the files), or "red" (with why).
 *  Cancelled tests (a before() hook threw, e.g. a hub or Electron that did not come up under load) are
 *  never green, but when their suite names its file they are rerun like any failure: ship gate,
 *  2026-10-01, a hub start that timed out cancelled 28 tests and went red without the rerun. */
export function gateVerdict(out, code) {
  const cancelled = count(out, "cancelled");
  if (cancelled === null) return { verdict: "red", why: "node --test's summary had no 'cancelled' line to read; cannot call this green." };
  if (code === 0 && cancelled === 0) return { verdict: "green" };
  const files = failingFiles(out);
  if (files) return { verdict: "rerun", files };
  if (cancelled > 0) return { verdict: "red", why: `${cancelled} test${cancelled === 1 ? "" : "s"} cancelled (a hook threw before they ran, commonly a missing Electron build — see desktop/node_modules/electron/path.txt). Cancelled is not the same as passed.` };
  return { verdict: "red", why: "" };
}
