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
