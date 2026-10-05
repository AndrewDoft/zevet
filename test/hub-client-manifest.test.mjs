// The hub serves the client manifest with the release-time signature attached
// only when that signature covers exactly what is on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startHub, tempDir, TOKEN, ROOT } from "./helpers.mjs";
import { CLIENT_DOMAIN, verifyClientManifest, PINNED_KEYS } from "../client/signing.mjs";
import { clientPayload } from "../scripts/sign-client-manifest.mjs";

const { signDocument } = createRequire(import.meta.url)("../desktop/update-signing.js");
const PAIR = generateKeyPairSync("ed25519");
const PEM = PAIR.privateKey.export({ format: "pem", type: "pkcs8" });
const KEYS = { "zevet-test": PAIR.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") };

async function manifestFrom(t, signedFile) {
  const hub = await startHub(signedFile ? { ZEVET_SIGNED_CLIENT_MANIFEST: signedFile } : {});
  t.after(() => hub.stop());
  return (await fetch(`${hub.base}/dist/manifest.json`, { headers: { "x-zevet-token": TOKEN } })).json();
}

function signedFile(t, mutate = (p) => p) {
  const dir = tempDir("zevet-signed-manifest-");
  t.after(dir.cleanup);
  const payload = mutate(clientPayload(ROOT));
  const file = path.join(dir.dir, "m.json");
  writeFileSync(file, JSON.stringify({ payload, signature: signDocument(CLIENT_DOMAIN, payload, PEM, "zevet-test") }));
  return file;
}

test("a signature covering exactly the files on disk is attached; legacy fields stay", async (t) => {
  const m = await manifestFrom(t, signedFile(t));
  assert.equal(verifyClientManifest(m.payload, m.signature, KEYS), "zevet-test");
  assert.deepEqual(m.files, m.payload.files);
  assert.equal(m.version, m.payload.version);
  assert.ok(m.files.some((f) => f.name === "signing.mjs"), "signing.mjs must ship: updater.mjs imports it");
});

test("a stale signature (a client file changed since signing) is withheld, not served", async (t) => {
  const stale = signedFile(t, (p) => ({ ...p, files: p.files.map((f, i) => (i ? f : { ...f, sha256: "0".repeat(64) })) }));
  const m = await manifestFrom(t, stale);
  assert.equal(m.payload, undefined);
  assert.equal(m.signature, undefined);
  assert.ok(m.files.length > 0);
});

test("no signed manifest on disk serves the unsigned live one", async (t) => {
  const m = await manifestFrom(t, path.join(tempDir("zevet-nosig-").dir, "absent.json"));
  assert.equal(m.payload, undefined);
});

test("the committed signed manifest, if present, is signed by the pinned key", { skip: !existsSync(path.join(ROOT, "hub", "client-manifest.signed.json")) && "not committed" }, () => {
  const { payload, signature } = JSON.parse(readFileSync(path.join(ROOT, "hub", "client-manifest.signed.json"), "utf8"));
  assert.equal(verifyClientManifest(payload, signature, PINNED_KEYS), "zevet-2026-09");
});
