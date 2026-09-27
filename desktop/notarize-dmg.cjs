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
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  for (const p of buildResult.artifactPaths) {
    if (!p.endsWith(".dmg")) continue;
    console.log(`  • notarizing ${p}`);
    execFileSync(
      "xcrun",
      ["notarytool", "submit", p, "--apple-id", APPLE_ID, "--password", APPLE_APP_SPECIFIC_PASSWORD, "--team-id", APPLE_TEAM_ID, "--wait"],
      { stdio: "inherit" },
    );
    console.log(`  • stapling ${p}`);
    execFileSync("xcrun", ["stapler", "staple", p], { stdio: "inherit" });
  }
  return [];
};
