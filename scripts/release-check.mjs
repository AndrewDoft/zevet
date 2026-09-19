// zevet release check — is this tree actually shippable as a version?
//
// The 0.2.0 skew is why this exists: main moved to 0.2.1 plus new client
// files while production kept serving the 0.2.0 manifest, and nothing anywhere
// said so. `npm test` proves the tree works; this proves it is releasable:
// versions agree, the tree is clean, the tag is new, and the client-file lists
// agree. Green here plus green gate licenses `docs/RELEASING.md`.
//
//   node scripts/release-check.mjs
//
// Exit 0 with the deploy commands, or non-zero naming the first problem.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(why) {
  console.error(`release-check: ${why}`);
  process.exitCode = 1;
}

/** The two version files must name the same version. */
export function checkVersions(root = ROOT) {
  const main = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const desktop = JSON.parse(readFileSync(path.join(root, "desktop", "package.json"), "utf8")).version;
  if (main !== desktop) return `package.json says ${main} but desktop/package.json says ${desktop}`;
  // electron-builder rejects anything but MAJOR.MINOR.PATCH — 0.2.5.1 died in
  // CI with `Invalid version`, after the tag was already pushed.
  if (!/^\d+\.\d+\.\d+$/.test(main)) return `${main} is not MAJOR.MINOR.PATCH; electron-builder will refuse it`;
  return null;
}

/** hub/server.mjs, client/doctor.mjs and the files on disk must agree. */
export function checkClientFiles(root = ROOT) {
  const names = (file, marker) => {
    const text = readFileSync(path.join(root, file), "utf8");
    const block = text.slice(text.indexOf(marker), text.indexOf("];", text.indexOf(marker)));
    return [...block.matchAll(/"([a-z0-9-]+\.mjs)"/g)].map((m) => m[1]).sort();
  };
  const shipped = names("hub/server.mjs", "const CLIENT_FILES");
  const doctor = names("client/doctor.mjs", "const CLIENT_FILES");
  if (JSON.stringify(shipped) !== JSON.stringify(doctor)) {
    return `hub serves [${shipped}] but doctor expects [${doctor}]`;
  }
  const missing = shipped.filter((n) => !existsSync(path.join(root, "client", n)));
  if (missing.length) return `CLIENT_FILES names missing files: ${missing.join(", ")}`;
  return null;
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, stdio: "pipe", encoding: "utf8" }).trim();
}

function main() {
  const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

  const v = checkVersions();
  if (v) return fail(v);

  if (git("status", "--porcelain")) return fail("tree is not clean — commit first");

  let tagged = true;
  try {
    git("rev-parse", `v${version}`);
  } catch {
    tagged = false;
  }
  if (tagged) return fail(`v${version} is already tagged — bump the version first`);

  const c = checkClientFiles();
  if (c) return fail(c);

  console.log(`zevet ${version} is releasable.`);
  console.log("");
  console.log("Hub (tarball over /srv/zevet, then restart):");
  console.log(`  git archive --format=tar.gz -o zevet-${version}.tar.gz v${version}`);
  console.log(`  gcloud compute scp --tunnel-through-iap --zone us-east1-b zevet-${version}.tar.gz masora-app:/tmp/`);
  console.log("  gcloud compute ssh masora-app --tunnel-through-iap --zone us-east1-b --command '");
  console.log(`    sudo tar -czf /srv/masora/zevet-tree.bak-$(date +%Y%m%d-%H%M%S).tar.gz -C /srv zevet`);
  console.log(`    sudo tar -xzf /tmp/zevet-${version}.tar.gz -C /srv/zevet`);
  console.log(`    sudo docker restart masora-zevet-hub-1'`);
  console.log("App artifacts come from the v-tag CI build; see docs/RELEASING.md §1-4.");
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
