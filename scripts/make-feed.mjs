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
// What this does NOT do: upload anything. It prints a file. Publishing is a
// separate, deliberate step — see docs/RELEASING.md.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { psEnvWithoutModulePath } from "./lib/ps-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { readManifest } = createRequire(import.meta.url)("../desktop/app-update.js");

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
    // See scripts/lib/ps-env.mjs: launched from pwsh 7, the inherited
    // PSModulePath breaks Windows PowerShell's Security module autoload and
    // this call errors instead of reporting a signature status.
    const ps = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-AuthenticodeSignature '${file}').Status.ToString()`],
      { encoding: "utf8", windowsHide: true, env: psEnvWithoutModulePath() },
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

const dir = process.argv[2];
if (!dir || dir.startsWith("--")) {
  console.error("usage: node scripts/make-feed.mjs <artifact-dir> [--out FILE] [--notes TEXT]");
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

const feed = { version, notes: arg("--notes", ""), platforms };
// Apply the reader's own validation before writing something no installed
// machine can use (for example a zero-byte file from an interrupted build).
for (const key of Object.keys(platforms)) {
  const { error } = readManifest(feed, key);
  if (error) {
    console.error(error);
    process.exit(1);
  }
}
const out = arg("--out", path.join(dir, "zevet-latest.json"));
writeFileSync(out, JSON.stringify(feed, null, 2) + "\n", "utf8");

console.log(`zevet ${version}`);
for (const line of found) console.log("  " + line);
if (Object.keys(platforms).length !== TARGETS.length) {
  console.log("  (incomplete: a platform with no entry simply gets no updates)");
}
console.log(`wrote ${out}`);
