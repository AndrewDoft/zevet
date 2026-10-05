"use strict";

/** What the bootstrap and the release scripts must agree on. No Electron in here. */
const os = require("node:os");
const path = require("node:path");

/** Bumped only when bootstrap.js, Electron or a native module changes in a way a
 *  payload may depend on; a pulse's shell_min above this waits for the installer. */
const SHELL_VERSION = 1;

/** A monotonic integer from a dotted version: 0.2.89 -> 2089, 0.3.0 -> 3000, 1.0.0 -> 1000000.
 *  Minor and patch each get three digits. */
function seqOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!m) throw new Error(`not a plain x.y.z version: ${version}`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (min > 999 || pat > 999) throw new Error(`minor and patch must be below 1000: ${version}`);
  return maj * 1e6 + min * 1e3 + pat;
}

/** The pulse's <platform> path segment, or null where no payload is published. */
function platformKey(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "darwin" && arch === "arm64") return "mac-arm64";
  return null;
}

/** LOCALAPPDATA, never Roaming: a payload is a cache of downloads, not roaming state. */
function payloadRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.ZEVET_PAYLOAD_ROOT) return env.ZEVET_PAYLOAD_ROOT;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Zevet", "payload");
  return path.join(home, "Library", "Application Support", "Zevet", "payload");
}

const PULSE_BASE = "https://usemasora.com/download/p/zevet";
function pulseUrl(channel, platform, env = process.env) {
  return env.ZEVET_PAYLOAD_PULSE || `${PULSE_BASE}/${channel}/${platform}/pulse.json`;
}

module.exports = { SHELL_VERSION, seqOf, platformKey, payloadRoot, pulseUrl, PULSE_BASE };
