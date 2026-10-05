// Signs the manifest the hub serves at /dist/manifest.json.
//
//   ZEVET_UPDATE_SIGNING_KEY=<PEM> node scripts/sign-client-manifest.mjs
//   locally: $env:ZEVET_UPDATE_SIGNING_KEY = (pwsh -NoProfile -File C:/Users/andre/.claude/bin/update-signing-key.ps1 zevet | Out-String)
//
// Writes hub/client-manifest.signed.json (commit it): the payload
// {schema, type, version, files:[{name,bytes,sha256}]} exactly as hub/server.mjs
// builds it, signed with domain "zevet-client-v1". Run after ANY change under
// client/ or a version bump; scripts/release-check.mjs fails while it is stale.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { signDocument } = createRequire(import.meta.url)("../desktop/update-signing.js");
const { CLIENT_DOMAIN, PINNED_KEYS, verifyClientManifest } = await import("../client/signing.mjs");
export const SIGNED_FILE = path.join(ROOT, "hub", "client-manifest.signed.json");

/** CLIENT_FILES, parsed out of hub/server.mjs the way release-check and the closure tests do. */
export function clientFiles(root = ROOT) {
  const text = readFileSync(path.join(root, "hub", "server.mjs"), "utf8");
  const at = text.indexOf("const CLIENT_FILES");
  return [...text.slice(at, text.indexOf("];", at)).matchAll(/"([a-z0-9-]+\.mjs)"/g)].map((m) => m[1]);
}

export function clientPayload(root = ROOT) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const files = clientFiles(root).map((name) => {
    const buf = readFileSync(path.join(root, "client", name));
    return { name, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  });
  return { schema: 1, type: "zevet-client", version, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pem = (process.env.ZEVET_UPDATE_SIGNING_KEY || "").replaceAll("|", "\n").trim();
  if (!pem) {
    console.error("ZEVET_UPDATE_SIGNING_KEY is not set (see the header)");
    process.exit(1);
  }
  const payload = clientPayload();
  const keyId = Object.keys(PINNED_KEYS)[0];
  // CLIENT_DOMAIN carries its trailing newline; signDocument takes it verbatim.
  const signature = signDocument(CLIENT_DOMAIN, payload, pem, keyId);
  verifyClientManifest(payload, signature); // fail here if the key is not the pinned one
  writeFileSync(SIGNED_FILE, JSON.stringify({ payload, signature }, null, 2) + "\n", "utf8");
  console.log(`signed ${payload.files.length} client files, zevet ${payload.version}, as ${keyId}`);
}
