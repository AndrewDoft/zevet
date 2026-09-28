// Writes the update feed the desktop app reads.
//
//   node scripts/make-feed.mjs <artifact-dir> [--out zevet-latest.json] [--notes "…"]
//
// ⚠️ THE FEED IS GENERATED FROM THE FILES, NEVER TYPED. Every field in it —
// the version, the file name, the length, the checksum — is read off the
// artifacts that are about to be published. A hand-written feed is one
// transposed character away from a checksum that does not match, which the
// updater correctly refuses, which looks to a whole team like the update is
// broken. It happened to nobody here yet because this script exists.
//
// The version is taken from the ARTIFACT NAMES rather than from package.json,
// and the two are cross-checked. electron-builder puts the version in the file
// name, so a stale package.json or a rebuilt-but-not-renamed artifact shows up
// here as a disagreement rather than as a feed that advertises 0.2.0 and
// serves 0.1.2.
//
// SIGNING. The feed is signed with Ed25519 (domain "zevet-update-v1", key id
// zevet-2026-09; see desktop/update-signing.js). The private PEM comes from the
// environment and is never logged or written:
//
//   ZEVET_UPDATE_SIGNING_KEY=<PEM>            (GitHub Actions secret of that name)
//   locally: $env:ZEVET_UPDATE_SIGNING_KEY = (pwsh -NoProfile -File C:/Users/andre/.claude/bin/update-signing-key.ps1 zevet | Out-String)
//
//   node scripts/make-feed.mjs <dir> ...              generate AND sign
//   node scripts/make-feed.mjs --sign-only <feed.json> re-sign a published feed in place
//   node scripts/make-feed.mjs <dir> --test-key <f>   sign with a throwaway key, write its
//                                                     public half to <f> (loopback proofs only)
//
// The signed payload is {schema, type, version, notes, platforms}. The legacy
// top-level version/notes/platforms are kept, identical, so installed clients
// that predate signing keep updating; new clients read only the payload.
//
// What this does NOT do: upload anything. It prints a file. Publishing is a
// separate, deliberate step — see docs/RELEASING.md.
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { readManifest } = require("../desktop/app-update.js");
const { UPDATE_DOMAIN, PINNED_KEYS, signDocument, verifySigned } = require("../desktop/update-signing.js");
const KEY_ID = Object.keys(PINNED_KEYS)[0];

/** {schema,type,version,notes,platforms} -> the feed with payload + signature. */
function signedFeed({ version, notes, platforms }, { pem, keyId, keys }) {
  const payload = { schema: 1, type: "zevet-update", version, notes, platforms };
  const signature = signDocument(UPDATE_DOMAIN, payload, pem, keyId);
  // Read it back with the verifier the app will use, so a wrong key fails here.
  verifySigned(UPDATE_DOMAIN, payload, signature, keys);
  return { version, notes, platforms, payload, signature };
}

/** The key to sign with: the real one from the environment, or a throwaway
 *  (--test-key FILE writes its public half to FILE) for loopback proofs. */
function signer() {
  const testKeyOut = arg("--test-key");
  if (testKeyOut) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    writeFileSync(testKeyOut, JSON.stringify({ key_id: "zevet-test", public_key: raw }) + "\n", "utf8");
    return { pem: privateKey.export({ format: "pem", type: "pkcs8" }), keyId: "zevet-test", keys: { "zevet-test": raw } };
  }
  const pem = (process.env.ZEVET_UPDATE_SIGNING_KEY || "").replaceAll("|", "\n").trim();
  if (!pem) {
    console.error("ZEVET_UPDATE_SIGNING_KEY is not set: refusing to write an unsigned feed (see the header)");
    process.exit(1);
  }
  return { pem, keyId: KEY_ID, keys: PINNED_KEYS };
}

/**
 * Which artifact belongs to which machine.
 *
 * The keys are `${process.platform}-${process.arch}` and must match
 * desktop/app-update.js's platformKey(). The patterns are electron-builder's
 * `artifactName` templates from desktop/package.json with the version taken
 * out; changing one there means changing it here, and the mismatch surfaces as
 * "no artifact for win32-x64" rather than as a silent omission.
 */
const TARGETS = [
  { key: "win32-x64", re: /^zevet-(\d+(?:\.\d+)*)-windows-x64-setup\.exe$/ },
  { key: "darwin-arm64", re: /^zevet-(\d+(?:\.\d+)*)-macos-arm64\.dmg$/ },
];

/**
 * The masora2 incident this guards against: a manual `gcloud compute scp`
 * upload (docs/RELEASING.md §2/§4) that lands a truncated or otherwise
 * corrupted installer. Nothing before this hashed whatever bytes happened to
 * be in the release directory, self-consistently -- a bad file "verifies"
 * against its own bad hash all the way to a machine that downloads it and
 * gets nothing (exit 0, no zevet.exe). A truncated PE fails Authenticode
 * verification (the signature covers a hash of the file), which is a much
 * stronger, independent check than re-hashing the same bytes.
 *
 * ponytail: no per-platform min-size table, one floor for both artifacts --
 * raise it (or add a real expected-size check) if a legitimately smaller
 * build ever trips it.
 */
