// The pure half of `npm run ship` (scripts/ship.mjs): what a diff means, the next version,
// whether a release is finished, the lock, and the runner every resumable step goes through.
// Nothing here touches the network; everything that does arrives as `io` (ship.mjs builds the
// real one, test/ship.test.mjs fakes it). docs/RELEASING.md is the manual reference for it all.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

// desktop/ files that are neither payload nor shell: build helpers no installed app loads.
const TOOLING = new Set(["desktop/payload-tree.cjs", "desktop/make-icon.mjs", "desktop/make-dmg-background.swift"]);
// desktop/package.json keys whose change needs a new Electron/native build. `payload` is a payload change.
const SHELL_PKG_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "build", "main"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const payloadMatcher = (patterns) => (rel) =>
  patterns.some((p) => (p.endsWith("/**") ? rel.startsWith(p.slice(0, -2)) : rel === p));

/**
 * RELEASING.md §7: which release is a diff? `files` are repo-relative names from
 * `git diff --name-only <last tag>..origin/main`; `oldPkg`/`newPkg` are desktop/package.json before/after.
 *   shell   — anything the installer carries that a running app cannot swap: bootstrap.js, payload-config.js,
 *             update-signing.js, app-update.js, electron-builder.config.js, signing, natives (desktop/ files that are
 *             not in `payload.files`, dependency / build changes in desktop/package.json, desktop/package-lock.json).
 *             Unknown desktop/ files count as shell: a spare installer bar beats a stranded fix.
 *   payload — desktop/ payload files, client/*.mjs, or only the hub side (board/, hub/, editor/): D-034 shipped a
 *             board-only change as a payload release with zero new blobs.
 *   none    — docs, tests, scripts, DECISIONS.md: nothing to release.
 * `hub` says the hub must be redeployed. The client manifest re-sign every release makes is not a change.
 */
