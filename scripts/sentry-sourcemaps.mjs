import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const projectFor = (bundle) => bundle === "hub/public/editor.js" ? "zevet-hub" : "electron";

/** Return only generated JavaScript/source-map pairs that are safe to process.
 * Source maps are deliberately not discovered outside the generated artifact
 * list: private source trees must never be handed to the Sentry CLI. */
export function sentryArtifacts(files) {
  const names = new Set(files);
  return [...names]
    .filter((file) => file.endsWith(".js") && names.has(`${file}.map`))
    .sort()
    .map((bundle) => ({ project: projectFor(bundle), bundle, map: `${bundle}.map` }));
}

export function sentryCommands(version, artifacts) {
  if (!artifacts.length) return [];
  const bundles = artifacts.flatMap(({ bundle, map }) => [bundle, map]);
  const commands = [["sourcemap", "inject", ...bundles]];
  for (const project of [...new Set(artifacts.map((a) => a.project))].sort()) {
    commands.push([
      "sourcemap", "upload", "--org", "masora", "--project", project,
      "--release", version,
      ...artifacts.filter((a) => a.project === project).map((a) => a.map),
    ]);
  }
  return commands;
}

function generatedFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".js.map")) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  for (const dir of ["hub/public", "desktop/dist"]) {
    const full = path.join(root, dir);
    if (existsSync(full) && statSync(full).isDirectory()) walk(full);
  }
  return out;
}

export function uploadSentrySourcemaps({ root, version, run }) {
  const artifacts = sentryArtifacts(generatedFiles(root));
  for (const args of sentryCommands(version, artifacts)) run("sentry", args, { cwd: root, stream: true });
  return artifacts;
}
