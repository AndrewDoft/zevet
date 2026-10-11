"use strict";

/**
 * The payload client, built one way for both callers: bootstrap.js (the running app) and background-entry.js
 * (the closed-app update job). The job MUST verify with the same pinned keys, seed and shell version, or it would
 * be a second, weaker path into the payload store.
 */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const cfg = require("./payload-config.js");

function readTrim(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
}

/** Stable per install, for rollout bucketing. */
function installId(root) {
  const file = path.join(root, "install-id");
  let id = readTrim(file);
  if (!id) {
    id = crypto.randomUUID();
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, id);
  }
  return id;
}

function createClient({ app, platform, log, env = process.env }) {
  const root = cfg.payloadRoot(env);
  const channel = env.ZEVET_PAYLOAD_CHANNEL || readTrim(path.join(root, "channel")) || "stable";
  const pulse = cfg.pulseUrl(channel, platform, env);
  const { PINNED_KEYS } = require("./update-signing.js");
  const { loopbackProofKeys } = require("./app-update.js");
  const { createPayloadClient } = require("@masora/desktop-kit/lib/payload");
  const client = createPayloadClient({
    app: "zevet", channel, platform, root,
    // An unpackaged proof run has no resources/app-core; only the test hooks may point the seed elsewhere.
    seedDir: env.ZEVET_TEST_HOOKS === "1" && env.ZEVET_SEED_DIR ? env.ZEVET_SEED_DIR : path.join(process.resourcesPath, "app-core"),
    seedBuild: app.getVersion(), seedSeq: cfg.seqOf(app.getVersion()),
    pulseUrl: pulse,
    keys: loopbackProofKeys(pulse, env) || PINNED_KEYS,
    shellVersion: cfg.SHELL_VERSION,
    schemaHead: async () => null,
    installId: installId(root),
    log,
  });
  return { client, root, channel };
}

module.exports = { createClient, readTrim, installId };
