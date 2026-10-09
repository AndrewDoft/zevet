#!/usr/bin/env node
// `npm run ship` — one command that does a whole zevet release from origin/main. It is
// docs/RELEASING.md as code, and every trap that document records is a check here.
//
//   node scripts/ship.mjs [--dry-run] [--notes "one short sentence"]
//
// One channel: a release goes straight to the feed every install reads. There is no soak and no
// promote step; the gate in the release step is the only check before everyone gets it.
//
// It decides everything itself: shell vs payload from the diff since the last release tag (ship-lib
// classify), the next version, whether the hub needs a deploy. Then, each step skipping what is already
// done — so a crash mid-ship is repaired by running it again:
//
//   release     gate, version bump, client manifest re-sign, (board bundle), release commit, tag, push
//   build.yml   wait for the tag's run (foreground)
//   installers  signature check, upload the installers                 (every release: new downloads)
//   installer feed  signed zevet-latest.json, uploaded LAST            (shell release only)
//   stable links    Caddy: Zevet-Setup.exe / Zevet-Setup-arm64.exe / Zevet.dmg / Zevet.AppImage -> this version, in place
//   payload     the payload to the stable channel, then read back over HTTPS
//   hub         tarball over /srv/zevet, restart, /healthz + /version  (board/hub/client changed)
//   verify      the served installers hash to the built ones; Authenticode; the feed
//   D-record    the release record in DECISIONS.md, pushed to main
//
// The signing key comes from the DPAPI file through update-signing-key.ps1, lives only in this process's
// memory and in the environment of the children that sign, and is never printed or written.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { brotliDecompressSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stageSourcemaps } from "./sentry-sourcemaps.mjs";
import { acquireLock, decide, nextDNumber, notesFrom, recordHeader, renderRecord, runSteps } from "./ship-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);

export const REPO = "AndrewDoft/zevet";
export const BASE = "https://usemasora.com/download";
export const HUB = "https://hub.usemasora.com";
export const PLATFORMS = ["win-x64", "mac-arm64"];
const BOX = ["compute", "ssh", "masora-app", "--project", "masora-production", "--tunnel-through-iap", "--zone", "us-east1-b"];
const DL = "/srv/masora/downloads";
export const LOCK = path.join(tmpdir(), "zevet-ship.lock");
export const workDir = (version) => path.join(tmpdir(), "zevet-ship", version);
export const exeName = (v) => `zevet-${v}-windows-x64-setup.exe`;
export const dmgName = (v) => `zevet-${v}-macos-arm64.dmg`;
export const arm64ExeName = (v) => `zevet-${v}-windows-arm64-setup.exe`;
export const appImageName = (v) => `zevet-${v}-linux-x64.AppImage`;
/** Every installer a release publishes: [stable link, versioned file, fact key, build.yml artifact]. */
export const INSTALLERS = [
  ["Zevet-Setup.exe", exeName, "exe"],
  ["Zevet.dmg", dmgName, "dmg"],
  ["Zevet-Setup-arm64.exe", arm64ExeName, "arm64"],
  ["Zevet.AppImage", appImageName, "appimage"],
];
const installerFiles = (v) => INSTALLERS.map(([, name]) => name(v));

/** The Caddyfile edit, as the python the stable-links step runs on the box. In place (never sed -i, RELEASING.md §4a).
 *  A stable link that has no handle block yet gets one cloned from Zevet-Setup.exe's, so the first ship that
 *  carries a new platform creates its link; every versioned name is then rewritten to `v`. */
export function caddyPython(v, file = "/srv/masora/Caddyfile") {
  return `import re
p = "${file}"
with open(p, "r+") as f:
    text = f.read()
    # The block ends at the brace on the handle's OWN indentation: the live block nests a header { }
    # whose closing brace the first "}" line would otherwise match (a truncated clone in prod's Caddyfile).
    src = re.search(r"^([ \\t]*)handle /download/Zevet-Setup\\.exe \\{\\n.*?\\n\\1\\}\\n", text, re.S | re.M)
    if not src:
        raise SystemExit("no handle block for Zevet-Setup.exe")
    for link, old in (("Zevet-Setup-arm64.exe", "windows-arm64-setup.exe"), ("Zevet.AppImage", "linux-x64.AppImage")):
        if "/download/" + link not in text:
            block = src.group(0).replace("Zevet-Setup.exe", link).replace("windows-x64-setup.exe", old)
            text = text.replace(src.group(0), src.group(0) + block, 1)
    text = re.sub(r"zevet-[0-9.]+-macos-arm64\\.dmg", "zevet-${v}-macos-arm64.dmg", text)
    text = re.sub(r"zevet-[0-9.]+-windows-x64-setup\\.exe", "zevet-${v}-windows-x64-setup.exe", text)
    text = re.sub(r"zevet-[0-9.]+-windows-arm64-setup\\.exe", "zevet-${v}-windows-arm64-setup.exe", text)
    text = re.sub(r"zevet-[0-9.]+-linux-x64\\.AppImage", "zevet-${v}-linux-x64.AppImage", text)
    f.seek(0)
    f.write(text)
    f.truncate()
`;
}

