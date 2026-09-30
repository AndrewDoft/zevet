// `npm run ship` (scripts/ship.mjs) and its watcher: the decisions, and the "already done, skip it" checks
// that make a crashed ship repairable by running it again. gh, ssh, https and git are fakes; the payload
// read-back runs against what desktop-kit's real publish-payload.mjs wrote, so it is not a self-portrait.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { brotliCompressSync } from "node:zlib";
import path from "node:path";
import { tempDir, ROOT } from "./helpers.mjs";
import {
  acquireLock, ciVerdict, classify, cmpVersion, decide, lockHeld, nextDNumber, nextVersion, notesFrom, recordHeader, renderRecord, runSteps,
} from "../scripts/ship-lib.mjs";
import { BASE, PLATFORMS, buildSteps, bumpVersion, ensureWorktree, exeName, dmgName, pulseState, samePath, verifyPayload } from "../scripts/ship.mjs";
import { tick } from "../scripts/ship-watch.mjs";

const require = createRequire(import.meta.url);
const KIT = path.join(ROOT, "desktop", "node_modules", "@masora", "desktop-kit");
const PKG = { payload: { files: ["main.js", "agent-api.js", "fonts/**", "build/icon.png"] }, dependencies: { a: "1" }, version: "0.2.93" };

const kind = (files, newPkg = PKG, oldPkg = PKG) => classify(files, { oldPkg, newPkg });

describe("classify: RELEASING.md §7 as a function", () => {
  test("payload files, client/*.mjs and the payload globs are a payload release", () => {
    assert.equal(kind(["desktop/main.js"]).kind, "payload");
    assert.equal(kind(["desktop/fonts/x.woff2"]).kind, "payload");
    assert.equal(kind(["desktop/build/icon.png"]).kind, "payload");
    const c = kind(["client/hook.mjs"]);
    assert.deepEqual([c.kind, c.hub], ["payload", true]); // the hub serves client/
  });
  test("the shell files are a shell release, and so is any desktop file nobody vouched for", () => {
    for (const f of ["bootstrap.js", "payload-config.js", "update-signing.js", "app-update.js", "electron-builder.config.js", "package-lock.json", "brand-new-native.node"]) {
      assert.equal(kind(["desktop/main.js", `desktop/${f}`]).kind, "shell", f);
    }
  });
  test("shell wins over payload; tooling under desktop/ is neither", () => {
    assert.equal(kind(["desktop/main.js", "desktop/bootstrap.js"]).kind, "shell");
    assert.equal(kind(["desktop/payload-tree.cjs"]).kind, "none");
  });
  test("desktop/package.json: version alone is nothing, deps are shell, the payload list is payload", () => {
    assert.equal(kind(["desktop/package.json"], { ...PKG, version: "0.2.94" }).kind, "none");
    assert.equal(kind(["desktop/package.json"], { ...PKG, dependencies: { a: "2" } }).kind, "shell");
    assert.equal(kind(["desktop/package.json"], { ...PKG, payload: { files: [...PKG.payload.files, "new.js"] } }).kind, "payload");
  });
  test("board- or hub-only is a payload release with a hub deploy (D-034); the re-signed manifest alone is not a change", () => {
    const b = kind(["board/src/x.tsx", "hub/public/board.js"]);
    assert.deepEqual([b.kind, b.hub, b.payload.length], ["payload", true, 0]);
    assert.equal(kind(["hub/client-manifest.signed.json"]).kind, "none");
  });
  test("docs, tests, scripts and DECISIONS.md are not a release", () => {
    assert.equal(kind(["DECISIONS.md", "docs/RELEASING.md", "test/x.test.mjs", "scripts/ship.mjs", ".github/workflows/ci.yml"]).kind, "none");
  });
});

describe("versions", () => {
  test("next is above the highest tag AND the live feed, compared numerically", () => {
    assert.equal(nextVersion(["v0.2.9", "v0.2.93", "v0.2.100"]), "0.2.101");
    assert.equal(nextVersion(["v0.2.93"], ["0.2.95"]), "0.2.96");
    assert.equal(nextVersion(["v0.2.999"]), "0.3.0");
    assert.ok(cmpVersion("0.10.0", "0.9.9") > 0);
  });
  test("ciVerdict reads the newest run for the commit", () => {
    assert.equal(ciVerdict([]), "none");
    assert.equal(ciVerdict([{ status: "in_progress", createdAt: "2" }]), "pending");
    assert.equal(ciVerdict([{ status: "completed", conclusion: "failure", createdAt: "2" }, { status: "completed", conclusion: "success", createdAt: "1" }]), "red");
    assert.equal(ciVerdict([{ status: "completed", conclusion: "failure", createdAt: "1" }, { status: "completed", conclusion: "success", createdAt: "2" }]), "green");
  });
});

