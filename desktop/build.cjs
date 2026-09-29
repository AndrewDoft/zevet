// Preserve electron-builder's CLI options, then give the finished DMG the Finder
// background bookmark macOS 14+ needs. electron-builder 26 hands back a sealed,
// read-only image (dmgbuild), so it is reopened read-write here, fixed, and
// re-compressed before it is signed-off or given an update checksum.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { build } = require("electron-builder");
const { createYargs, configureBuildCommand } = require("electron-builder/out/builder");
const { loadEnv } = require("app-builder-lib/out/util/config/load");

function addBackgroundBookmark(dmg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-dmg-"));
  const rw = path.join(dir, "rw.dmg");
  const mount = path.join(dir, "mnt");
  const hdiutil = (...a) => execFileSync("hdiutil", a, { stdio: "inherit", timeout: 120_000 });
  fs.mkdirSync(mount);
  try {
    hdiutil("convert", dmg, "-format", "UDRW", "-o", rw);
    hdiutil("attach", rw, "-nobrowse", "-noautoopen", "-mountpoint", mount);
    try {
      execFileSync(process.env.PYTHON_PATH || "python3", [
        path.join(__dirname, "../scripts/prepare-dmg-background.py"), mount,
      ], { stdio: "inherit", timeout: 60_000 });
    } finally {
      hdiutil("detach", mount);
    }
    fs.rmSync(dmg);
    hdiutil("convert", rw, "-format", "UDZO", "-o", dmg);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

createYargs().command(["build", "*"], "Build", configureBuildCommand, async (args) => {
  try {
    await loadEnv(path.join(process.cwd(), "electron-builder.env"));
    const artifacts = await build(args);
    for (const file of artifacts.filter((f) => f.endsWith(".dmg"))) addBackgroundBookmark(file);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}).help().strict().argv;
