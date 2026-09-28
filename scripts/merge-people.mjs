// Merge duplicate people in a hub accounts file — only where the stored
// evidence PROVES they are one human (two signed-in rows that share a verified
// email; a pending invite typed for a signed-in person's verified email or
// their own login). Dry-run by default.
//
//   node scripts/merge-people.mjs <accounts.json> [more.json …]          # report only
//   node scripts/merge-people.mjs <accounts.json> --apply                # merge, after a .bak copy
//
// Idempotent: a second run reports 0 merges. Nothing here can prove that "andrew"
// and "@AndrewDoft" are the same person — typing a name is not evidence — so
// those are the owner's `combine` action in Settings → Account & Team. Stop the
// hub before --apply and start it after: the hub reads the file once at boot and
// would otherwise overwrite the merge with its own copy.
import { copyFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "../hub/accounts.mjs";

/** Enough of an address to recognise, not enough to read out. */
const redact = (s) => String(s).replace(/([^s@]{1,2})[^s@]*@/g, "$1***@");

export function run(file, { apply = false, out = console.log } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zevet-merge-"));
  const target = apply ? file : path.join(dir, "accounts.json");
  try {
    if (!apply) copyFileSync(file, target);
    else copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "")}`);
    const acc = new Accounts({ file: target });
    const before = acc.list().length;
    const done = acc.mergeProvable();
    for (const d of done) out(`  ${apply ? "merged" : "would merge"} ${redact(d.absorbed)} into ${redact(d.kept)} — ${redact(d.why)}`);
    out(`${path.basename(file)}: ${before} people, ${done.length} ${apply ? "merged" : "would merge"}, ${before - done.length} after`);
    return done.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("merge-people.mjs")) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    console.error("usage: node scripts/merge-people.mjs <accounts.json> [more.json …] [--apply]");
    process.exit(2);
  }
  console.log(apply ? "APPLYING" : "dry run (nothing written) — add --apply to merge");
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`no such file: ${f}`);
      process.exit(2);
    }
    run(f, { apply });
  }
}
