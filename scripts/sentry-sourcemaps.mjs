import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const SENTRY_ORG = "masora";

export function sentryBundles(root) {
  const bundles = [];
  for (const [dir, project] of [["hub/public", "electron"], ["desktop", "electron"], ["hub", "zevet-hub"]]) {
    const absolute = path.join(root, dir);
    if (!existsSync(absolute)) continue;
    const maps = readdirSync(absolute).filter((name) => name.endsWith(".map"));
    if (maps.length) bundles.push({ path: absolute, project });
  }
  return bundles;
}

export function sentryCommands(root, release) {
  return sentryBundles(root).flatMap(({ path: bundlePath, project }) => [
    ["sentry", ["sourcemap", "inject", bundlePath]],
    ["sentry", ["sourcemap", "upload", "--org", SENTRY_ORG, "--project", project, "--release", release, bundlePath]],
  ]);
}

export function injectSentryDebugIds(root, run) {
  for (const [command, args] of sentryCommands(root, "build-only")) {
    if (args[1] === "upload") continue;
    run(command, args, { cwd: root });
  }
}
