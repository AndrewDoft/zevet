"use strict";
// The implementation is client/zevet-home.mjs (it also ships to teammates'
// machines). Packaged, that file is in resources/client (extraResources);
// from a checkout it is next to this directory.
const fs = require("node:fs");
const path = require("node:path");

const packaged = process.resourcesPath && path.join(process.resourcesPath, "client", "zevet-home.mjs");
module.exports = require(packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, "..", "client", "zevet-home.mjs"));
