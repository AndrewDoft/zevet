"use strict";
// The IPC seam: every `ipc/*.js` adds channels to one of ipc-table.js's tables, so a batch writes
// its bridge calls in its own file and `npm run ipc:gen` stays the single generator.
//
// A fragment is `module.exports = { table: "zevet" | "zevetLocal" | "zevetDoc", calls, events, constants }`,
// entries written exactly as in ipc-table.js. A name already in the table (or in another fragment)
// throws, as does a bad table, so two batches can never silently shadow one another.
// Types in a fragment must be self-contained (`import("./x").T`): the generated .d.ts header is the table's.
const fs = require("node:fs");
const path = require("node:path");

const IPC_DIR = path.join(__dirname, "ipc");
const PARTS = ["calls", "events", "constants"];

function readFragments(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".js")).sort();
  } catch {
    return [];
  }
  return names.map((n) => ({ file: n, ...require(path.join(dir, n)) }));
}

/** `spec` (a defineIpc argument) plus every fragment aimed at `table`. */
function withFragments(table, spec, dir = IPC_DIR, fragments = readFragments(dir)) {
  const out = { ...spec };
  for (const p of PARTS) if (spec[p]) out[p] = { ...spec[p] };
  for (const f of fragments) {
    if (f.table !== table) continue;
    for (const p of PARTS) {
      for (const [name, entry] of Object.entries(f[p] || {})) {
        out[p] = out[p] || {};
        if (name in out[p]) throw new Error(`ipc/${f.file}: ${p} "${name}" is already defined in table ${table}`);
        out[p][name] = entry;
      }
    }
  }
  return out;
}

/** A fragment naming no real table would vanish silently; fail instead. */
function assertFragmentTargets(tableNames, dir = IPC_DIR, fragments = readFragments(dir)) {
  for (const f of fragments) {
    if (!tableNames.includes(f.table)) throw new Error(`ipc/${f.file}: table "${f.table}" is not one of ${tableNames.join(", ")}`);
  }
}

module.exports = { withFragments, assertFragmentTargets, readFragments, IPC_DIR };
