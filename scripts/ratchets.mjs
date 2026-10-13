#!/usr/bin/env node
// The ratchets: counts that may only go DOWN. Each has a baseline in config/<name>-baseline.txt
// holding what is grandfathered today; a new entry (or growth) fails, and so does a baseline row
// that no longer matches (prune it, so it can never grow back).
//
//   npm run ratchet                run all        npm run ratchet -- --prune   lower baselines to today
//   npm run ratchet -- max-lines   run one        npm run ratchet -- --init    rewrite from today (review the diff!)
//
// Framework: scripts/ratchet-baseline.mjs, ported from Orca (MIT; licence in that file's header).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listTrackedFiles, readTrackedSources, runCountRatchet, runEntryRatchet } from "./ratchet-baseline.mjs";

const CODE = ["*.js", "*.mjs", "*.cjs", "*.ts", "*.tsx"];
// hub/public is a committed build artefact; tests exercise the product, they are not it.
const notBuilt = (rel) => !rel.startsWith("hub/public/");
const isProduct = (rel) => notBuilt(rel) && !/(^|\/)test\//.test(rel) && !/\.test\.[mc]?[jt]sx?$/.test(rel);
const lines = (src) => (src.endsWith("\n") ? src.split("\n").length - 1 : src.split("\n").length);

export const MAX_LINES = 1000;
export function collectMaxLines(root) {
  const out = new Map();
  for (const [rel, src] of readTrackedSources(root, CODE, notBuilt)) {
    if (lines(src) > MAX_LINES) out.set(rel, lines(src));
  }
  return out;
}

export function collectTsNocheck(root) {
  const out = new Map();
  for (const [rel, src] of readTrackedSources(root, CODE, isProduct)) {
    const n = src.split("\n").filter((l) => /^\s*(\/\/|\/\*)\s*@ts-nocheck\b/.test(l)).length;
    if (n) out.set(rel, n);
  }
  return out;
}

const SPAWN = /(?<![.\w])(?:(\w+)\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/g;
// `re.exec(s)` is a regex, not a launch: a qualified call counts only on the child_process module itself.
const CP_NAMES = new Set(["cp", "child_process", "childProcess", "proc"]);
/** Direct child_process launches per file, in files that load child_process at all. */
export function collectSpawns(root) {
  const out = new Map();
  for (const [rel, src] of readTrackedSources(root, CODE, isProduct)) {
    if (!/child_process/.test(src)) continue;
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const n = [...code.matchAll(SPAWN)].filter((m) => !m[1] || CP_NAMES.has(m[1])).length;
    if (n) out.set(rel, n);
  }
  return out;
}

/** Top-level entries of the repo (tracked), so a new root-level file or folder is a decision, not an accident. */
export function collectRootEntries(root) {
  return [...new Set(listTrackedFiles(root, []).map((f) => f.split("/")[0]))].sort();
}

export const RATCHETS = [
  {
    kind: "count",
    name: "max-lines",
    baselinePath: "config/max-lines-baseline.txt",
    header: [`# Files over ${MAX_LINES} lines (physical lines), grandfathered at today's size. A RATCHET: rows only shrink.`, "# A bigger file, or a new one over the limit, fails. Split the file; do not raise the row."],
    collect: collectMaxLines,
    fix: [`A file over ${MAX_LINES} lines grew, or a new one crossed it. Put new code in its own module (desktop/mods/, desktop/ipc/, board/src/ext/; see docs/extending.md) instead.`],
  },
  {
    kind: "count",
    name: "ts-nocheck",
    baselinePath: "config/ts-nocheck-baseline.txt",
    header: ["# Files carrying a `@ts-nocheck` directive. A RATCHET: rows only shrink; none is the goal."],
    collect: collectTsNocheck,
    fix: ["`@ts-nocheck` turns the type checker off for a whole file. Fix the types instead."],
  },
  {
    kind: "count",
    name: "child-process",
    baselinePath: "config/child-process-baseline.txt",
    header: ["# Direct child_process launches (spawn/exec/execFile/fork, sync or not) per non-test file. A RATCHET: counts only go down."],
    collect: collectSpawns,
    fix: ["A new direct child_process launch. Go through the existing launcher for that job (agent-console.js, agent-spawn.js, a shared helper) so cleanup, windowsHide and arg checks stay in one place."],
  },
  {
    kind: "entries",
    name: "root-entries",
    baselinePath: "config/root-entries-baseline.txt",
    header: ["# Top-level entries of the repository. A RATCHET: the list only shrinks."],
    collect: collectRootEntries,
    fix: ["A new top-level file or folder. Put it under the folder it belongs to; the root is not a place to add to."],
  },
];

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  const flag = argv.find((a) => a.startsWith("--"));
  if (flag && !["--init", "--prune"].includes(flag)) {
    console.error(`ratchet: unknown flag ${flag}; have --init, --prune`);
    return 1;
  }
  const only = argv.filter((a) => !a.startsWith("--"));
  const picked = RATCHETS.filter((r) => !only.length || only.includes(r.name));
  if (!picked.length) {
    console.error(`ratchet: no such ratchet ${only.join(", ")}; have ${RATCHETS.map((r) => r.name).join(", ")}`);
    return 1;
  }
  let status = 0;
  for (const r of picked) status |= (r.kind === "count" ? runCountRatchet : runEntryRatchet)(r, root, flag);
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main());
