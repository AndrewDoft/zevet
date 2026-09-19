// Preserve electron-builder's CLI options while fixing Finder's background
// bookmark before the DMG is compressed, signed, or given an update checksum.
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { build } = require("electron-builder");
const { createYargs, configureBuildCommand } = require("electron-builder/out/builder");
const { loadEnv } = require("app-builder-lib/out/util/config/load");

createYargs().command(["build", "*"], "Build", configureBuildCommand, async (args) => {
  try {
    await loadEnv(path.join(process.cwd(), "electron-builder.env"));
    await build({
      ...args,
      effectiveOptionComputed: async ({ volumePath }) => {
        if (volumePath) {
          execFileSync(process.env.PYTHON_PATH || "python3", [
            path.join(__dirname, "../scripts/prepare-dmg-background.py"), volumePath,
          ], { stdio: "inherit", timeout: 60_000 });
        }
        return false;
      },
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}).help().strict().argv;
