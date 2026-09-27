"use strict";

// electron-builder 25.1.8's own certificate import (createKeychain/importCerts in
// app-builder-lib/out/codeSign/macCodeSign.js) passes the CERTIFICATE's own export
// password (CSC_KEY_PASSWORD) to `security set-key-partition-list -k`, which needs
// the KEYCHAIN's password instead -- always a different, randomly generated value.
// Every CSC_LINK-based signed build therefore fails at packaging with:
//
//   security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
//
// Reproduced this session on both a real Codemagic build and a real GitHub Actions
// macos-latest runner. Confirmed as an upstream bug, already fixed upstream:
//   "fix(mac): pass the keychain password to security set-key-partition-list" (#10101),
//   electron-builder@26.16.0 (2026-09-02) -- a major version ahead of the 25.1.8 this
//   project is pinned to. Bumping across a major version mid-signing-rollout is a
//   bigger call than this patch; this is the smaller one until that bump is verified.
//
// ponytail: pinned-version workaround, ceiling = electron-builder 25.1.8's own bug.
// Upgrade path: bump electron-builder (and app-builder-lib) to >=26.16.0, re-run a
// signed build to confirm nothing else in the 26.x line changed, then delete this
// file and its postinstall wiring in package.json.
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "node_modules/app-builder-lib/out/codeSign/macCodeSign.js");
if (!fs.existsSync(file)) {
  console.log("patch-electron-builder-keychain: app-builder-lib not installed (mac codesign unused on this platform) — skipping");
  process.exit(0);
}

let src = fs.readFileSync(file, "utf8");

const already = src.includes("return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);");
if (already) {
  console.log("patch-electron-builder-keychain: already patched");
  process.exit(0);
}

const before = src;
src = src
  .replace(
    "return await importCerts(keychainFile, certPaths, cscPasswords);",
    "return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);",
  )
  .replace(
    "async function importCerts(keychainFile, paths, keyPasswords) {",
    "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {",
  )
  .replace(
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]',
    '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]',
  );

if (src === before) {
  console.warn(
    "patch-electron-builder-keychain: expected pattern not found in " + file +
      " — app-builder-lib may have been upgraded past the bug (or changed shape). Not failing the install; " +
      "if a signed mac build then fails at `set-key-partition-list`, this patch needs updating.",
  );
  process.exit(0);
}

fs.writeFileSync(file, src);
console.log("patch-electron-builder-keychain: patched " + file);
