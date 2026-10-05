// Is there anything to sign with? Two booleans, computed from the environment.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ WHY THIS IS A SEPARATE FILE AND NOT TWO CONSTANTS IN THE CONFIG
//
// Because it was two constants in the config, exported as `__signing` so the
// tests could read them, and electron-builder REFUSED TO BUILD:
//
//     ⨯ Invalid configuration object.
//       configuration has an unknown property '__signing'.
//
// Its schema validation is strict and closed — an unrecognised top-level key is
// a hard failure, not a warning. So the exported config object cannot carry one
// byte that is not electron-builder's own, which means anything a test wants to
// inspect has to live somewhere else. Here.
//
// The test suite had asserted `__signing` was present, which is to say it
// agreed with the bug and would have gone on agreeing with it forever. Nothing
// caught this but a real build — which is exactly the argument for wiring the
// pipeline up before there is a certificate to use it with, rather than on the
// day one arrives.
"use strict";

/**
 * Set, non-empty, and not just whitespace.
 *
 * ⚠️ AN ABSENT GITHUB SECRET EXPANDS TO AN EMPTY STRING, so every one of these
 * variables is PRESENT on every build and the empty value is the normal one.
 * `process.env.X !== undefined` would be true for a secret that does not exist,
 * which is how a build ends up half-signed.
 */
const has = (...names) => names.every((n) => typeof process.env[n] === "string" && process.env[n].trim() !== "");

/**
 * macOS: a Developer ID certificate AND notarisation credentials, or neither.
 *
 * ⚠️ ALL FIVE OR NONE. A certificate without notarisation produces an app that
 * is signed and STILL refused by Gatekeeper on any machine that downloaded it —
 * the worst outcome available, because it looks like the signing did not work
 * and the build log gives no clue why.
 *
 * Notarization is an App Store Connect API key (APPLE_API_KEY/_KEY_ID/_ISSUER),
 * not an Apple ID + app-specific password: the password path locked the Apple
 * ID twice in one afternoon on a bad credential, and an API key structurally
 * cannot do that. See app-builder-lib's own getNotarizeOptions() (macPackager.js)
 * "option 2: API key" — it needs exactly these three env vars and no team ID.
 * APPLE_API_KEY must be a FILESYSTEM PATH to the .p8 file by the time
 * electron-builder runs (that's what @electron/notarize's `appleApiKey` is
 * documented as, and what it passes straight through as `--key`), so the
 * secret (its base64) is decoded to a file and this env var repointed at that
 * path before `npm run dist:mac` — see build.yml.
 */
const macSigning = () =>
  has("CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER");

/**
 * Windows: Azure Trusted Signing. Three credentials for the service principal,
 * four values naming which account and certificate profile to sign with.
 */
const winSigning = () =>
  has(
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_CODE_SIGNING_ENDPOINT",
    "AZURE_CODE_SIGNING_ACCOUNT",
    "AZURE_CERT_PROFILE",
    "AZURE_PUBLISHER_NAME",
  );

module.exports = { has, macSigning, winSigning };
