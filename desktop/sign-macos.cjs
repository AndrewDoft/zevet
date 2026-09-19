"use strict";

// electron-builder 25 skips signing entirely when no certificate is present.
// That leaves Electron's linker signature attached to a modified app bundle,
// and codesign rejects it as having missing resources. Seal the finished app
// even for local/unsigned builds. An ad-hoc seal proves bundle integrity only:
// it does not identify a publisher, notarize the app, or satisfy Gatekeeper.
// If a real signing identity is configured, preserve the normal signing path.
module.exports = async function signMacOS(options) {
  const { signAsync } = require("@electron/osx-sign");
  if (options.identity) return signAsync(options);
  console.log("  • sealing macOS bundle with an ad-hoc signature (not notarized)");
  return signAsync({
    ...options,
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    optionsForFile: (file) => ({
      ...options.optionsForFile(file),
      // Ad-hoc signatures have no certificate to timestamp.
      timestamp: "none",
    }),
  });
};
