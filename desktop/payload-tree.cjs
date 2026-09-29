// The payload tree: package.json's `payload.files`, copied to ./app-core. electron-builder ships that
// directory as resources/app-core (the seed the installer carries), and the release publisher hashes the
// same directory (scripts/make-feed.mjs payload), so the seed and every published payload are one tree.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function stage(dest = path.join(__dirname, "app-core")) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of require("./package.json").payload.files) {
    const rel = entry.endsWith("/**") ? entry.slice(0, -3) : entry;
    fs.cpSync(path.join(__dirname, rel), path.join(dest, rel), { recursive: true });
  }
  // client/*.mjs (hook installer, secret, zevet-home) change with most releases too.
  fs.cpSync(path.join(__dirname, "..", "client"), path.join(dest, "client"), { recursive: true, filter: (s) => fs.statSync(s).isDirectory() || s.endsWith(".mjs") });
  // No package.json above the payload dir may decide how these files load.
  fs.writeFileSync(path.join(dest, "package.json"), '{"name":"zevet-payload","private":true}\n');
  return dest;
}

module.exports = { stage };
if (require.main === module) console.log(`staged ${stage()}`);
