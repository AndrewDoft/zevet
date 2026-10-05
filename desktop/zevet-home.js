"use strict";
// The implementation is client/zevet-home.mjs (it also ships to teammates'
// machines). Packaged, that file is in resources/client (extraResources);
// from a checkout it is next to this directory.
const fs = require("node:fs");
const path = require("node:path");

// The payload carries its own copy (payload-tree.cjs), which wins over the installer's.
const candidates = [
  path.join(__dirname, "client", "zevet-home.mjs"),
  process.resourcesPath && path.join(process.resourcesPath, "client", "zevet-home.mjs"),
  path.join(__dirname, "..", "client", "zevet-home.mjs"),
];
module.exports = require(candidates.find((f) => f && fs.existsSync(f)));
