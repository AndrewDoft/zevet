"use strict";

// Staples the notarization ticket onto the .app.
//
// electron-builder's own notarize() (see electron-builder.config.js / signing.js)
// submits the .app and waits for Apple to approve it, but it never staples anything
// (verified against node_modules/app-builder-lib 25.1.8 and @electron/notarize 2.5.0
// this session: no `staple` call anywhere in either package). A notarized-but-unstapled
// app still passes `spctl` ONLINE, but fails `xcrun stapler validate` and fails spctl on
// a machine with no network at first launch. `afterSign` is the right hook for this: it
// runs "after pack and sign" — i.e. after the built-in notarization has already
// completed — and before the dmg is built, so the dmg ships the stapled .app.
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { macSigning } = require("./signing.js");

module.exports = async function stapleMacApp(context) {
  if (context.electronPlatformName !== "darwin" || !macSigning()) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • stapling notarization ticket to ${app}`);
  execFileSync("xcrun", ["stapler", "staple", app], { stdio: "inherit" });
};
