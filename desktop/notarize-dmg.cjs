"use strict";

// Notarizes and staples the .dmg itself, separately from the .app.
//
// electron-builder's built-in notarize() only ever submits the .app (afterSign runs
// before the dmg target exists). The .dmg it builds afterward is an unsigned UDIF
// container with its own hash — the app inside being notarized does not give the dmg
// file a ticket of its own — so `spctl -a -vvv -t install` on the DOWNLOADED .dmg FILE
// and `xcrun stapler validate` on it both fail until the dmg is submitted too.
// `afterAllArtifactBuild` runs once every artifact (including the dmg) exists.
const { execFileSync } = require("node:child_process");
const { macSigning } = require("./signing.js");

module.exports = async function notarizeDmg(buildResult) {
  if (!macSigning()) return [];
  // App Store Connect API key, not an Apple ID + app-specific password: that
  // path locked the Apple ID twice on a bad credential; an API key cannot.
  // APPLE_API_KEY is already a filesystem path here (whatever the workflow
  // decoded it to before `npm run dist:mac` — see signing.js), same as what
  // electron-builder's own notarize() reads for the .app.
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  for (const p of buildResult.artifactPaths) {
    if (!p.endsWith(".dmg")) continue;
    console.log(`  • notarizing ${p}`);
    execFileSync(
      "xcrun",
      ["notarytool", "submit", p, "--key", APPLE_API_KEY, "--key-id", APPLE_API_KEY_ID, "--issuer", APPLE_API_ISSUER, "--wait"],
      { stdio: "inherit" },
    );
    console.log(`  • stapling ${p}`);
    execFileSync("xcrun", ["stapler", "staple", p], { stdio: "inherit" });
  }
  return [];
};