export function classify(files, { oldPkg, newPkg }) {
  const inPayload = payloadMatcher(newPkg?.payload?.files ?? []);
  const shell = [], payload = [], hubFiles = [];
  for (const f of files) {
    if (f.startsWith("desktop/")) {
      if (f.startsWith("desktop/node_modules/")) continue;
      if (f === "desktop/package.json") {
        if (SHELL_PKG_KEYS.some((k) => !same(oldPkg?.[k], newPkg?.[k]))) shell.push(f);
        else if (!same(oldPkg?.payload, newPkg?.payload)) payload.push(f);
        continue; // a version bump alone is the release commit itself
      }
      if (inPayload(f.slice("desktop/".length))) payload.push(f);
      else if (!TOOLING.has(f)) shell.push(f);
      continue;
    }
    if (/^client\/[^/]+\.mjs$/.test(f)) payload.push(f);
    if (f.startsWith("client/") || f.startsWith("board/") || f.startsWith("editor/") || (f.startsWith("hub/") && f !== "hub/client-manifest.signed.json")) hubFiles.push(f);
  }
  const kind = shell.length ? "shell" : payload.length || hubFiles.length ? "payload" : "none";
  return { kind, hub: hubFiles.length > 0, shell, payload, hubFiles };
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Shell modules the payload's main.js loads through bootShell.require("./x.js"). */
export const shellRequires = (mainSrc) => [...stripComments(mainSrc).matchAll(/bootShell\.require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);

/**
 * A payload that loads a shell module the last release's installer did not carry crashes at load on every
 * install still on that shell (0.2.100: update-rollback.js, shell 0.2.96). The only safe way to ship it is to
 * bump payload-config.js SHELL_VERSION, so the pulse's shell_min holds the payload back until the installer lands.
 * Returns the problems (empty = fine).
 */
export function shellContractErrors({ mainSrc, oldPkg, oldShellVersion, newShellVersion }) {
  const had = new Set((oldPkg?.build?.files ?? []).filter((f) => !f.startsWith("!")));
  const fresh = shellRequires(mainSrc).filter((f) => !had.has(f));
  if (!fresh.length || newShellVersion > oldShellVersion) return [];
  return [`main.js loads ${fresh.join(", ")} from the shell, which the previous release's installer did not carry; bump SHELL_VERSION in desktop/payload-config.js (now ${newShellVersion}) so the payload waits for the installer`];
}
const shellVersionOf = (src) => Number(/SHELL_VERSION\s*=\s*(\d+)/.exec(src)?.[1] ?? 0);

const V = /^v?(\d+)\.(\d+)\.(\d+)$/;
export const isVersion = (s) => V.test(String(s));
export const cmpVersion = (a, b) => {
  const [x, y] = [a, b].map((s) => V.exec(s).slice(1).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
export const sortVersions = (list) => list.filter(isVersion).map((s) => s.replace(/^v/, "")).sort(cmpVersion).reverse();

/** One above the highest of every version anyone has published (tags AND the live feed — a tag whose CI
 *  failed never reached anyone, but a feed can be ahead of the tags). seqOf allows a patch up to 999. */
export function nextVersion(...lists) {
  const [top] = sortVersions(lists.flat());
  const [maj, min, pat] = top.split(".").map(Number);
  return pat >= 999 ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

/** 'green' | 'red' | 'pending' | 'none' from `gh run list --json status,conclusion,createdAt` for one commit. */
export function ciVerdict(runs) {
  const [latest] = [...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!latest) return "none";
  if (latest.status !== "completed") return "pending";
  return latest.conclusion === "success" ? "green" : "red";
}

/** The D-record header a finished release leaves in DECISIONS.md; also how "finished" is recognised. */
export const recordHeader = (version) => new RegExp(`^## D-\\d+ — Shipped: ${version.replaceAll(".", "\\.")}\\b`, "m");
export const nextDNumber = (decisions) => Math.max(0, ...[...decisions.matchAll(/^## D-(\d+)/gm)].map((m) => Number(m[1]))) + 1;

/** One short line for the rail: the newest commit subject without its `type(scope):` prefix. */
export function notesFrom(subjects, version) {
  const s = (subjects[0] || "").replace(/^\w+(\([^)]*\))?!?:\s*/, "").trim();
  return (s ? s[0].toUpperCase() + s.slice(1) : `Zevet ${version}`).slice(0, 90);
}

/**
 * What should ship, if anything. Reads only git and gh through `io`.
 *   resume — the newest tag is not finished (no D-record, build not failed): run its steps again, each skips
 *            what is done. A tag whose build.yml failed never reached anyone: it is abandoned and superseded.
 *   new    — commits past the last finished release that classify() calls a release.
 *   none   — nothing.
 */
export function decide(io, { ref = "origin/main", feed, soaking = () => null } = {}) {
  const tags = sortVersions(io.git(["tag", "--list", "v*"]).split(/\r?\n/));
  if (!tags.length) throw new Error("no v* tags: ship needs a previous release to diff against");
  const tip = io.git(["rev-parse", ref]);
  const decisions = io.git(["show", `${ref}:DECISIONS.md`]);
  const abandoned = [];
  let base = null;
  for (const [i, v] of tags.slice(0, 6).entries()) {
    if (recordHeader(v).test(decisions)) { base = v; break; }
    const run = io.buildRun(`v${v}`);
    if (run && ["failure", "cancelled", "timed_out"].includes(run.conclusion)) { abandoned.push(v); continue; }
    // Soaking on canary with shippable work past it: the newer build supersedes it rather
    // than waiting behind it (a canary that fails its gate must not block every later fix).
    if (i === 0 && soaking(v) && classifyRange(io, `v${v}`, ref).kind !== "none") { base = v; break; }
    // Unfinished. Its own diff (against the tag before it) says what it was.
    const prev = tags.slice(i + 1).find((t) => !abandoned.includes(t));
    return { action: "resume", version: v, tag: `v${v}`, base: prev, tip, abandoned, ...classifyRange(io, `v${prev}`, `v${v}`) };
  }
  if (!base) throw new Error(`no finished release among ${tags.slice(0, 6).join(", ")} — is DECISIONS.md at ${ref} current?`);
  const c = classifyRange(io, `v${base}`, ref);
  const commits = Number(io.git(["rev-list", "--count", `v${base}..${ref}`]));
  if (c.kind === "none") return { action: "none", base, tip, commits, abandoned, reason: commits ? `${commits} commit(s) past v${base}, none of them shippable (docs/tests/scripts)` : `no commits past v${base}`, ...c };
  return { action: "new", version: nextVersion(tags, feed ? [feed] : []), base, tip, commits, abandoned, ...c };
}

function classifyRange(io, from, to) {
  const at = (r, f) => io.git(["show", `${r}:${f}`]);
  const errs = shellContractErrors({
    mainSrc: at(to, "desktop/main.js"), oldPkg: JSON.parse(at(from, "desktop/package.json")),
    oldShellVersion: shellVersionOf(at(from, "desktop/payload-config.js")), newShellVersion: shellVersionOf(at(to, "desktop/payload-config.js")),
  });
  if (errs.length) throw new Error(`refusing to ship ${to}: ${errs.join("; ")}`);
  const files = io.git(["diff", "--name-only", from, to]).split(/\r?\n/).filter(Boolean);
  const pkg = (r) => JSON.parse(io.git(["show", `${r}:desktop/package.json`]));
  return { files: files.length, ...classify(files, { oldPkg: pkg(from), newPkg: pkg(to) }) };
}

/** Run steps in order. A step is { name, plan(ctx), done(ctx), run(ctx), recheck? }: done() is the whole
 *  idempotence story — it is asked first, so a re-run after a crash skips what landed, and asked again after
 *  run() (unless recheck is false) so a step cannot claim success it did not achieve. */
export async function runSteps(steps, ctx, { dryRun = false, log = console.log } = {}) {
  for (const s of steps) {
    let done = false, note = "";
    try { done = await s.done(ctx); } catch (e) { note = `  (check failed: ${e.message.split("\n")[0]})`; }
    if (done) { log(`[done] ${s.name}`); continue; }
    if (dryRun) { log(`[todo] ${s.name} — ${s.plan(ctx)}${note}`); continue; }
    log(`[run ] ${s.name}${note}`);
    await s.run(ctx);
    if (s.recheck !== false && !(await s.done(ctx))) throw new Error(`${s.name}: ran, but its own check still says it is not done`);
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Exclusive lock file. Returns a release() or null when a live ship holds it. A dead pid or a lock older
 *  than `maxAge` is stale and taken over. */
export function acquireLock(file, { pid = process.pid, now = Date.now(), alive = pidAlive, maxAge = 4 * 3600e3 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, JSON.stringify({ pid, at: now }));
      closeSync(fd);
      return () => { try { unlinkSync(file); } catch { /* already gone */ } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (lockHeld(file, { now, alive, maxAge })) return null;
      try { unlinkSync(file); } catch { /* raced */ }
    }
  }
  return null;
}

export function lockHeld(file, { now = Date.now(), alive = pidAlive, maxAge = 4 * 3600e3 } = {}) {
  if (!existsSync(file)) return false;
  try {
    const { pid, at } = JSON.parse(readFileSync(file, "utf8"));
    return alive(pid) && now - at < maxAge;
  } catch { return false; }
}

/** The D-record ship appends. `f` is the facts the steps gathered; missing ones are said, not invented. */
export function renderRecord(n, f) {
  const kind = f.kind === "shell" ? "shell release" : "payload-only";
  const hub = f.hub ? ", hub deploy" : "";
  const short = (h) => (h ? `${h.slice(0, 8)}…` : "?");
  const lines = [
    `## D-${String(n).padStart(3, "0")} — Shipped: ${f.version}, ${f.notes} (${kind}${hub})`,
    "",
    `**Decided (automatic, \`npm run ship\`, ${f.date}).** ${f.commits} commit(s) past v${f.base}.`,
    "",
    f.kind === "shell"
      ? `- **Shell release.** ${f.shell.slice(0, 6).join(", ")}${f.shell.length > 6 ? ", …" : ""} changed: installers + signed installer feed (\`zevet-latest.json\` -> ${f.version}) + payload.`
      : `- **Payload-only, not a shell release.** No shell file changed; \`zevet-latest.json\` untouched. Installers for ${f.version} were built and published, and the stable \`Zevet-Setup.exe\` / \`Zevet.dmg\` links repointed, for new downloads.`,
    `- **Verified.** Gate \`node scripts/run-tests.mjs\` green on the release tree; tag \`v${f.version}\`; \`build.yml\` both legs green; exe Authenticode \`${f.authenticode || "?"}\`. sha256: exe \`${short(f.exeSha)}\` (${f.exeBytes ?? "?"} B), dmg \`${short(f.dmgSha)}\` (${f.dmgBytes ?? "?"} B); the stable links serve those bytes.`,
    `- **Payload:** canary, verified over HTTPS, then stable; seq ${f.seq ?? "?"} on both platforms. Manifests win \`${short(f.manifestWin)}\`, mac \`${short(f.manifestMac)}\`. Delta: ${f.newBlobs ?? "?"} new blob(s) uploaded. ${f.blobs ?? "?"} blobs per platform brotli-decode to their manifest hashes; pulses verify under \`zevet-2026-09\`.`,
  ];
  if (f.hub) lines.push(`- **Hub** redeployed from the tag in place; \`BUILD_ID\` \`${f.hubBefore || "?"}\` -> \`${f.hubAfter || "?"}\`; \`/healthz\` ok.`);
  lines.push("", "**Not verified.** No live app was launched, restarted or killed (the installed Zevet was left alone).", "");
  return lines.join("\n");
}

// ── the canary soak gate (ported from masora2 scripts/promote-canary.mjs) ───────────────────────────
export const SENTRY_PROJECT = "masora/electron";
export const SOAK_DEFAULTS = { minHours: 4, maxNewIssues: 0, allowUnseen: false };

/** The whole promote decision, pure. `facts`: { canaryAt (ISO string | undefined), now (ms), sentry: { seen, newIssues } | null }.
 *  Every reason, not just the first. No canary record is never ok: the clock has not started. */
export function decideSoak(facts, opts = {}) {
  const { minHours, maxNewIssues, allowUnseen } = { ...SOAK_DEFAULTS, ...opts };
  const reasons = [];
  const at = Date.parse(facts.canaryAt);
  if (!Number.isFinite(at)) reasons.push("no canary time recorded yet");
  else if (!((facts.now - at) / 3600e3 >= minHours)) reasons.push(`on canary ${((facts.now - at) / 3600e3).toFixed(1)} h, need ${minHours} h`);
  if (!facts.sentry) reasons.push("Sentry could not be read");
  else {
    if (!facts.sentry.seen && !allowUnseen) reasons.push("Sentry has never seen this release (no telemetry is not evidence of health)");
    if (facts.sentry.newIssues > maxNewIssues) reasons.push(`${facts.sentry.newIssues} new Sentry issue(s) since canary, limit ${maxNewIssues}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** New issues on `zevet@version` first seen since `since`: { seen, newIssues }. `run(args)` returns parsed `sentry … --json`. */
export function readSentry(version, since, run) {
  let seen = true;
  try { run(["release", "view", `masora/zevet@${version}`]); } catch { seen = false; }
  const list = run(["issue", "list", SENTRY_PROJECT, "--query", `release:zevet@${version}`, "--period", "14d", "--limit", "200"]);
  const rows = Array.isArray(list) ? list : list.data || [];
  return { seen, newIssues: rows.filter((i) => i.firstSeen && new Date(i.firstSeen) >= since).length };
}
