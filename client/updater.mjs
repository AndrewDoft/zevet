// Keeps this machine's zevet client in step with the hub, quietly.
//
// WHY THE HUB IS THE UPDATE SERVER: everyone who can use zevet at all can
// already reach the hub and already holds the shared token. Publishing builds
// somewhere else would mean a second place to authenticate, a second thing to
// keep online, and a public artifact of a private product. The update channel
// is exactly as available as the product.
//
// WHAT THIS DELIBERATELY DOES NOT DO, having watched Amoeba get it wrong:
//
//   - It never decides "newer" from an HTTP status code. Amoeba's updater
//     asked its feed for 204-means-current; its feed is a static file that
//     answers 200 forever, so it re-downloaded the same build every five
//     minutes for as long as the app was open. Here the manifest states a
//     version and a sha256 per file, and "different sha256" is the whole test.
//   - It never runs in the path of anybody's turn. The hook spawns this
//     detached and forgets it; nothing waits on the result.
//   - It never replaces a file it has not verified.
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const CLIENT_DIR = path.join(HOME, "client");
const MANIFEST = path.join(HOME, "manifest.json");
const STAMP = path.join(HOME, "last-check");
const LOCK = path.join(HOME, "update.lock");
const LOCK_STALE_MS = 5 * 60 * 1000;

function log(msg) {
  try {
    process.stderr.write(`[zevet-update] ${msg}\n`);
  } catch {
    // A logger that throws would be the only thing here able to fail loudly.
  }
}

function readConfig() {
  try {
    // See hook.mjs: a BOM here meant updates silently never installed.
    return JSON.parse(readFileSync(path.join(HOME, "config.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * A build-file name this updater is willing to write.
 *
 * The hub is trusted to ship new client code — that is the whole feature. It
 * is NOT trusted to choose where on the machine that code lands, and over
 * plain HTTP "the hub" may be whoever is on the network. `path.join` treats
 * `../evil.mjs` as an instruction, not as a filename.
 *
 * This was already "safe" by accident: the staging file was named
 * `.${name}.incoming`, so `../evil.mjs` became the literal directory `.../`,
 * which does not exist, and the write failed with ENOENT before the rename
 * could escape. MEASURED, by changing that one template to `${name}.incoming`
 * and re-running: two of the five traversal cases immediately wrote outside
 * the client directory. A protection that depends on the spelling of a temp
 * file is not a protection; it is a coincidence with a short life expectancy.
 *
 * So: an allowlist, checked before anything is fetched. A build file is a
 * plain name with no separator in it, and nothing else.
 */
function safeName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    !name.includes("..")
  );
}

/**
 * Is this JSON actually a manifest? A hostile or broken hub can answer with
 * anything at all, and every field below is used to drive a filesystem write.
 */
function validManifest(m) {
  if (!m || typeof m !== "object" || !Array.isArray(m.files)) return "not shaped like a manifest";
  for (const f of m.files) {
    if (!f || typeof f !== "object") return "a file entry is not an object";
    if (!safeName(f.name)) return `refusing the file name ${JSON.stringify(f && f.name)}`;
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      return `${f.name} has no usable sha256`;
    }
  }
  return null;
}

function localManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { version: "0.0.0", files: [] };
  }
}

/** One updater at a time, and never wedged by a crashed one. */
function takeLock() {
  try {
    if (existsSync(LOCK)) {
      const age = Date.now() - Number(readFileSync(LOCK, "utf8").trim() || 0);
      if (age < LOCK_STALE_MS) return false;
      log(`clearing a stale lock (${Math.round(age / 1000)}s old)`);
    }
    mkdirSync(HOME, { recursive: true });
    writeFileSync(LOCK, String(Date.now()), "utf8");
    return true;
  } catch (err) {
    log(`could not take the lock: ${err.message}`);
    return false;
  }
}

function releaseLock() {
  try {
    rmSync(LOCK, { force: true });
  } catch {
    // Next run clears it as stale.
  }
}

