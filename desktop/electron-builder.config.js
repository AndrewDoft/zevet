// The build config, with code signing wired up and switched off.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS INSTEAD OF JUST `build` IN package.json
//
// Signing is not a setting you can leave on. `hardenedRuntime: true` with no
// certificate, or `notarize` with no Apple ID, does not produce an unsigned
// build — it FAILS THE BUILD. So a static config can either sign or not sign,
// and switching between them means editing the file on the day you buy a
// certificate, in a hurry, without a test.
//
// This computes the config from the environment instead. With no signing
// secrets set — which is the state today, and the state on every fork and every
// pull request — it produces byte-for-byte what `build` in package.json always
// produced. Add the secrets to GitHub Actions and the same file starts signing.
// test/signing.test.mjs asserts both halves, so the day the certificate arrives
// is not the day this is exercised for the first time.
//
// Andrew, 2026-09-19, choosing "Neither yet — build the pipeline": wire it up,
// document which secrets to add, keep it a no-op until there is something to
// sign with.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT SIGNING ACTUALLY BUYS, so the purchase can be judged
//
// macOS — Apple Developer Program, 99 USD/year. Two separate things:
//   • Gatekeeper stops saying "zevet can't be opened because Apple cannot check
//     it for malicious software", which reads to everyone as "this is broken".
//   • ⚠️ AND IN-PLACE AUTO-UPDATE BECOMES POSSIBLE AT ALL. This is the bigger
//     one and it is easy to miss. macOS will not let an unsigned app replace
//     itself, so desktop/app-update.js opens the disk image and asks the person
//     to drag it across. Windows has had a real one-click update since 0.2.0;
//     macOS cannot until this is bought. See D-006 in DECISIONS.md.
//
// Windows — Azure Trusted Signing, about 10 USD/month. Removes the SmartScreen
// "Windows protected your PC" panel that hides the Run button behind "More
// info". Chosen over a traditional OV/EV certificate because those now require
// the private key on a hardware token, which cannot be used from a GitHub
// Actions runner without a cloud HSM anyway — so the cloud service is both
// cheaper and the only one that fits this pipeline.
//
// ⚠️ NEITHER IS A SECURITY CONTROL FOR ZEVET'S UPDATER. The update manifest and
// the file it names come from the same host, so the published sha256 proves the
// bytes arrived intact, not that the host is honest (desktop/app-update.js says
// so at length). Signing narrows that: a signed installer cannot be swapped for
// somebody else's, because the OS checks the signature before running it. It is
// a real improvement and it is not the same as the updater verifying a
// publisher key, which zevet still does not do.
"use strict";

const base = require("./package.json").build;

/** Set, non-empty, and not the literal placeholder a half-finished secret
 *  leaves behind. An empty GitHub secret expands to an empty string, so
 *  `process.env.X !== undefined` would be true for a secret that does not
 *  exist — which is exactly how a build ends up half-signed. */
const has = (...names) => names.every((n) => typeof process.env[n] === "string" && process.env[n].trim() !== "");

/* ── macOS ───────────────────────────────────────────────────────────────────
 *
 * `CSC_LINK` is the Developer ID Application certificate as a base64 .p12, and
 * `CSC_KEY_PASSWORD` its password; electron-builder reads both by name without
 * being told. Notarisation needs an Apple ID, an APP-SPECIFIC PASSWORD (not the
 * account password) and the team id.
 *
 * ⚠️ ALL FIVE OR NONE. A certificate without notarisation produces an app that
 * is signed and STILL refused by Gatekeeper on a machine that downloaded it,
 * which is the worst outcome available: it looks like signing did not work, and
 * the build gives no clue why. */
const MAC_SIGNING = has("CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID");

/* ── Windows ─────────────────────────────────────────────────────────────────
 *
 * Azure Trusted Signing. The three AZURE_* credentials are the service
 * principal; the other three name which account and certificate profile to sign
 * with. `publisherName` MUST match the certificate's subject exactly or NSIS
 * rejects its own signature at install time. */
const WIN_SIGNING = has(
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_ACCOUNT",
  "AZURE_CERT_PROFILE",
  "AZURE_PUBLISHER_NAME",
);

module.exports = {
  ...base,

  mac: {
    ...base.mac,
    ...(MAC_SIGNING
      ? {
          // Notarisation is refused without the hardened runtime, so these two
          // are one setting with two names.
          hardenedRuntime: true,
          // The default entitlements electron-builder ships are correct for an
          // Electron app; a custom plist is only needed for camera, microphone
          // or the like, and zevet asks for none of them.
          notarize: { teamId: process.env.APPLE_TEAM_ID },
          // ⚠️ LEFT ON ONLY WHEN SIGNING. `gatekeeperAssess` runs spctl against
          // the build, and on an unsigned build it fails — correctly, and
          // uselessly, because the build being unsigned is the known state.
          gatekeeperAssess: true,
        }
      : {
          identity: null,
        }),
  },

  win: {
    ...base.win,
    ...(WIN_SIGNING
      ? {
          azureSignOptions: {
            publisherName: process.env.AZURE_PUBLISHER_NAME,
            endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
            certificateProfileName: process.env.AZURE_CERT_PROFILE,
          },
        }
      : {}),
  },

  /** Exported for the tests and for anyone reading a build log that says
   *  "signing is skipped" and wanting to know whether that was on purpose. */
  __signing: { mac: MAC_SIGNING, win: WIN_SIGNING },
};
