// The four extension seams (docs/extending.md): mods, ipc fragments, mcp tools, board ext.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const DESKTOP = path.join(ROOT, "desktop");
const KIT = path.join(DESKTOP, "node_modules", "@masora", "desktop-kit");
const { loadMods } = require("../desktop/mods-loader.js");
const { withFragments, assertFragmentTargets } = require("../desktop/ipc-fragments.js");
const { loadModTools } = require("../desktop/mod-tools.js");
const silent = { error() {}, warn() {}, log() {} };
const tick = () => new Promise((r) => setImmediate(r));

let tmp;
const put = (rel, body) => {
  mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  writeFileSync(path.join(tmp, rel), body);
  return path.join(tmp, path.dirname(rel));
};
before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "zevet-seams-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("mods loader", () => {
  test("loads a fixture mod, starts it with the context, and calls its before-quit hook", async () => {
    const dir = put("mods1/fixture.js", 'module.exports = { name: "fixture", start(ctx) { ctx.events.push("start"); }, beforeQuit(ctx) { ctx.events.push("quit"); } };');
    put("mods1/second/index.js", 'module.exports = (ctx) => ctx.events.push("second-start");');
    put("mods1/tools/index.js", 'throw new Error("tools/ is not a mod");');
    put("mods1/README.md", "not a mod");
    const ctx = { events: [] };
    const mods = loadMods(ctx, { dir, log: silent });
    assert.deepEqual(mods.names, ["fixture", "second"]);
    await tick();
    assert.deepEqual(ctx.events, ["start", "second-start"]);
    mods.beforeQuit();
    assert.deepEqual(ctx.events, ["start", "second-start", "quit"]);
  });

  test("a mod that throws is skipped and the rest still load and quit", async () => {
    const dir = put("mods2/a-bad.js", 'throw new Error("boom");');
    put("mods2/b-bad-start.js", 'module.exports = { start() { throw new Error("start boom"); }, beforeQuit() { throw new Error("quit boom"); } };');
    put("mods2/c-empty.js", "module.exports = {};");
    put("mods2/d-good.js", 'module.exports = { beforeQuit(ctx) { ctx.events.push("quit"); } };');
    const ctx = { events: [] };
    const errors = [];
    const mods = loadMods(ctx, { dir, log: { error: (m) => errors.push(m) } });
    await tick();
    assert.deepEqual(mods.names, ["b-bad-start", "d-good"]);
    assert.equal(errors.length, 3, "a-bad (load), c-empty (load), b-bad-start (start)");
    mods.beforeQuit();
    await tick();
    assert.deepEqual(ctx.events, ["quit"]);
    assert.equal(errors.length, 4, "b-bad-start's beforeQuit throw is logged too");
  });

  test("a missing mods dir is no mods, not an error", () => {
    assert.deepEqual(loadMods({}, { dir: path.join(tmp, "nope"), log: silent }).names, []);
  });

  test("main.js wires it before the IPC completeness check, and the payload ships it", () => {
    const main = readFileSync(path.join(DESKTOP, "main.js"), "utf8");
    assert.ok(main.indexOf("loadMods(") > 0 && main.indexOf("loadMods(") < main.indexOf("bridge.assertComplete();"));
    assert.match(main, /app\.on\("before-quit", \(\) => mods\.beforeQuit\(\)\)/);
    const files = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8")).payload.files;
    for (const f of ["mods-loader.js", "mod-tools.js", "ipc-fragments.js", "mods/**", "ipc/**"]) assert.ok(files.includes(f), f);
    for (const d of ["mods", "mods/tools", "ipc"]) assert.ok(existsSync(path.join(DESKTOP, d, "README.md")), `${d}/ must exist or payload staging fails`);
  });
});

describe("ipc fragments", () => {
  const spec = () => ({ global: "g", calls: { a: { channel: "g:a", params: [], returns: "Promise<void>", doc: "a" } }, events: {} });
  const frag = (over) => [{ file: "f.js", table: "zevet", calls: { b: { channel: "g:b", params: [], returns: "Promise<void>", doc: "b" } }, ...over }];

  test("merges a fragment's calls into its table and leaves other tables alone", () => {
    assert.deepEqual(Object.keys(withFragments("zevet", spec(), "", frag()).calls), ["a", "b"]);
    assert.deepEqual(Object.keys(withFragments("zevetDoc", spec(), "", frag()).calls), ["a"]);
  });

  test("a clashing name or an unknown table throws", () => {
    assert.throws(() => withFragments("zevet", spec(), "", frag({ calls: { a: {} } })), /already defined/);
    assert.throws(() => assertFragmentTargets(["zevet"], "", frag({ table: "typo" })), /not one of/);
  });

  test("ipc:gen --check is green with a fragment-only channel, and red when the output is stale", () => {
    const dir = path.join(tmp, "gen");
    put("gen/ipc/mine.js", 'module.exports = { table: "zevet", calls: { mine: { channel: "zevet:mine", params: [], returns: "Promise<number>", doc: "A fragment-only call." } } };');
    const tableFile = path.join(dir, "table.js");
    writeFileSync(
      tableFile,
      [
        `const { defineIpc } = require(${JSON.stringify(KIT)});`,
        `const { withFragments } = require(${JSON.stringify(path.join(DESKTOP, "ipc-fragments.js"))});`,
        `const z = defineIpc(withFragments("zevet", { global: "zevet", typeName: "Z", calls: {} }, ${JSON.stringify(path.join(dir, "ipc"))}));`,
        "module.exports = { tables: [z] };",
      ].join("\n"),
    );
    const args = [path.join(KIT, "bin", "ipc-gen.js"), tableFile, "--preload", path.join(dir, "preload.js"), "--dts", path.join(dir, "bridge.d.ts")];
    execFileSync(process.execPath, args, { stdio: "pipe" });
    assert.match(readFileSync(path.join(dir, "preload.js"), "utf8"), /zevet:mine/);
    assert.equal(spawnSync(process.execPath, [...args, "--check"], { stdio: "pipe" }).status, 0);
    writeFileSync(path.join(dir, "preload.js"), readFileSync(path.join(dir, "preload.js"), "utf8") + "// hand edit\n");
    assert.equal(spawnSync(process.execPath, [...args, "--check"], { stdio: "pipe" }).status, 1);
  });

  test("the real table loads with its three tables", () => {
    assert.equal(require("../desktop/ipc-table.js").tables.length, 3);
  });
});

