// desktop/ipc-table.js is the one place a bridge call is written down. It generates
// desktop/preload.js and board/src/lib/bridge.generated.d.ts, and main.js registers every
// handler through it. These tests are what makes "one table" true rather than a comment:
// a hand edit of a generated file, a call with no handler, a handler with no call, or a
// handler that is not behind the sender guard all fail here.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { tables } = require(path.join(ROOT, "desktop", "ipc-table.js"));
const kit = require(path.join(ROOT, "desktop", "node_modules", "@masora", "desktop-kit"));
const main = readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const calls = tables.flatMap((t) => Object.entries(t.calls).map(([name, c]) => ({ global: t.global, name, ...c })));
const events = tables.flatMap((t) => Object.entries(t.events).map(([name, e]) => ({ global: t.global, name, ...e })));

describe("the generated files are the table's output", () => {
  test("`ipc:check` passes: preload.js and bridge.generated.d.ts are what the table generates", () => {
    const r = spawnSync(process.execPath, [
      path.join(ROOT, "desktop", "node_modules", "@masora", "desktop-kit", "bin", "ipc-gen.js"),
      path.join(ROOT, "desktop", "ipc-table.js"),
      "--preload", path.join(ROOT, "desktop", "preload.js"),
      "--dts", path.join(ROOT, "board", "src", "lib", "bridge.generated.d.ts"),
      "--check",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, `a generated file is stale or hand-edited (run \`npm run ipc:gen\`):\n${r.stderr}`);
  });

  test("the table is not trivially small (a truncated table would pass every other check here)", () => {
    assert.ok(calls.length >= 90, `only ${calls.length} calls`);
    assert.ok(events.length >= 8, `only ${events.length} events`);
    assert.deepEqual(tables.map((t) => t.global), ["zevet", "zevetLocal", "zevetDoc"]);
  });
});

describe("every bridge method exists, and main handles exactly the table's channels", () => {
  test("the generated preload exposes every call and event of every table, and calls the table's channel", async () => {
    const invoked = [];
    const listened = [];
    const exposed = {};
    const electron = {
      contextBridge: { exposeInMainWorld: (n, api) => { exposed[n] = api; } },
      ipcRenderer: { invoke: (ch, ...a) => { invoked.push(ch); return Promise.resolve(); }, on: (ch) => listened.push(ch), removeListener() {} },
    };
    vm.runInNewContext(readFileSync(path.join(ROOT, "desktop", "preload.js"), "utf8"), { require: () => electron, Uint8Array });
    assert.deepEqual(Object.keys(exposed), ["zevet", "zevetLocal", "zevetDoc"]);
    for (const c of calls) {
      assert.equal(typeof exposed[c.global][c.name], "function", `window.${c.global}.${c.name} is missing`);
      invoked.length = 0;
      await exposed[c.global][c.name]("a", "b", "c", "d");
      assert.deepEqual(invoked, [c.channel], `${c.global}.${c.name} invokes the wrong channel`);
    }
    for (const e of events) {
      assert.equal(typeof exposed[e.global][e.name], "function", `window.${e.global}.${e.name} is missing`);
      listened.length = 0;
      exposed[e.global][e.name](() => {});
      assert.deepEqual(listened, [e.channel], `${e.global}.${e.name} listens on the wrong channel`);
    }
  });

  test("main.js registers every table call through bridge.handle, and nothing else through it or ipcMain", () => {
    const code = strip(main);
    const registered = [...code.matchAll(/^bridge\.handle\("([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual([...registered].sort(), calls.map((c) => c.channel).sort(), "main and the table disagree about the bridge's channels");
    assert.equal(new Set(registered).size, registered.length, "a channel is registered twice");
    assert.doesNotMatch(code, /ipcMain\.handle\(/, "a handler bypasses the table (and its completeness check)");
    assert.match(code, /createIpcRegistry\(ipcMain, require\("\.\/ipc-table\.js"\)\.tables\)/);
    assert.ok(code.indexOf("bridge.assertComplete();") > code.lastIndexOf("bridge.handle("), "assertComplete must come after the last handler");
  });

  test("the packaged app ships the table (main.js requires it at startup)", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "desktop", "package.json"), "utf8"));
    assert.ok(pkg.build.files.includes("ipc-table.js"));
  });
});

describe("a table channel is behind the sender guard", () => {
  test("registered through the registry after guardIpc, a foreign sender is refused and the hub's is served", async () => {
    const { guardIpc } = require(path.join(ROOT, "desktop", "ipc-guard.js"));
    const handlers = {};
    const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
    guardIpc(ipcMain, () => "https://hub.example");
    const registry = kit.createIpcRegistry(ipcMain, tables);
    const channel = calls.find((c) => c.name === "config").channel;
    registry.handle(channel, () => "served");
    assert.equal(await handlers[channel]({ senderFrame: { url: "https://hub.example/board" } }), "served");
    assert.throws(() => handlers[channel]({ senderFrame: { url: "https://evil.example/" } }), /sender not allowed/);
    assert.throws(() => registry.handle("not:in-the-table", () => 1), /not in the IPC table/);
    assert.throws(() => registry.assertComplete(), /never handled/);
  });
});

describe("board/src/lib/bridge.ts takes its bridge types from the generated file", () => {
  test("LocalBridge and ZevetBridge are re-exported, not written by hand", () => {
    const bridgeTs = strip(readFileSync(path.join(ROOT, "board", "src", "lib", "bridge.ts"), "utf8"));
    assert.match(bridgeTs, /from "\.\/bridge\.generated"/);
    assert.doesNotMatch(bridgeTs, /interface (LocalBridge|ZevetBridge)\b/);
    const dts = readFileSync(path.join(ROOT, "board", "src", "lib", "bridge.generated.d.ts"), "utf8");
    for (const iface of ["LocalBridge", "ZevetBridge"]) assert.match(dts, new RegExp(`export interface ${iface} \\{`));
  });
});