// ── a fake git: tags, one diff per range, desktop/package.json per ref, DECISIONS.md ──────────────────
function fakeGit({ tags, files, decisions, builds = {}, tip = "abcdef1234567", commits = 3, pkgs = {} }) {
  return {
    buildRun: (t) => builds[t] || null,
    git(args) {
      const a = args.join(" ");
      if (a === "tag --list v*") return tags.join("\n");
      if (a.startsWith("rev-parse")) return tip;
      if (a.startsWith("show") && a.endsWith("DECISIONS.md")) return decisions;
      if (a.startsWith("show") && a.endsWith("desktop/package.json")) return JSON.stringify(pkgs[args[1].split(":")[0]] || PKG);
      if (a.startsWith("rev-list --count")) return String(commits);
      if (a.startsWith("diff --name-only")) return (files[args[2] + ".." + args[3]] ?? files.default ?? []).join("\n");
      throw new Error(`fake git: ${a}`);
    },
  };
}
const rec = (v) => `## D-036 — Shipped: ${v}, x (payload-only)\n`;

describe("decide", () => {
  test("nothing past the last finished release", () => {
    const d = decide(fakeGit({ tags: ["v0.2.93", "v0.2.92"], decisions: rec("0.2.93"), files: { default: [] }, commits: 0 }));
    assert.equal(d.action, "none");
  });
  test("only docs/tests past it: still none (the D-record commit must not re-trigger a ship)", () => {
    const d = decide(fakeGit({ tags: ["v0.2.93"], decisions: rec("0.2.93"), files: { default: ["DECISIONS.md", "test/a.test.mjs"] } }));
    assert.equal(d.action, "none");
  });
  test("a releasable diff is a new release at the next version", () => {
    const d = decide(fakeGit({ tags: ["v0.2.93", "v0.2.92"], decisions: rec("0.2.93"), files: { default: ["desktop/main.js", "board/src/a.tsx"] } }), { feed: "0.2.92" });
    assert.deepEqual([d.action, d.version, d.kind, d.hub, d.base], ["new", "0.2.94", "payload", true, "0.2.93"]);
  });
  test("an unfinished newest tag is resumed, classified by its own diff", () => {
    const d = decide(fakeGit({ tags: ["v0.2.94", "v0.2.93"], decisions: rec("0.2.93"), files: { "v0.2.93..v0.2.94": ["desktop/bootstrap.js"], default: [] }, builds: { "v0.2.94": { conclusion: "success" } } }));
    assert.deepEqual([d.action, d.version, d.kind, d.base], ["resume", "0.2.94", "shell", "0.2.93"]);
  });
  test("a tag whose build failed is abandoned: the diff is against the last GOOD release, the version above the dead tag", () => {
    const d = decide(fakeGit({ tags: ["v0.2.94", "v0.2.93"], decisions: rec("0.2.93"), files: { default: ["desktop/main.js"] }, builds: { "v0.2.94": { conclusion: "failure" } } }));
    assert.deepEqual([d.action, d.version, d.base, d.abandoned], ["new", "0.2.95", "0.2.93", ["0.2.94"]]);
  });
});

describe("runSteps", () => {
  const mk = (name, state, log) => ({ name, plan: () => `plan ${name}`, done: () => state.done, run() { log.push(name); state.done = true; } });
  test("skips what is done; a second run after a crash does only the rest", async () => {
    const ran = [], a = { done: false }, b = { done: false };
    const steps = [mk("a", a, ran), { ...mk("b", b, ran), run() { throw new Error("boom"); } }];
    await assert.rejects(runSteps(steps, {}, { log() {} }), /boom/);
    assert.deepEqual(ran, ["a"]);
    ran.length = 0;
    await runSteps([mk("a", a, ran), mk("b", b, ran)], {}, { log() {} });
    assert.deepEqual(ran, ["b"]);
  });
  test("--dry-run runs nothing and prints the plan", async () => {
    const ran = [], lines = [];
    await runSteps([mk("a", { done: false }, ran), mk("b", { done: true }, ran)], {}, { dryRun: true, log: (l) => lines.push(l) });
    assert.deepEqual(ran, []);
    assert.deepEqual(lines, ["[todo] a — plan a", "[done] b"]);
  });
  test("a step that ran but whose own check still fails is an error, not a success", async () => {
    await assert.rejects(runSteps([{ name: "liar", plan: () => "", done: () => false, run() {} }], {}, { log() {} }), /still says it is not done/);
  });
});