describe("mcp tool registry", () => {
  const good = 'module.exports = { name: "fixture_tool", description: "d", inputSchema: { type: "object", properties: {} }, run: async (a, ctx, deps) => ({ text: "ran " + deps.who }) };';

  test("loads valid tools and skips malformed, duplicate and reserved ones", () => {
    const dir = put("tools1/a.js", good);
    put("tools1/b-dup.js", good);
    put("tools1/c-reserved.js", good.replace("fixture_tool", "claim_step"));
    put("tools1/d-noschema.js", 'module.exports = { name: "x_y", description: "d", run() {} };');
    put("tools1/e-badname.js", good.replace("fixture_tool", "Bad-Name"));
    put("tools1/f-throws.js", "throw new Error('x');");
    const warns = [];
    const tools = loadModTools({ dir, reserved: ["claim_step"], log: { warn: (m) => warns.push(m) } });
    assert.deepEqual(tools.map((t) => t.name), ["fixture_tool"]);
    assert.equal(warns.length, 5);
  });

  test("a fixture tool appears in tools/list and is run by agent-tools", () => {
    const file = path.join(DESKTOP, "mods", "tools", "zz-fixture-test.js");
    writeFileSync(file, good.replace("fixture_tool", "zz_fixture_tool"));
    // Fresh child processes: both modules read the registry once, when they load.
    const list = (team) =>
      spawnSync(process.execPath, ["-e", 'require("./zevet-mcp.js").handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });'], {
        cwd: DESKTOP,
        env: { ...process.env, ZEVET_MCP_TEAM: team },
        encoding: "utf8",
      }).stdout.trim();
    try {
      const withTeam = JSON.parse(list("1")).result.tools;
      assert.ok(withTeam.some((t) => t.name === "zz_fixture_tool"), "listed when signed in to a team");
      assert.ok(withTeam.some((t) => t.name === "claim_step"));
      assert.deepEqual(Object.keys(withTeam.find((t) => t.name === "zz_fixture_tool")).sort(), ["description", "inputSchema", "name"], "no run or scope leaks");
      assert.ok(!JSON.parse(list("0")).result.tools.some((t) => t.name === "zz_fixture_tool"), "team-scoped: hidden without a team");

      const run = spawnSync(
        process.execPath,
        ["-e", 'require("./agent-tools.js").createAgentTools({ who: "deps-ok" }).call("zz_fixture_tool", {}, {}).then((r) => console.log(JSON.stringify(r)));'],
        { cwd: DESKTOP, encoding: "utf8" },
      );
      assert.deepEqual(JSON.parse(run.stdout.trim()), { text: "ran deps-ok", isError: false });
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("board ext registry", () => {
  test("orders by order then id, defaults to the overlay slot, drops bad modules", async () => {
    const { collectExt } = await import("../board/src/ext/registry.mjs");
    const C = () => null;
    const got = collectExt({
      "./ext/z.tsx": { default: C },
      "./ext/a.tsx": { default: C, slot: "rail", order: 5 },
      "./ext/b.tsx": { default: C, order: -1 },
      "./ext/bad-slot.tsx": { default: C, slot: "nowhere" },
      "./ext/not-a-component.tsx": { default: 3 },
      "./ext/empty.tsx": null,
    });
    assert.deepEqual(got.map((e) => [e.id, e.slot]), [["./ext/b.tsx", "overlay"], ["./ext/z.tsx", "overlay"], ["./ext/a.tsx", "rail"]]);
    assert.deepEqual(collectExt(undefined), []);
  });

  test("App.tsx renders both slots from the ext glob", () => {
    const app = readFileSync(path.join(ROOT, "board/src/App.tsx"), "utf8");
    assert.match(app, /import\.meta\.glob\("\.\/ext\/\*\.tsx", \{ eager: true \}\)/);
    assert.match(app, /<ExtSlot slot="rail" \/>/);
    assert.match(app, /<ExtSlot slot="overlay" \/>/);
  });
});
