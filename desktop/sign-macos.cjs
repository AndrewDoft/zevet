"use strict";

// electron-builder 25 skips signing entirely when no certificate is present.
// That leaves Electron's linker signature attached to a modified app bundle,
// and codesign rejects it as having missing resources. Seal the finished app
// even for local/unsigned builds. An ad-hoc seal proves bundle integrity only:
// it does not identify a publisher, notarize the app, or satisfy Gatekeeper.
// Run after packing, rather than as mac.sign: identity:null deliberately skips
// the normal signer before a custom mac.sign callback could run. Keeping that
// setting also prevents partial credentials from importing a certificate or
// attempting notarization. Fully configured releases use the normal signer.
const path = require("node:path");
const { macSigning } = require("./signing.js");

module.exports = async function sealUnsignedMac(context) {
  if (context.electronPlatformName !== "darwin" || macSigning()) return;
  const { signAsync } = require("@electron/osx-sign");
  const entitlements = require.resolve("app-builder-lib/templates/entitlements.mac.plist");
  console.log("  • sealing macOS bundle with an ad-hoc signature (not notarized)");
  return signAsync({
    app: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    platform: "darwin",
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    // Omit strictVerify: osx-sign 1.3.1 uses bare --strict by default.
    // Passing true incorrectly emits --strict=true, which codesign rejects.
    optionsForFile: () => ({
      // Use the same JIT/native-library entitlements as electron-builder's
      // regular signer, so the hardened Electron runtime can execute on ARM.
      entitlements,
      hardenedRuntime: true,
      // Ad-hoc signatures have no certificate to timestamp.
      timestamp: "none",
    }),
  });
};