describe("lock", () => {
  test("second acquirer is refused while the holder lives; a dead pid or an old lock is taken over", () => {
    const d = tempDir("zevet-ship-lock-");
    const f = path.join(d.dir, "l");
    const release = acquireLock(f, { pid: 1, now: 1000, alive: () => true });
    assert.equal(typeof release, "function");
    assert.equal(acquireLock(f, { pid: 2, now: 2000, alive: () => true }), null);
    assert.equal(lockHeld(f, { now: 2000, alive: () => true }), true);
    assert.equal(typeof acquireLock(f, { pid: 3, now: 2000, alive: () => false }), "function"); // holder died
    assert.equal(typeof acquireLock(f, { pid: 4, now: 2000 + 5 * 3600e3, alive: () => true }), "function"); // too old
    release();
    d.cleanup();
  });
});

describe("the watcher tick", () => {
  const io = (runs, over = {}) => ({
    ...fakeGit({ tags: ["v0.2.93"], decisions: rec("0.2.93"), files: { default: ["desktop/main.js"] }, ...over }),
    gh: () => JSON.stringify(runs),
  });
  const run = (i, held = false) => { const shipped = []; return tick({ io: i, held: () => held, feed: async () => "0.2.93", runShip: async () => { shipped.push(1); return 0; } }).then((r) => ({ ...r, shipped: shipped.length })); };
  test("ships on releasable commits with a green ci", async () => {
    const r = await run(io([{ status: "completed", conclusion: "success", createdAt: "1" }]));
    assert.deepEqual([r.did, r.shipped], ["ship", 1]);
  });
  test("does not ship on red, pending or absent ci, or while a ship runs", async () => {
    for (const runs of [[{ status: "completed", conclusion: "failure", createdAt: "1" }], [{ status: "queued", createdAt: "1" }], []]) {
      assert.equal((await run(io(runs))).shipped, 0);
    }
    assert.equal((await run(io([{ status: "completed", conclusion: "success", createdAt: "1" }]), true)).shipped, 0);
  });
  test("a crashed ship (unfinished tag) resumes without asking ci", async () => {
    const r = await run(io([], { tags: ["v0.2.94", "v0.2.93"], files: { default: [] }, builds: { "v0.2.94": { conclusion: "success" } } }));
    assert.deepEqual([r.did, r.shipped], ["ship", 1]);
  });
  test("nothing releasable: no ship, and ci is not even read", async () => {
    const i = io([], { files: { default: ["docs/x.md"] } });
    i.gh = () => { throw new Error("gh must not be called"); };
    assert.equal((await run(i)).shipped, 0);
  });
});

