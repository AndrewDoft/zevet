// Sentry debug IDs + source maps are produced from a STAGED COPY of the release tree. `sentry sourcemap inject`
// rewrites the files it is given; on tracked hub/public files that dirties the tree, and CI rejects a bundle that
// differs from a clean build (`git diff --exit-code hub/public`). So: the copy is injected, the checkout never is.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { tempDir, ROOT } from "./helpers.mjs";
import { SENTRY_ORG, stageSourcemaps } from "../scripts/sentry-sourcemaps.mjs";
import { buildSteps, hubBuildId } from "../scripts/ship.mjs";

const hasSentry = spawnSync("sentry", ["--version"], { windowsHide: true }).status === 0;
const bundle = (t, root) => {
  const pub = path.join(root, "hub", "public");
  mkdirSync(pub, { recursive: true });
  for (const n of ["board", "editor"]) {
    writeFileSync(path.join(pub, `${n}.js`), `console.log("${n}");\n//# sourceMappingURL=${n}.js.map\n`);
    writeFileSync(path.join(pub, `${n}.js.map`), JSON.stringify({ version: 3, sources: [`${n}.ts`], names: [], mappings: "AAAA", file: `${n}.js` }));
  }
  return pub;
};
/** Stand-in for `sentry sourcemap inject <dir>`: stamps every .js that has a .map, in whatever directory it is handed. */
const fakeInject = (dir) => { for (const f of readdirSync(dir)) if (f.endsWith(".js") && existsSync(path.join(dir, `${f}.map`))) appendFileSync(path.join(dir, f), "\n//# debugId=00000000-0000-4000-8000-000000000000\n"); };

