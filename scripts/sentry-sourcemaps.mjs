// Debug-ID injection + source-map upload for the bundles the hub serves, done on a STAGED COPY only.
// `sentry sourcemap inject` rewrites the .js and .map it is given. Run on the tracked hub/public files it would
// dirty the tree, and CI (`git diff --exit-code hub/public`) rejects a bundle that differs from a clean build.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

export const SENTRY_ORG = "masora";
/** bundle in hub/public -> Sentry project its errors arrive in (board.js runs in the Electron renderer). */
export const SENTRY_BUNDLES = [
  { bundle: "board.js", project: "electron" },
  { bundle: "editor.js", project: "zevet-hub" },
];

/** `stage` is an extracted copy of the release tree (never a git checkout); `maps` is scratch space beside it.
 *  Injects debug IDs into stage/hub/public, then uploads each project's pairs as release `version`. */
export function stageSourcemaps({ stage, maps, version, run }) {
  if (existsSync(path.join(stage, ".git"))) throw new Error(`${stage} is a git checkout; sourcemaps are injected into extracted copies only`);
  const pub = path.join(stage, "hub", "public");
  run("sentry", ["sourcemap", "inject", "--ext", ".js", pub], { cwd: stage, stream: true });
  rmSync(maps, { recursive: true, force: true });
  for (const { bundle, project } of SENTRY_BUNDLES) {
    const dir = path.join(maps, project);
    mkdirSync(dir, { recursive: true });
    for (const f of [bundle, `${bundle}.map`]) copyFileSync(path.join(pub, f), path.join(dir, f));
    run("sentry", ["sourcemap", "upload", "--release", version, dir], { cwd: stage, env: { SENTRY_ORG, SENTRY_PROJECT: project }, stream: true });
  }
}