describe("records", () => {
  test("the header recognises a finished release, and D-numbers continue", () => {
    assert.ok(recordHeader("0.2.9").test("## D-001 — Shipped: 0.2.9, x"));
    assert.ok(!recordHeader("0.2.9").test("## D-001 — Shipped: 0.2.93, x"));
    assert.equal(nextDNumber("## D-035 — a\n## D-036 — b\n"), 37);
  });
  test("notes are one short line without the conventional-commit prefix", () => {
    assert.equal(notesFrom(["fix(agent-console): launch hooks in place", "x"], "0.2.94"), "Launch hooks in place");
    assert.equal(notesFrom([], "0.2.94"), "Zevet 0.2.94");
  });
  test("renderRecord carries the facts and says what it does not know", () => {
    const text = renderRecord(37, { version: "0.2.94", base: "0.2.93", kind: "payload", hub: true, shell: [], notes: "X", commits: 4, date: "2026-09-30", seq: 2094, blobs: 67, newBlobs: 1, exeSha: "ab".repeat(32), hubBefore: "aaa", hubAfter: "bbb" });
    assert.match(text, /^## D-037 — Shipped: 0\.2\.94, X \(payload-only, hub deploy\)/);
    assert.match(text, /seq 2094/);
    assert.match(text, /`aaa` -> `bbb`/);
    assert.ok(recordHeader("0.2.94").test(text));
  });
});

describe("bumpVersion", () => {
  test("bumps the top-level version and leaves a stale lockfile line alone", () => {
    const d = tempDir("zevet-ship-bump-");
    mkdirSync(path.join(d.dir, "desktop"));
    const pkg = '{\n  "name": "z",\n  "version": "0.2.93",\n  "dependencies": {"version": "0.2.93"}\n}\n';
    writeFileSync(path.join(d.dir, "package.json"), pkg);
    writeFileSync(path.join(d.dir, "desktop", "package.json"), pkg);
    writeFileSync(path.join(d.dir, "package-lock.json"), '{\n  "version": "0.2.93",\n  "packages": {"": {\n      "version": "0.2.91"\n}}}\n');
    bumpVersion(d.dir, "0.2.93", "0.2.94");
    assert.match(readFileSync(path.join(d.dir, "package.json"), "utf8"), /"version": "0.2.94"/);
    assert.match(readFileSync(path.join(d.dir, "package-lock.json"), "utf8"), /0\.2\.94[\s\S]*0\.2\.91/);
    assert.throws(() => bumpVersion(d.dir, "0.2.93", "0.2.95"), /no "version": "0.2.93"/);
    d.cleanup();
  });
});

describe("ensureWorktree", () => {
  test("refuses the checkout it runs from and any directory that is not this repo's worktree", () => {
    const d = tempDir("zevet-ship-wt-");
    const io = { git: () => "" };
    assert.throws(() => ensureWorktree({ io, wt: ROOT }, "x"), /own directory/);
    assert.throws(() => ensureWorktree({ io, wt: d.dir }, "x"), /not a worktree of this repo/);
    d.cleanup();
  });
});

// ── the payload read-back, against bytes the real publisher wrote ─────────────────────────────────────
function publish(t, channel, build, seq, out, { pem, keyId }) {
  const tree = path.join(out, `tree-${build}`);
  mkdirSync(tree, { recursive: true });
  writeFileSync(path.join(tree, "main.js"), `// ${build}\n`);
  writeFileSync(path.join(tree, "same.js"), "// same\n");
  const env = { ...process.env, K: pem.replaceAll("\n", "|") };
  for (const platform of PLATFORMS) {
    const r = spawnSync(process.execPath, [path.join(KIT, "bin", "publish-payload.mjs"), "--app", "zevet", "--channel", channel, "--platform", platform, "--build", build, "--seq", String(seq),
      "--schema-head", "0", "--shell-min", "1", "--tree", tree, "--out", out, "--key-env", "K", "--key-id", keyId], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
}

function host(out, over = {}) {
  const requests = [];
  return {
    requests,
    async https(url, { method = "GET" } = {}) {
      requests.push(`${method} ${url}`);
      if (over.https) { const r = over.https(url, method); if (r) return r; }
      const rel = url.replace(`${BASE}/`, "");
      const file = path.join(out, rel);
      if (!rel.startsWith("p/") || !existsSync(file)) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      const headers = { "cache-control": rel.endsWith("pulse.json") ? "no-store" : "public, max-age=31536000, immutable" };
      return { status: 200, headers, body: method === "HEAD" ? Buffer.alloc(0) : readFileSync(file) };
    },
  };
}

describe("verifyPayload / pulseState (real publisher output)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const signer = { pem: privateKey.export({ format: "pem", type: "pkcs8" }), keyId: "zevet-test" };
  const { verifySigned } = require(path.join(ROOT, "desktop", "update-signing.js"));
  const { PULSE_DOMAIN } = require(path.join(KIT, "lib", "payload.js"));
  const verify = (signed, sig) => verifySigned(PULSE_DOMAIN, signed, sig, { "zevet-test": raw });

  test("passes on what the publisher wrote, and reports seq/build/blob count", async (t) => {
    const d = tempDir("zevet-ship-pay-"); t.after(() => d.cleanup());
    publish(t, "canary", "0.2.94", 2094, d.dir, signer);
    const facts = await verifyPayload(host(d.dir), "canary", { expectBuild: "0.2.94", verify });
    assert.deepEqual([facts["win-x64"].seq, facts["mac-arm64"].build, facts["win-x64"].blobs], [2094, "0.2.94", 2]);
  });
  test("a blob whose bytes are not what the manifest says is caught", async (t) => {
    const d = tempDir("zevet-ship-pay-"); t.after(() => d.cleanup());
    publish(t, "canary", "0.2.94", 2094, d.dir, signer);
    const h = host(d.dir, { https: (url) => (url.includes("/p/b/") ? { status: 200, headers: { "cache-control": "immutable" }, body: Buffer.from("garbage") } : null) });
    await assert.rejects(verifyPayload(h, "canary", { expectBuild: "0.2.94", verify }), /does not brotli-decode/);
    const valid = host(d.dir, { https: (url) => (url.includes("/p/b/") ? { status: 200, headers: { "cache-control": "immutable" }, body: brotliCompressSync(Buffer.from("other bytes")) } : null) });
    await assert.rejects(verifyPayload(valid, "canary", { expectBuild: "0.2.94", verify }), /does not decode to its hash/);
  });
  test("the wrong build, a signature under another key, or a cacheable pulse each fail", async (t) => {
    const d = tempDir("zevet-ship-pay-"); t.after(() => d.cleanup());
    publish(t, "canary", "0.2.94", 2094, d.dir, signer);
    await assert.rejects(verifyPayload(host(d.dir), "canary", { expectBuild: "0.2.95", verify }), /want 0\.2\.95/);
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    await assert.rejects(verifyPayload(host(d.dir), "canary", { expectBuild: "0.2.94", verify: (s, g) => verifySigned(PULSE_DOMAIN, s, g, { "zevet-test": other }) }));
    const cacheable = host(d.dir, { https: (url) => (url.endsWith("pulse.json") ? { status: 200, headers: { "cache-control": "max-age=60" }, body: readFileSync(path.join(d.dir, url.replace(`${BASE}/`, ""))) } : null) });
    await assert.rejects(verifyPayload(cacheable, "canary", { expectBuild: "0.2.94", verify }), /no-store/);
  });
  test("pulseState is null where the host has no pulse (a first ever canary)", async (t) => {
    const d = tempDir("zevet-ship-pay-"); t.after(() => d.cleanup());
    const s = await pulseState(host(d.dir), "canary", verify);
    assert.deepEqual(s, { "win-x64": null, "mac-arm64": null });
  });
});

// ── the idempotence checks of every step, against fakes for gh / ssh / https / git ────────────────────
describe("step checks decide 'already done'", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const signer = { pem: privateKey.export({ format: "pem", type: "pkcs8" }), keyId: "zevet-test" };

  function world(t, { tagged = true, files = new Set(), ssh = () => "", build = { conclusion: "success" }, decisions = "", feedVersion = "0.2.93", pay, kind = "payload", hub = true } = {}) {
    const d = tempDir("zevet-ship-w-"); t.after(() => d.cleanup());
    if (pay) publish(t, ...pay.slice(0, 3), d.dir, signer);
    const sshCalls = [];
    const inner = host(d.dir);
    const io = {
      log() {},
      buildRun: () => build,
      git(args) {
        const a = args.join(" ");
        if (a.startsWith("ls-remote --tags")) return tagged ? "sha\trefs/tags/v0.2.94" : "";
        if (a.startsWith("fetch")) return "";
        if (a.startsWith("show origin/main:DECISIONS.md")) return decisions;
        throw new Error(`fake git: ${a}`);
      },
      ssh(script) { sshCalls.push(script); return ssh(script); },
      async https(url, o) {
        const rel = url.replace(`${BASE}/`, "");
        if (files.has(rel)) return { status: 200, headers: {}, body: Buffer.from(rel === "zevet-latest.json" ? JSON.stringify({ version: feedVersion }) : "x") };
        if (rel === "zevet-latest.json") return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ version: feedVersion })) };
        return inner.https(url, o);
      },
    };
    const ctx = { io, root: ROOT, keys: { "zevet-test": raw }, version: "0.2.94", tag: "v0.2.94", d: { kind, hub, base: "0.2.93", shell: [], hubFiles: hub ? ["board/src/a.tsx"] : [] }, facts: {}, work: d.dir, wt: path.join(d.dir, "wt") };
    const steps = buildSteps(ctx);
    return { ctx, sshCalls, check: async (name) => steps.find((s) => s.name === name).done(ctx), steps };
  }

  test("the release step is done iff the tag is on origin; nothing else asks the host before that", async (t) => {
    const w = world(t, { tagged: false, ssh: () => { throw new Error("must not ssh"); } });
    assert.equal(await w.check("release v0.2.94"), false);
    for (const s of w.steps.slice(1)) assert.equal(await s.done(w.ctx), false, s.name);
    assert.deepEqual(w.sshCalls, []);
    assert.equal(await world(t).check("release v0.2.94"), true);
  });
  test("build.yml: done only on a success conclusion", async (t) => {
    assert.equal(await world(t).check("build.yml"), true);
    assert.equal(await world(t, { build: { conclusion: "failure" } }).check("build.yml"), false);
    assert.equal(await world(t, { build: null }).check("build.yml"), false);
  });
  test("installers: both files must be on the host", async (t) => {
    const both = new Set([exeName("0.2.94"), dmgName("0.2.94")]);
    assert.equal(await world(t, { files: both }).check("installers"), true);
    assert.equal(await world(t, { files: new Set([exeName("0.2.94")]) }).check("installers"), false);
  });
  test("stable links always runs: a host file already edited is not a reloaded Caddy", async (t) => {
    // The first real ship edited the host file, then died on the container check;
    // a done-check reading the host file would have skipped the reload for ever.
    assert.equal(await world(t, { ssh: () => "2\n" }).check("stable links"), false);
    const src = readFileSync(new URL("../scripts/ship.mjs", import.meta.url), "utf8");
    assert.ok(src.includes('docker exec $C grep -c "zevet-${v}-" /etc/caddy/Caddyfile'), "the container sees the file at /etc/caddy/Caddyfile");
  });
  test("hub: the marker the deploy writes must name the version", async (t) => {
    assert.equal(await world(t, { ssh: () => "0.2.94\n" }).check("hub"), true);
    assert.equal(await world(t, { ssh: () => "0.2.93\n" }).check("hub"), false);
    assert.equal(await world(t, { ssh: () => "" }).check("hub"), false);
  });
  test("payload canary / stable: done when BOTH platforms' verified pulse carries the build", async (t) => {
    const pay = ["canary", "0.2.94", 2094];
    assert.equal(await world(t, { pay }).check("payload canary"), true);
    assert.equal(await world(t, { pay }).check("payload stable"), false); // canary only
    assert.equal(await world(t, { pay: ["canary", "0.2.93", 2093] }).check("payload canary"), false); // an older build
    assert.equal(await world(t).check("payload canary"), false); // nothing published
    assert.equal(await world(t, { pay: ["stable", "0.2.94", 2094] }).check("payload stable"), true);
  });
  test("installer feed: shell releases only, done when the live feed names the version", async (t) => {
    assert.equal(world(t).steps.some((s) => s.name === "installer feed"), false);
    const s = world(t, { kind: "shell", feedVersion: "0.2.94" });
    assert.equal(await s.check("installer feed"), true);
    assert.equal(await world(t, { kind: "shell" }).check("installer feed"), false);
  });
  test("D-record: done iff origin/main has the header", async (t) => {
    assert.equal(await world(t, { decisions: rec("0.2.94") }).check("D-record"), true);
    assert.equal(await world(t, { decisions: rec("0.2.93") }).check("D-record"), false);
  });
  test("the hub step exists only when the hub changed; installers come before the feed, the feed before the links", (t) => {
    const names = (o) => world(t, o).steps.map((s) => s.name);
    assert.ok(names({ hub: true }).includes("hub"));
    assert.ok(!names({ hub: false }).includes("hub"));
    const n = names({ kind: "shell" });
    assert.ok(n.indexOf("installers") < n.indexOf("installer feed") && n.indexOf("installer feed") < n.indexOf("stable links"));
    assert.ok(n.indexOf("payload canary") < n.indexOf("payload stable") && n.at(-1) === "D-record");
  });
});

test("ship finds its own worktree however git spelled the path (Windows is case-insensitive)", () => {
  // Observed 2026-09-30: git listed C:/dev/Github/zevet-ship, ship asked for C:/dev/GitHub/zevet-ship,
  // and the resumed ship refused the worktree it had made itself.
  assert.equal(samePath("C:/dev/Github/zevet-ship", "C:/dev/GitHub/zevet-ship", "win32"), true);
  assert.equal(samePath("/srv/Zevet", "/srv/zevet", "linux"), false);
});