// ── the real io ─────────────────────────────────────────────────────────────────────────────────────
// Everything that leaves the process goes through one of these, so test/ship.test.mjs can fake all of it.
const WIN_SHELL = new Set(["npm", "gcloud"]); // .cmd shims: Windows will not spawn them directly
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a);

export function realIo({ log = console.log } = {}) {
  let pem = null;
  const run = (cmd, args, { cwd = ROOT, env, input, stream = false, allow = [0] } = {}) => {
    const shell = process.platform === "win32" && WIN_SHELL.has(cmd);
    const r = spawnSync(shell ? `${cmd}.cmd` : cmd, shell ? args.map(quote) : args, {
      cwd, env: { ...process.env, ...env }, input, shell, encoding: "utf8", windowsHide: true,
      stdio: stream ? ["ignore", "inherit", "inherit"] : ["pipe", "pipe", "pipe"], maxBuffer: 1 << 28,
    });
    if (r.error) throw r.error;
    if (!allow.includes(r.status)) throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} exited ${r.status}\n${(r.stderr || "").trim().slice(-600)}`);
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  };
  const io = {
    log,
    run,
    git: (args, o = {}) => run("git", args, o).stdout.trim(),
    gh: (args) => run("gh", ["-R", REPO, ...args]).stdout,
    buildRun(tag) {
      const out = io.gh(["run", "list", "--workflow", "build", "--branch", tag, "-L", "1", "--json", "databaseId,status,conclusion"]);
      return JSON.parse(out)[0] || null;
    },
    async https(url, { method = "GET" } = {}) {
      const res = await fetch(url, { method, redirect: "follow", headers: { "cache-control": "no-cache" } });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await res.arrayBuffer()) };
    },
    async download(url, file) {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      await pipeline(res.body, createWriteStream(file));
      return { status: res.status, ...(await fileDigest(file)) };
    },
    /* NOT `sudo bash -s` with the script on stdin: on Windows gcloud hands the
       session to PuTTY, which reads stdin itself (observed: "bash: line 1: y:
       command not found", the answer to its own host-key prompt). The script
       goes up by scp and runs by path, as deploy/gce.md in masora2 says. */
    ssh(script) {
      const name = `zevet-ship-${process.pid}-${Date.now()}.sh`;
      const local = path.join(tmpdir(), name);
      writeFileSync(local, script.replace(/\r\n/g, "\n"));
      try {
        io.scp([local], "/tmp/");
        return run("gcloud", [...BOX, "--command", `sudo bash /tmp/${name}; rc=$?; rm -f /tmp/${name}; exit $rc`]).stdout;
      } finally {
        rmSync(local, { force: true });
      }
    },
    scp: (files, to = "/tmp/") => run("gcloud", ["compute", "scp", "--project", "masora-production", "--tunnel-through-iap", "--zone", "us-east1-b", ...files, `masora-app:${to}`]),
    key() {
      if (!pem) {
        const r = run("pwsh", ["-NoProfile", "-File", "C:/Users/andre/.claude/bin/update-signing-key.ps1", "zevet"]);
        pem = r.stdout.replaceAll("\r", "").trim();
        if (!pem.includes("PRIVATE KEY")) throw new Error("update-signing-key.ps1 did not return a key");
      }
      return pem;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return io;
}

export async function fileDigest(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return { sha256: h.digest("hex"), bytes: statSync(file).size };
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const keyEnv = (io) => {
  const k = io.key().replaceAll("\n", "|");
  return { ZEVET_UPDATE_SIGNING_KEY: k, ZEVET_PAYLOAD_SIGNING_KEY: k };
};

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── read-backs over HTTPS (what a machine in the field would see) ───────────────────────────────────
/** The signed pulse per platform for one channel, signature checked; null where a pulse is absent. */
export async function pulseState(io, channel, verify) {
  const out = {};
  for (const plat of PLATFORMS) {
    const r = await io.https(`${BASE}/p/zevet/${channel}/${plat}/pulse.json`);
    if (r.status !== 200) { out[plat] = null; continue; }
    const env = JSON.parse(r.body.toString("utf8"));
    verify(env.signed, env.signature);
    out[plat] = { ...env.signed, raw: r.body.toString("utf8"), cache: r.headers["cache-control"] || "" };
  }
  return out;
}

/** D-033/D-036's check: the pulse verifies under the pinned key and is no-store, its manifest hashes to the
 *  name it is served under, and every blob brotli-decodes to the hash the manifest lists (blobs immutable). */
export async function verifyPayload(io, channel, { expectBuild, verify }) {
  const state = await pulseState(io, channel, verify);
  const facts = {};
  for (const plat of PLATFORMS) {
    const p = state[plat];
    if (!p) throw new Error(`${channel}/${plat}: no pulse on the host`);
    if (p.channel !== channel || p.platform !== plat) throw new Error(`${channel}/${plat}: the pulse names ${p.channel}/${p.platform}`);
    if (expectBuild && p.build !== expectBuild) throw new Error(`${channel}/${plat}: pulse carries ${p.build}, want ${expectBuild}`);
    if (!/no-store/.test(p.cache)) throw new Error(`${channel}/${plat}: pulse is not Cache-Control no-store (${p.cache || "none"})`);
    const m = await io.https(`${BASE}/p/m/${p.manifest}.json`);
    if (m.status !== 200 || sha256(m.body) !== p.manifest) throw new Error(`${channel}/${plat}: manifest ${p.manifest.slice(0, 8)} is missing or its bytes do not hash to its name`);
    const hashes = [...new Set(JSON.parse(m.body.toString("utf8")).files.map((f) => f.h))];
    await pool(hashes, 8, async (h) => {
      const b = await io.https(`${BASE}/p/b/${h.slice(0, 2)}/${h}`);
      if (b.status !== 200) throw new Error(`${channel}/${plat}: blob ${h.slice(0, 8)} answered ${b.status}`);
      if (!/immutable/.test(b.headers["cache-control"] || "")) throw new Error(`${channel}/${plat}: blob ${h.slice(0, 8)} is not immutable`);
      let plain;
      try { plain = brotliDecompressSync(b.body); } catch { throw new Error(`${channel}/${plat}: blob ${h.slice(0, 8)} does not brotli-decode`); }
      if (sha256(plain) !== h) throw new Error(`${channel}/${plat}: blob ${h.slice(0, 8)} does not decode to its hash`);
    });
    facts[plat] = { seq: p.seq, build: p.build, manifest: p.manifest, blobs: hashes.length };
  }
  return facts;
}

// ── the git worktree ship works in ──────────────────────────────────────────────────────────────────
/** A worktree of THIS repo, owned by ship: reset to `ref` on every use. Refuses anything that is not one of
 *  this repo's registered worktrees, because it will `reset --hard` and `clean` it. */
/** Windows paths are case-insensitive, and git spells a worktree the way it was
 *  first reached (C:/dev/Github vs C:/dev/GitHub) — compared raw, ship refused
 *  the worktree it had made itself on the run before. */
export function samePath(a, b, platform = process.platform) {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

export function ensureWorktree(ctx, ref) {
  const { io, wt } = ctx;
  if (samePath(wt, ROOT)) throw new Error(`ZEVET_SHIP_DIR ${wt} is the checkout ship runs from — give it its own directory`);
  if (!existsSync(wt)) io.git(["worktree", "add", "--detach", wt, ref]);
  else {
    const listed = io.git(["worktree", "list", "--porcelain"]).split(/\r?\n/).some((l) => l.startsWith("worktree ") && samePath(l.slice(9), wt));
    if (!listed) throw new Error(`${wt} exists but is not a worktree of this repo; not touching it`);
    io.git(["reset", "--hard", "-q"], { cwd: wt });
    io.git(["clean", "-fdq"], { cwd: wt });
    io.git(["checkout", "--detach", "-q", ref], { cwd: wt });
  }
  for (const dir of [".", "desktop"]) {
    if (!existsSync(path.join(wt, dir, "node_modules"))) io.run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: path.join(wt, dir), stream: true });
  }
  return wt;
}

/** package.json / desktop/package.json first "version" and the lockfiles' leading ones. */
export function bumpVersion(wt, from, to) {
  const swap = (file, maxLines) => {
    const p = path.join(wt, file);
    const lines = readFileSync(p, "utf8").split("\n");
    let n = 0;
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      if (lines[i].includes(`"version": "${from}"`)) { lines[i] = lines[i].replace(`"version": "${from}"`, `"version": "${to}"`); n++; }
    }
    if (!n) throw new Error(`${file}: no "version": "${from}" in its first ${maxLines} lines`);
    writeFileSync(p, lines.join("\n"));
  };
  swap("package.json", 12);
  swap("desktop/package.json", 12);
  for (const f of ["package-lock.json", "desktop/package-lock.json"]) {
    try { swap(f, 12); } catch { /* a lockfile that never carried this version has nothing to bump */ }
  }
}

/** The hub's BUILD_ID, computed the way hub/server.mjs does, from a tree. */
export function hubBuildId(tree) {
  const stamp = (n) => { try { return readFileSync(path.join(tree, "hub", "public", `${n}.js.srchash`), "utf8").trim(); } catch { return ""; } };
  return createHash("sha256").update(["board", "editor"].map(stamp).join("\n")).digest("hex").slice(0, 12);
}

// ── the steps ───────────────────────────────────────────────────────────────────────────────────────
const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")]));
const PERMS = `find ${DL}/p -type d -exec chmod 755 {} +; find ${DL}/p -type f -exec chmod 644 {} +`;

export function buildSteps(ctx) {
  const { io, d, version: v, tag } = ctx;
  const shell = d.kind === "shell";
  const installerUrls = installerFiles(v).map((f) => `${BASE}/${f}`);
  /* desktop/ modules are loaded from ship's own worktree, which has had `npm ci`:
     the watcher's runner checkout never installs desktop deps, and the first
     auto-ship died there on "Cannot find module '@masora/desktop-kit'". */
  const depsRoot = () => (ctx.wt && existsSync(path.join(ctx.wt, "desktop", "node_modules", "@masora", "desktop-kit")) ? ctx.wt : ctx.root);
  const signing = () => require(path.join(depsRoot(), "desktop", "update-signing.js"));
  const keyId = () => Object.keys(signing().PINNED_KEYS)[0];
  const verifyPulse = (signed, sig) => {
    const { PINNED_KEYS, verifySigned } = signing();
    const { PULSE_DOMAIN } = require(path.join(depsRoot(), "desktop", "node_modules", "@masora", "desktop-kit", "lib", "payload.js"));
    verifySigned(PULSE_DOMAIN, signed, sig, ctx.keys || PINNED_KEYS);
  };
  const remoteTag = () => io.git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() !== "";
  const at = (ref) => ensureWorktree(ctx, ref);
  const okHead = async (url) => (await io.https(url, { method: "HEAD" })).status === 200;
  const subjects = () => io.git(["log", "--format=%s", `v${d.base}..${tag}`, "--", ".", ":!DECISIONS.md"]).split(/\r?\n/).filter((s) => s && !s.startsWith("release:"));

  /** All four installers from the tag's build.yml run, in one empty directory (RELEASING.md §2). */
  const artifacts = () => {
    const dir = path.join(ctx.work, "release");
    if (installerFiles(v).every((f) => existsSync(path.join(dir, f)))) return dir;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const run = io.buildRun(tag);
    if (!run) throw new Error(`no build.yml run for ${tag}`);
    for (const name of ["zevet-windows", "zevet-macos", "zevet-linux"]) io.gh(["run", "download", String(run.databaseId), "-n", name, "-D", dir]);
    for (const f of readdirSync(dir)) if (!/\.(exe|dmg|AppImage)$/.test(f)) rmSync(path.join(dir, f), { force: true });
    for (const f of installerFiles(v)) if (!existsSync(path.join(dir, f))) throw new Error(`build artifacts lack ${f}: ${readdirSync(dir)}`);
    return dir;
  };
  const authenticode = (file) => {
    const r = io.run("pwsh", ["-NoProfile", "-Command", `$s = Get-AuthenticodeSignature -LiteralPath '${file}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`]);
    const line = r.stdout.trim();
    if (!line.startsWith("Valid|") || !line.includes("CN=Andrew Doft")) throw new Error(`Authenticode on ${path.basename(file)}: ${line}`);
    return "Valid CN=Andrew Doft";
  };
  const channelDone = async (channel) => {
    const s = await pulseState(io, channel, verifyPulse);
    return PLATFORMS.every((p) => s[p]?.build === v);
  };
  const stage = () => path.join(ctx.work, "payload");
  /** tar `files` (relative to `dir`) up, scp, extract under /srv/masora/downloads, fix modes. */
  const upload = (name, dir, files) => {
    io.run("tar", ["-czf", path.join("..", name), ...files], { cwd: dir });
    io.scp([path.join(path.dirname(dir), name)]);
    io.ssh(`set -e\ntar -xzf /tmp/${name} -C ${DL} --no-same-owner\nrm -f /tmp/${name}\n${PERMS}\n`);
  };

  const steps = [
    {
      name: `release ${tag}`,
      plan: () => `gate, bump ${v}, re-sign client manifest${d.hubFiles.some((f) => f.startsWith("board/")) ? ", rebuild board bundle" : ""}, commit, tag ${tag}, push main + tag`,
      done: () => remoteTag(),
      run() {
        const wt = at(d.tip);
        const env = keyEnv(io);
        const from = JSON.parse(readFileSync(path.join(wt, "package.json"), "utf8")).version;
        bumpVersion(wt, from, v);
        io.run("node", ["scripts/sign-client-manifest.mjs"], { cwd: wt, env, stream: true });
        if (d.hubFiles.some((f) => f.startsWith("board/"))) {
          if (!existsSync(path.join(wt, "board", "node_modules"))) io.run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: path.join(wt, "board"), stream: true });
          io.run("npm", ["run", "build"], { cwd: path.join(wt, "board"), stream: true });
        }
        io.run("node", ["scripts/run-tests.mjs"], { cwd: wt, stream: true });
        io.git(["add", "package.json", "package-lock.json", "desktop/package.json", "desktop/package-lock.json", "hub/client-manifest.signed.json", "hub/public/board.js", "hub/public/board.js.map", "hub/public/board.js.srchash", "hub/public/board.css"], { cwd: wt });
        io.git(["commit", "-q", "-m", `release: ${v}`], { cwd: wt });
        io.run("node", ["scripts/release-check.mjs"], { cwd: wt });
        io.git(["tag", "-d", tag], { cwd: wt, allow: [0, 1] });
        io.git(["tag", tag], { cwd: wt });
        try { io.git(["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`], { cwd: wt }); }
        catch (e) { io.git(["tag", "-d", tag], { cwd: wt }); throw new Error(`push refused (main moved since the plan?) — run ship again\n${e.message}`); }
      },
    },
    {
      name: "build.yml",
      plan: () => `wait for the ${tag} run (both legs) with gh run watch`,
      done: () => io.buildRun(tag)?.conclusion === "success",
      async run() {
        let run = io.buildRun(tag);
        for (let i = 0; !run && i < 24; i++) { await io.sleep(5000); run = io.buildRun(tag); }
        if (!run) throw new Error(`build.yml never started for ${tag}`);
        if (run.status !== "completed") io.run("gh", ["-R", REPO, "run", "watch", String(run.databaseId), "--exit-status"], { stream: true, allow: [0, 1] });
        const c = io.buildRun(tag)?.conclusion;
        if (c !== "success") throw new Error(`build.yml for ${tag} ended ${c}. The tag never reached anyone: run ship again and the next version supersedes it.`);
      },
    },
    {
      name: "installers",
      plan: () => `download artifacts, Authenticode-check both exes, upload ${installerFiles(v).join(", ")}`,
      done: async () => { for (const u of installerUrls) if (!(await okHead(u))) return false; return true; },
      run() {
        const dir = artifacts();
        ctx.facts.authenticode = authenticode(path.join(dir, exeName(v)));
        authenticode(path.join(dir, arm64ExeName(v)));
        io.scp(installerFiles(v).map((f) => path.join(dir, f)));
        // Installers first, feed last; in a root shell, so the glob is expanded by root (RELEASING.md §4).
        io.ssh(`set -e\nmv /tmp/zevet-${v}-* ${DL}/\nchmod 644 ${DL}/zevet-${v}-*\nls -la ${DL}/zevet-${v}-*\n`);
      },
    },
    ...(shell ? [{
      name: "installer feed",
      plan: () => `sign zevet-latest.json for ${v}, upload it last`,
      async done() {
        const r = await io.https(`${BASE}/zevet-latest.json`);
        return r.status === 200 && JSON.parse(r.body.toString("utf8")).version === v;
      },
      run() {
        const dir = artifacts();
        const wt = at(tag);
        io.run("node", [path.join(wt, "scripts", "make-feed.mjs"), dir, "--notes", ctx.notes || notesFrom(subjects(), v)], { cwd: wt, env: keyEnv(io), stream: true });
        io.scp([path.join(dir, "zevet-latest.json")]);
        io.ssh(`set -e\nmv /tmp/zevet-latest.json ${DL}/\nchmod 644 ${DL}/zevet-latest.json\n`);
      },
    }] : []),
    {
      name: "stable links",
      plan: () => `Caddy: Zevet-Setup.exe / Zevet-Setup-arm64.exe / Zevet.dmg / Zevet.AppImage -> ${v}, edited in place, container checked, reloaded`,
      // Done = the marker the run writes AFTER the reload. "The host file has the
      // new names" is not it: a run that died between the edit and the reload
      // would otherwise be skipped for ever.
      done: async () => io.ssh(`test -f /srv/masora/.zevet-links-${v} && echo yes || true`).trim() === "yes",
      run() {
        // In place, never sed -i: the container holds the old inode open (RELEASING.md §4a).
        const out = io.ssh(`set -e
cp /srv/masora/Caddyfile /srv/masora/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
python3 - <<'PYEOF'
${caddyPython(v)}PYEOF
C=$(docker ps -qf name=caddy)
# Inside the container the bind-mounted file is /etc/caddy/Caddyfile.
n=$(docker exec $C grep -c "zevet-${v}-" /etc/caddy/Caddyfile || true)
[ "$n" -ge 4 ] || { echo "the running container sees $n lines for ${v}, not 4"; exit 1; }
docker exec $C caddy reload --config /etc/caddy/Caddyfile
touch /srv/masora/.zevet-links-${v}
echo reloaded
`);
        if (!out.includes("reloaded")) throw new Error(`Caddy: ${out}`);
      },
    },
    // The hub before the payload: a client swaps to the new payload within minutes and reloads its board from the hub;
    // a hub still on the old board then shows the old UI under the new build until a manual reload (0.2.105).
    ...(d.hub ? [{
      name: "hub",
      plan: () => `git archive ${tag}, extract over /srv/zevet in place, restart, check /healthz and /version`,
      done: () => io.ssh("cat /srv/zevet/.shipped 2>/dev/null || true").trim() === v,
      async run() {
        const wt = at(tag);
        const want = hubBuildId(wt);
        ctx.facts.hubBefore = JSON.parse((await io.https(`${HUB}/version`)).body.toString("utf8")).build;
        // Debug IDs go into an extracted COPY of the tag: injecting into hub/public itself would dirty tracked files.
        const tgz = path.join(ctx.work, `zevet-${v}.tar.gz`), tree = path.join(ctx.work, "hub-tree");
        rmSync(tree, { recursive: true, force: true });
        mkdirSync(tree, { recursive: true });
        io.git(["archive", "--format=tar", "-o", `${tree}.tar`, tag], { cwd: wt });
        io.run("tar", ["-xf", "hub-tree.tar", "-C", "hub-tree"], { cwd: ctx.work }); // relative: GNU tar reads "C:" as a host
        stageSourcemaps({ stage: tree, maps: path.join(ctx.work, "hub-maps"), version: v, run: io.run });
        io.run("tar", ["-czf", path.basename(tgz), "-C", "hub-tree", "."], { cwd: ctx.work });
        io.scp([tgz]);
        // In place over the top: /srv/zevet is a bind mount, replacing the directory strands the container.
        io.ssh(`set -e
tar -czf /srv/masora/zevet-tree.bak-$(date +%Y%m%d-%H%M%S).tar.gz -C /srv zevet
tar -xzf /tmp/zevet-${v}.tar.gz -C /srv/zevet
echo ${v} > /srv/zevet/.shipped
rm -f /tmp/zevet-${v}.tar.gz
docker restart masora-zevet-hub-1
`);
        let health = null;
        for (let i = 0; i < 30 && !health; i++) {
          await io.sleep(2000);
          try { const r = await io.https(`${HUB}/healthz`); if (r.status === 200) health = JSON.parse(r.body.toString("utf8")); } catch { /* still restarting */ }
        }
        if (!health?.ok || !("rooms" in health) || !("wsListeners" in health)) throw new Error(`/healthz after the restart: ${JSON.stringify(health)}`);
        const got = JSON.parse((await io.https(`${HUB}/version`)).body.toString("utf8")).build;
        if (got !== want) throw new Error(`/version says ${got}, the tree computes ${want}: the restart did not pick up the new tree`);
        ctx.facts.hubAfter = got;
      },
    }] : []),
    {
      name: "payload",
      plan: () => "stage the payload tree, upload new blobs, manifests, then the stable pulses and the canary pulses; read back over HTTPS",
      done: async () => (await channelDone("stable")) && (await channelDone("canary")),
      async run() {
        const wt = at(tag);
        const out = stage();
        rmSync(out, { recursive: true, force: true });
        mkdirSync(out, { recursive: true });
        io.run("node", ["scripts/make-feed.mjs", "payload", "--out", out, "--channel", "stable"], { cwd: wt, env: keyEnv(io), stream: true });
        const blobs = walk(path.join(out, "p", "b")).map((f) => `p/b/${f}`);
        const have = await pool(blobs, 8, (f) => okHead(`${BASE}/${f}`));
        const fresh = blobs.filter((_, i) => !have[i]);
        ctx.facts.newBlobs = fresh.length;
        ctx.facts.newBytes = fresh.reduce((n, f) => n + statSync(path.join(out, f)).size, 0);
        // bytes before pointer: blobs and manifests, then the pulses (RELEASING.md §7)
        upload("ship-bytes.tgz", out, [...fresh, ...walk(path.join(out, "p", "m")).map((f) => `p/m/${f}`)]);
        upload("ship-pulses.tgz", out, PLATFORMS.map((p) => `p/zevet/stable/${p}/pulse.json`));
        ctx.facts.stable = await verifyPayload(io, "stable", { expectBuild: v, verify: verifyPulse });
        // Orphaned canary installs: the canary channel was retired 2026-09-30, but installs whose payload
        // `channel` file says canary still poll p/zevet/canary/ and ignore every newer stable update.
        // Keep their pulses current, pointing at the SAME manifests as stable, until none remain.
        const cOut = path.join(ctx.work, "payload-canary");
        rmSync(cOut, { recursive: true, force: true });
        mkdirSync(cOut, { recursive: true });
        io.run("node", ["scripts/make-feed.mjs", "payload", "--out", cOut, "--channel", "canary"], { cwd: wt, env: keyEnv(io), stream: true });
        for (const plat of PLATFORMS) {
          const mine = JSON.parse(readFileSync(path.join(cOut, "p", "zevet", "canary", plat, "pulse.json"), "utf8")).signed.manifest;
          if (mine !== ctx.facts.stable[plat].manifest) throw new Error(`canary/${plat}: manifest ${mine.slice(0, 8)} differs from stable ${ctx.facts.stable[plat].manifest.slice(0, 8)}`);
        }
        upload("ship-canary-pulses.tgz", cOut, PLATFORMS.map((p) => `p/zevet/canary/${p}/pulse.json`));
        ctx.facts.canary = await verifyPayload(io, "canary", { expectBuild: v, verify: verifyPulse });
      },
    },
    {
      name: "verify",
      recheck: false,
      plan: () => "stable links serve the built bytes; served exe Authenticode; payload and feed read back",
      done: async () => false,
      async run() {
        const dir = artifacts();
        const scratch = path.join(ctx.work, "served");
        mkdirSync(scratch, { recursive: true });
        for (const [link, name, key] of INSTALLERS) {
          const file = name(v);
          const built = await fileDigest(path.join(dir, file));
          const served = await io.download(`${BASE}/${link}`, path.join(scratch, link));
          if (served.sha256 !== built.sha256) throw new Error(`${BASE}/${link} serves ${served.sha256.slice(0, 12)}…, ${file} is ${built.sha256.slice(0, 12)}…`);
          ctx.facts[`${key}Sha`] = built.sha256;
          ctx.facts[`${key}Bytes`] = built.bytes;
        }
        ctx.facts.authenticode = authenticode(path.join(scratch, "Zevet-Setup.exe"));
        authenticode(path.join(scratch, "Zevet-Setup-arm64.exe"));
        ctx.facts.stable = await verifyPayload(io, "stable", { expectBuild: v, verify: verifyPulse });
        const feed = JSON.parse((await io.https(`${BASE}/zevet-latest.json`)).body.toString("utf8"));
        if (shell) {
          const { UPDATE_DOMAIN, PINNED_KEYS, verifySigned } = signing();
          verifySigned(UPDATE_DOMAIN, feed.payload, feed.signature, PINNED_KEYS);
          if (feed.payload.version !== v || feed.version !== v) throw new Error(`the live feed says ${feed.version}, want ${v}`);
        } else if (feed.version === v) throw new Error(`a payload-only release must not touch the installer feed, but it says ${v}`);
        if (d.hub) {
          const h = JSON.parse((await io.https(`${HUB}/healthz`)).body.toString("utf8"));
          if (!h.ok) throw new Error("/healthz not ok");
          ctx.facts.hubAfter = JSON.parse((await io.https(`${HUB}/version`)).body.toString("utf8")).build;
        }
      },
    },
    {
      name: "D-record",
      plan: () => "append the release record to DECISIONS.md, rebase onto main, push",
      done() { io.git(["fetch", "-q", "origin", "main"]); return recordHeader(v).test(io.git(["show", "origin/main:DECISIONS.md"])); },
      run() {
        const wt = at("origin/main");
        const file = path.join(wt, "DECISIONS.md");
        const text = readFileSync(file, "utf8");
        const f = ctx.facts;
        const win = f.stable?.["win-x64"], mac = f.stable?.["mac-arm64"];
        const notes = (ctx.notes || notesFrom(subjects(), v)).replace(/\.$/, "");
        const rec = renderRecord(nextDNumber(text), {
          version: v, base: d.base, kind: d.kind, hub: d.hub, shell: d.shell, notes, commits: d.commits ?? "?",
          date: new Date().toISOString().slice(0, 10), authenticode: f.authenticode, exeSha: f.exeSha, exeBytes: f.exeBytes, dmgSha: f.dmgSha, dmgBytes: f.dmgBytes, arm64Sha: f.arm64Sha, arm64Bytes: f.arm64Bytes, appimageSha: f.appimageSha, appimageBytes: f.appimageBytes,
          seq: win?.seq, manifestWin: win?.manifest, manifestMac: mac?.manifest, blobs: win?.blobs, newBlobs: f.newBlobs,
          hubBefore: f.hubBefore, hubAfter: f.hubAfter,
        });
        writeFileSync(file, `${text.replace(/\s*$/, "\n")}\n${rec}`);
        io.git(["add", "DECISIONS.md"], { cwd: wt });
        io.git(["commit", "-q", "-m", `docs: D-record for ${v}`], { cwd: wt });
        io.git(["pull", "--rebase", "-q", "origin", "main"], { cwd: wt });
        io.git(["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: wt });
      },
    },
  ];
  // Facts a step learned (hub build id before, new blob count) must survive the crash that makes a resume.
  // Nothing after the release step can be done before the tag exists, so do not ask the host (ssh is slow).
  return steps.map((s, i) => ({
    ...s,
    done: i === 0 ? s.done : async (c) => remoteTag() && (await s.done(c)),
    async run(c) { await s.run(c); writeFileSync(path.join(ctx.work, "facts.json"), JSON.stringify(ctx.facts)); },
  }));
}

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const io = realIo();
  const log = (s) => console.log(s);

  const release = dryRun ? () => {} : acquireLock(LOCK);
  if (!release) { log("ship: another ship holds the lock; not starting"); process.exit(3); }
  try {
    io.git(["fetch", "-q", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    const feed = JSON.parse((await io.https(`${BASE}/zevet-latest.json`)).body.toString("utf8")).version;
    const d = decide(io, { feed });
    if (d.action === "none") { log(`ship: nothing to ship — ${d.reason}`); return; }
    const ctx = {
      io, d, version: d.version, tag: d.tag || `v${d.version}`, root: ROOT, notes: flag("--notes"), facts: {},
      wt: process.env.ZEVET_SHIP_DIR || path.join(path.dirname(ROOT), "zevet-ship"),
      work: path.join(tmpdir(), "zevet-ship", d.version),
    };
    mkdirSync(ctx.work, { recursive: true });
    if (existsSync(path.join(ctx.work, "facts.json"))) ctx.facts = JSON.parse(readFileSync(path.join(ctx.work, "facts.json"), "utf8"));
    log(`ship ${d.action === "resume" ? "RESUME" : "new"}: ${d.version} (${d.kind}${d.hub ? " + hub" : ""}) — v${d.base}..${d.action === "resume" ? d.tag : `origin/main ${d.tip.slice(0, 7)}`}, ${d.files} file(s)${d.abandoned.length ? `; abandoned: ${d.abandoned.join(", ")}` : ""}`);
    if (d.shell.length) log(`  shell files: ${d.shell.slice(0, 8).join(", ")}${d.shell.length > 8 ? ", …" : ""}`);
    log(`  payload files: ${d.payload.length}, hub files: ${d.hubFiles.length}`);
    const steps = buildSteps(ctx);
    await runSteps(steps, ctx, { dryRun, log });
    log(dryRun ? "ship: dry run, nothing changed" : `ship: ${d.version} is out`);
  } finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`ship: ${e.stack || e.message}`); process.exit(1); });
}