const MIN_ARTIFACT_BYTES = 20 * 1024 * 1024;
function verifyArtifactIntegrity(file, key) {
  // test/make-feed.test.mjs writes fixture files a few bytes long on purpose,
  // to test the versioning/mixed-release logic without needing a real
  // installer -- this check is about THAT logic, not this one.
  if (process.env.MAKE_FEED_SKIP_ARTIFACT_CHECK) return null;
  const bytes = statSync(file).size;
  if (bytes < MIN_ARTIFACT_BYTES) {
    return `${path.basename(file)} is only ${bytes} bytes (< ${MIN_ARTIFACT_BYTES}) -- looks truncated, not publishing it`;
  }
  if (key === "win32-x64" && process.platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-AuthenticodeSignature '${file}').Status.ToString()`],
      { encoding: "utf8", windowsHide: true },
    );
    const status = (ps.stdout || "").trim();
    if (status === "NotSigned") {
      console.log(`  (${path.basename(file)} carries no Authenticode signature -- unsigned dev build, not verifying it)`);
    } else if (status !== "Valid") {
      return `${path.basename(file)} Authenticode status is ${status || `unknown (${ps.stderr || ps.error})`}, not "Valid" -- looks corrupted, not publishing it`;
    }
  }
  return null;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[2] === "--sign-only") {
  const file = process.argv[3];
  if (!file) {
    console.error("usage: node scripts/make-feed.mjs --sign-only <feed.json> [--out FILE]");
    process.exit(2);
  }
  const old = JSON.parse(readFileSync(file, "utf8"));
  const src = old.payload || old; // re-signing a signed feed re-signs its payload
  const feed = signedFeed(src, signer());
  writeFileSync(arg("--out", file), JSON.stringify(feed, null, 2) + "\n", "utf8");
  console.log(`signed ${arg("--out", file)} (zevet ${feed.version})`);
  process.exit(0);
}

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.error("usage: node scripts/make-feed.mjs <artifact-dir> [--out FILE] [--notes TEXT] [--test-key FILE]\n       node scripts/make-feed.mjs --sign-only <feed.json>");
  process.exit(2);
}

const names = readdirSync(dir);
const platforms = {};
const versions = new Set();
const found = [];

for (const t of TARGETS) {
  const hits = names.filter((n) => t.re.test(n));
  if (hits.length > 1) {
    console.error(`multiple artifacts for ${t.key}: ${hits.join(", ")} — use an empty release directory`);
    process.exit(1);
  }
  const [hit] = hits;
  if (!hit) {
    console.error(`!! no artifact for ${t.key} in ${dir}`);
    continue;
  }
  const version = t.re.exec(hit)[1];
  versions.add(version);
  const full = path.join(dir, hit);
  const integrityProblem = verifyArtifactIntegrity(full, t.key);
  if (integrityProblem) {
    console.error(integrityProblem);
    process.exit(1);
  }
  const bytes = statSync(full).size;
  const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
  platforms[t.key] = { file: hit, bytes, sha256 };
  found.push(`${t.key}  ${hit}  ${bytes} bytes  ${sha256.slice(0, 16)}…`);
}

if (!Object.keys(platforms).length) {
  console.error("no artifacts found — nothing to publish");
  process.exit(1);
}

// ⚠️ A FEED THAT ADVERTISES ONE VERSION AND SERVES ANOTHER IS THE WHOLE FAILURE
// THIS GUARDS. Two artifacts from different builds in one directory is an easy
// mistake (the out/ directory is not cleaned between runs) and the result is a
// team half-upgraded with no error anywhere.
if (versions.size !== 1) {
  console.error(`the artifacts disagree about the version: ${[...versions].join(", ")}`);
  process.exit(1);
}
const version = [...versions][0];

const pkg = JSON.parse(readFileSync(path.join(ROOT, "desktop", "package.json"), "utf8"));
if (pkg.version !== version) {
  console.error(`desktop/package.json says ${pkg.version} but the artifacts say ${version}`);
  process.exit(1);
}

const unsigned = { version, notes: arg("--notes", ""), platforms };
// Apply the reader's own validation before writing something no installed
// machine can use (for example a zero-byte file from an interrupted build).
for (const key of Object.keys(platforms)) {
  const { error } = readManifest(unsigned, key);
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
const feed = signedFeed(unsigned, signer());
const out = arg("--out", path.join(dir, "zevet-latest.json"));
writeFileSync(out, JSON.stringify(feed, null, 2) + "\n", "utf8");

console.log(`zevet ${version}`);
for (const line of found) console.log("  " + line);
if (Object.keys(platforms).length !== TARGETS.length) {
  console.log("  (incomplete: a platform with no entry simply gets no updates)");
}
console.log(`wrote ${out}`);