describe("stageSourcemaps", () => {
  test("injects the staged hub/public and uploads each project's pair as release = version", (t) => {
    const d = tempDir("zevet-srcmap-"); t.after(() => d.cleanup());
    const stage = path.join(d.dir, "tree"), maps = path.join(d.dir, "maps");
    const pub = bundle(t, stage);
    const calls = [];
    stageSourcemaps({ stage, maps, version: "0.2.121", run: (cmd, args, o) => { calls.push({ cmd, args, env: o.env }); if (args[1] === "inject") fakeInject(args.at(-1)); } });
    assert.deepEqual(calls[0].args, ["sourcemap", "inject", "--ext", ".js", pub]);
    const uploads = calls.slice(1);
    assert.deepEqual(uploads.map((c) => c.env.SENTRY_PROJECT).sort(), ["electron", "zevet-hub"]);
    for (const u of uploads) {
      assert.equal(u.env.SENTRY_ORG, SENTRY_ORG);
      assert.equal(u.args[args2i(u, "--release") + 1], "0.2.121");
      assert.ok(path.resolve(u.args.at(-1)).startsWith(path.resolve(maps)), "uploads read the scratch pair, not the tree");
    }
    // the pair uploaded for a project is the injected one: bundle and map both carry what inject wrote
    assert.match(readFileSync(path.join(maps, "electron", "board.js"), "utf8"), /debugId=/);
  });
  test("refuses a git checkout", (t) => {
    const d = tempDir("zevet-srcmap-"); t.after(() => d.cleanup());
    bundle(t, d.dir); mkdirSync(path.join(d.dir, ".git"));
    assert.throws(() => stageSourcemaps({ stage: d.dir, maps: path.join(d.dir, "..", "m"), version: "1", run: () => assert.fail("must not run") }), /git checkout/);
  });
  test("the real Sentry CLI puts a debug ID in the staged bundle and its map", { skip: !hasSentry && "sentry CLI not installed" }, (t) => {
    const d = tempDir("zevet-srcmap-"); t.after(() => d.cleanup());
    const stage = path.join(d.dir, "tree"), pub = bundle(t, stage);
    const run = (cmd, args, o) => { if (args[1] === "upload") return; const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
    stageSourcemaps({ stage, maps: path.join(d.dir, "maps"), version: "0.2.121", run });
    for (const n of ["board", "editor"]) {
      assert.match(readFileSync(path.join(pub, `${n}.js`), "utf8"), /debugId=[0-9a-f-]{36}/);
      assert.match(readFileSync(path.join(pub, `${n}.js.map`), "utf8"), /"debug_id":"[0-9a-f-]{36}"/);
    }
  });
});
const args2i = (c, flag) => c.args.indexOf(flag);

describe("the hub step", () => {
  test("never modifies the tracked hub/public files, and ships injected copies of them", async (t) => {
    const d = tempDir("zevet-ship-hub-"); t.after(() => d.cleanup());
    const wt = path.join(d.dir, "wt"), work = path.join(d.dir, "work");
    mkdirSync(work, { recursive: true });
    const sentry = [], scp = [];
    const tar = (args, cwd = d.dir) => { const r = spawnSync("tar", args.map((a) => (path.isAbsolute(a) ? path.relative(cwd, a) : a)), { cwd, windowsHide: true }); assert.equal(r.status, 0, String(r.stderr)); };
    const io = {
      log() {}, sleep: async () => {},
      // the worktree: the real committed hub/public, extracted; `git archive` of it: a tar of that tree
      git(args, o = {}) {
        if (args[0] === "worktree" && args[1] === "list") return "";
        if (args[0] === "worktree" && args[1] === "add") {
          execFileSync("git", ["archive", "-o", path.join(d.dir, "head.tar"), "HEAD", "hub/public"], { cwd: ROOT });
          mkdirSync(args[3], { recursive: true }); tar(["-xf", path.join(d.dir, "head.tar"), "-C", args[3]]); return "";
        }
        if (args[0] === "archive") { tar(["-cf", args[args.indexOf("-o") + 1], "-C", o.cwd, "."]); return ""; }
        throw new Error(`fake git: ${args.join(" ")}`);
      },
      run(cmd, args, o = {}) {
        if (cmd === "npm") { mkdirSync(path.join(o.cwd, "node_modules"), { recursive: true }); return { stdout: "" }; }
        if (cmd === "tar") { tar(args, o.cwd); return { stdout: "" }; }
        assert.equal(cmd, "sentry");
        sentry.push({ args, env: o.env });
        if (args[1] === "inject") fakeInject(args.at(-1));
        return { stdout: "" };
      },
      scp: (a) => { scp.push(a); }, ssh: () => "",
      async https(url) {
        const body = url.endsWith("/healthz") ? { ok: true, rooms: 0, wsListeners: 0 } : { build: hubBuildId(wt) };
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
      },
    };
    const ctx = { io, root: ROOT, version: "0.2.121", tag: "v0.2.121", d: { kind: "payload", hub: true, base: "0.2.120", shell: [], hubFiles: ["board/src/a.tsx"] }, facts: {}, work, wt };
    await buildSteps(ctx).find((s) => s.name === "hub").run();

    const tracked = execFileSync("git", ["ls-files", "hub/public"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
    assert.ok(tracked.includes("hub/public/board.js") && tracked.includes("hub/public/editor.js"));
    for (const f of tracked) {
      const committed = execFileSync("git", ["show", `HEAD:${f}`], { cwd: ROOT, maxBuffer: 1 << 28 });
      assert.ok(readFileSync(path.join(wt, f)).equals(committed), `${f} was modified by ship`);
    }
    // what was packaged is the injected copy
    const out = path.join(d.dir, "out"); mkdirSync(out);
    tar(["-xzf", path.join(work, "zevet-0.2.121.tar.gz"), "-C", out]);
    for (const n of ["board", "editor"]) assert.match(readFileSync(path.join(out, "hub", "public", `${n}.js`), "utf8"), /debugId=/);
    assert.ok(sentry.some((c) => c.args[1] === "upload" && c.args[c.args.indexOf("--release") + 1] === "0.2.121"));
    assert.equal(sentry.filter((c) => c.args[1] === "upload").length, 2);
  });
});