async function main() {
  const cfg = readConfig();
  const hub = (process.env.ZEVET_HUB || cfg.hub || "").replace(/\/+$/, "");
  const token = process.env.ZEVET_TOKEN || cfg.token || "";
  if (!hub || !token) {
    log("no hub or token configured — nothing to check against");
    return;
  }
  if (!takeLock()) return;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    let remote;
    try {
      const res = await fetch(`${hub}/dist/manifest.json`, {
        headers: { "x-zevet-token": token },
        signal: ac.signal,
        // A custom header survives a cross-origin redirect (only Authorization
        // and Cookie are stripped), so following one hands the team's shared
        // secret to wherever the hub points. It never legitimately redirects.
        redirect: "error",
      });
      if (!res.ok) {
        log(`hub answered ${res.status} for the manifest — staying on the current build`);
        return;
      }
      remote = await res.json();
    } finally {
      clearTimeout(timer);
    }

    // Validate the WHOLE manifest before acting on any of it. One hostile
    // entry means the manifest is not one we trust, not one we partly obey.
    const complaint = validManifest(remote);
    if (complaint) {
      log(`rejecting the hub's manifest: ${complaint} — current build kept`);
      return;
    }

    const local = localManifest();
    const localByName = new Map((local.files || []).map((f) => [f.name, f.sha256]));
    const stale = remote.files.filter((f) => localByName.get(f.name) !== f.sha256);

    if (stale.length === 0) {
      writeFileSync(STAMP, String(Date.now()), "utf8");
      return; // current. say nothing; this runs constantly.
    }

    log(`updating ${local.version} -> ${remote.version} (${stale.length} file(s))`);
    mkdirSync(CLIENT_DIR, { recursive: true });

    // Download and VERIFY everything before moving anything into place, so a
    // half-finished update cannot leave a mixed set of files behind.
    const staged = [];
    for (const f of stale) {
      // A deadline of its own: only the manifest fetch had one, so a hub that
      // accepted the connection and then trickled bytes stalled here until the
      // 60s watchdog fired.
      const res = await fetch(`${hub}/dist/${encodeURIComponent(f.name)}`, {
        headers: { "x-zevet-token": token },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        log(`could not fetch ${f.name} (${res.status}) — update abandoned, current build kept`);
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha256(buf);
      if (got !== f.sha256) {
        log(`${f.name} failed its checksum (wanted ${f.sha256.slice(0, 12)}, got ${got.slice(0, 12)}) — update abandoned`);
        return;
      }
      const tmp = path.join(CLIENT_DIR, `.${f.name}.incoming`);
      writeFileSync(tmp, buf);
      staged.push({ tmp, dest: path.join(CLIENT_DIR, f.name), name: f.name });
    }

    for (const s of staged) {
      try {
        renameSync(s.tmp, s.dest);
      } catch (err) {
        // Windows can refuse a rename over a file another process has open.
        // Leave the staged copy; the next run retries rather than pretending.
        log(`could not replace ${s.name} (${err.code}) — will retry next time`);
        return;
      }
    }

    writeFileSync(MANIFEST, JSON.stringify(remote, null, 2), "utf8");
    writeFileSync(STAMP, String(Date.now()), "utf8");
    log(`now on ${remote.version}`);
  } catch (err) {
    log(`check failed (${err.name === "AbortError" ? "hub did not answer in 10s" : err.message}) — current build kept`);
  } finally {
    // STAMP THE CLOCK WHATEVER HAPPENED.
    //
    // It used to be written on exactly two paths — "already current" and
    // "update installed" — so an unreachable hub, a 401, a failed checksum or
    // a blocked rename all left the stamp stale. The hook reads that stamp to
    // decide whether to check again, so the moment updating started failing it
    // spawned a fresh detached node process on EVERY tool call, forever. A
    // busy turn is 20-60 tool calls a minute, and a 401 is the steady state
    // for anyone whose config is wrong. The failure mode scaled with the
    // failure, which is the wrong way round.
    //
    // Backing off for the normal interval after a failed check is the point:
    // the next attempt still happens, just not 60 times a minute.
    try {
      writeFileSync(STAMP, String(Date.now()), "utf8");
    } catch {
      // If we cannot even write the stamp, the next run re-checks. Acceptable.
    }
    releaseLock();
  }
}

// A safety net, not the normal exit. `process.exit(0)` in a finally() here
// raced undici's socket teardown and tripped a libuv assertion on Windows
// ("!(handle->flags & UV_HANDLE_CLOSING)") AFTER the update had been written —
// so the work was done and the process still died loudly. Letting the event
// loop drain is the correct exit; this unref'd timer only fires if something
// is genuinely stuck, and cannot hold the process open by itself.
setTimeout(() => {
  // Release the lock FIRST. process.exit() skips the finally above, so a
  // watchdog firing used to leave update.lock on disk, which then blocked
  // every update for the next five minutes — a stall turning into a longer
  // stall.
  log("still running after 60s — giving up");
  releaseLock();
  process.exit(0);
}, 60000).unref();

main().catch((err) => {
  log(`updater bug, ignored: ${err && err.message}`);
  process.exitCode = 0;
});
