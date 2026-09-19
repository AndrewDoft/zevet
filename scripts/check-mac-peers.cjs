"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { spawn, execFileSync } = require("node:child_process");
const { randomBytes, createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.resolve(process.argv[2]);
const systemNode = process.argv[3];
const resources = process.resourcesPath;
const req = createRequire(path.join(resources, "app.asar/package.json"));
const runtime = req("./runtime.js");
const { DocSync } = req("./doc-sync.js");
const { FileWatch } = req("./file-watch.js");
const localFs = req("./local-fs.js");
const agentConsole = req("./agent-console.js");
const secrets = require(path.join(resources, "client/secret.mjs"));
const docCrypto = require(path.join(resources, "client/doc-crypto.mjs"));
const pkg = req("./package.json");
assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8")).version);
assert.equal(process.arch, "arm64");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-mac-peers-"));
const peers = [];
const consoles = [];
const originalPath = process.env.PATH;
let hub;
let spy;
let hubLog = "";
let hubError = "";

async function until(check, label, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}

function loadEditor() {
  const node = () => new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "style") return {};
      if (prop === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "[stub]";
      return node();
    },
    set: () => true,
    apply: () => node(),
  });
  const context = {
    document: {
      createElement: node, createElementNS: node, createTextNode: node, createRange: node,
      documentElement: node(), head: node(), body: node(), addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
    },
    crypto: globalThis.crypto,
    navigator: { userAgent: "node", platform: "MacIntel", maxTouchPoints: 0, language: "en" },
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, TextEncoder, TextDecoder,
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(fs.readFileSync(path.join(root, "hub/public/editor.js"), "utf8"), { filename: "editor.js" }).runInContext(context);
  return context.zevetEditor;
}

const E = loadEditor();
const secret = randomBytes(24).toString("hex");
const token = secrets.deriveAuthToken(secret);
const room = "probe:source.txt";
const tagged = (kind, bytes) => Uint8Array.from([kind, ...bytes]);
const frames = [];
let base;

function machine(name) {
  const dir = path.join(fixture, name + " workspace");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "source.txt"), "");
  const doc = new E.Y.Doc();
  const text = doc.getText("content");
  const awareness = new E.Awareness(doc);
  const state = { name, dir, doc, text, awareness, ready: false, diskEvents: 0, statuses: [] };
  const save = () => {
    const result = localFs.writeTextFile(dir, "source.txt", text.toString(), { eol: "lf", bom: false });
    assert.equal(result.ok, true, result.error);
  };
  const sync = new DocSync({ hub: base, secret,
    onEvent(_room, event) {
      if (event.kind === "ready") state.ready = true;
      if (event.kind === "update") {
        const data = new Uint8Array(event.bytes);
        if (data[0] === 1) E.awarenessProtocol.applyAwarenessUpdate(awareness, data.subarray(1), "remote");
        else E.Y.applyUpdate(doc, data.subarray(1), "remote");
      }
    },
    onStatus(_room, status, detail) { state.statuses.push({ status, detail }); },
  });
  doc.on("update", (update, origin) => {
    save();
    if (origin !== "remote") sync.send(room, tagged(0, update));
  });
  awareness.on("update", (changes, origin) => {
    if (origin === "remote") return;
    const changed = changes.added.concat(changes.updated, changes.removed);
    if (changed.length) sync.send(room, tagged(1, E.awarenessProtocol.encodeAwarenessUpdate(awareness, changed)));
  });
  const watch = new FileWatch({ onChange(event) {
    state.diskEvents++;
    if (event.text === text.toString()) return;
    doc.transact(() => { text.delete(0, text.length); text.insert(0, event.text); }, "disk");
  } });
  assert.equal(watch.watch(dir, "source.txt").ok, true);
  sync.join(room);
  Object.assign(state, { sync, watch });
  peers.push(state);
  return state;
}

async function main() {
  console.log(`Packaged runtime: zevet ${pkg.version}, Electron ${process.versions.electron}, Node ${process.version}, ${process.platform}/${process.arch}`);
  console.log(`App archive SHA-256: ${createHash("sha256").update(require("original-fs").readFileSync(path.join(resources, "app.asar"))).digest("hex")}`);
  hub = spawn(systemNode, [path.join(root, "hub/server.mjs")], {
    env: { ...process.env, PORT: "0", ZEVET_SECRET: secret, ZEVET_TOKEN: token,
      ZEVET_ACCOUNTS: path.join(fixture, "accounts.json"), ZEVET_GITHUB_CLIENT_ID: "", ZEVET_HOME: path.join(fixture, "zevet") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hub.stdout.on("data", (data) => { hubLog += data; });
  hub.stderr.on("data", (data) => { hubError += data; });
  await until(() => /listening on http:\/\/127\.0\.0\.1:(\d+)/.test(hubLog), `local hub startup (${hubError})`);
  base = "http://127.0.0.1:" + hubLog.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)[1];
  spy = new WebSocket(base.replace("http:", "ws:") + "/ws?token=" + encodeURIComponent(token));
  spy.binaryType = "arraybuffer";
  spy.addEventListener("message", (event) => { if (typeof event.data !== "string") frames.push(Buffer.from(event.data)); });
  await new Promise((resolve, reject) => {
    spy.addEventListener("open", () => { spy.send(JSON.stringify({ type: "join", room })); resolve(); });
    spy.addEventListener("error", reject);
  });
  const a = machine("peer A");
  const b = machine("peer B");
  await until(() => a.ready && b.ready, "two peers join");

  const initial = "private source — initial content\n";
  a.text.insert(0, initial);
  await until(() => b.text.toString() === initial && fs.readFileSync(path.join(b.dir, "source.txt"), "utf8") === initial, "peer A edit reaches peer B disk");
  a.awareness.setLocalStateField("user", { name: "peer A", color: "#123456" });
  await until(() => [...b.awareness.getStates().values()].some((state) => state.user?.name === "peer A"), "peer awareness");
  console.log("PASS: bundled Yjs edit and awareness -> packaged DocSync -> real local hub -> peer B document and file");

  a.text.insert(a.text.length, "A concurrent edit\n");
  b.text.insert(b.text.length, "B concurrent edit\n");
  await until(() => a.text.toString() === b.text.toString() && a.text.toString().includes("A concurrent edit") && a.text.toString().includes("B concurrent edit"), "concurrent edits converge");
  assert.equal(fs.readFileSync(path.join(a.dir, "source.txt"), "utf8"), fs.readFileSync(path.join(b.dir, "source.txt"), "utf8"));
  console.log("PASS: concurrent edits converge in both CRDTs and both files");

  const shellDir = path.join(fixture, "isolated-shell");
  const binDir = path.join(fixture, "Node and agent with spaces", "bin");
  fs.mkdirSync(shellDir);
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(systemNode, path.join(binDir, "node"));
  fs.writeFileSync(path.join(shellDir, ".zshrc"), `export PATH=${JSON.stringify(binDir)}:$PATH\nprintf 'isolated profile banner\\n'\n`);
  const fakeAgent = path.join(binDir, "codex");
  fs.writeFileSync(fakeAgent, '#!/usr/bin/env node\nconst fs = require("node:fs"); let prompt=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", x => prompt += x); process.stdin.on("end", () => { fs.writeFileSync("source.txt", prompt); console.log(JSON.stringify({type:"probe.done",prompt,argv:process.argv.slice(2),cwd:process.cwd()})); });\n', { mode: 0o755 });
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", ZDOTDIR: shellDir };
  assert.throws(() => execFileSync(fakeAgent, [], { env, input: "", stdio: "pipe", cwd: a.dir }), "minimal Finder PATH must reproduce env-node failure");
  await runtime.preparePath({ env, home: shellDir });
  process.env.PATH = env.PATH;
  assert.equal(agentConsole.resolveAgent("codex").file, fakeAgent);
  const events = [];
  const consoleHandle = agentConsole.startConsole({ agent: "codex", cwd: a.dir, onEvent: (event) => events.push(event) });
  assert.equal(consoleHandle.ok, true, consoleHandle.error);
  consoles.push(consoleHandle);
  const agentEdit = "Agent edit: \"quoted\" $HOME `literal` — Unicode\n";
  assert.equal(consoleHandle.send(agentEdit).ok, true);
  await until(() => events.some((event) => event.type === "exit"), "actual agent process exits");
  const exit = events.find((event) => event.type === "exit");
  assert.equal(exit.code, 0, JSON.stringify(events));
  const received = events.find((event) => event.type === "agent" && event.payload.type === "probe.done")?.payload;
  assert.equal(received?.prompt, agentEdit);
  assert.ok(!received.argv.includes(agentEdit), "the prompt belongs on stdin");
  assert.equal(fs.realpathSync(received.cwd), fs.realpathSync(a.dir));
  await until(() => a.text.toString() === agentEdit && b.text.toString() === agentEdit && fs.readFileSync(path.join(b.dir, "source.txt"), "utf8") === agentEdit, "agent write -> FileWatch -> encrypted sync -> peer B file");
  assert.ok(a.diskEvents > 0);
  console.log("PASS: restored Finder PATH launches actual env-node process; stdin preserves quoted Unicode prompt");
  console.log("PASS: actual agent disk edit -> packaged FileWatch -> encrypted DocSync -> peer B CRDT and file");

  await until(() => frames.length > 0, "relay ciphertext observer");
  assert.ok(frames.every((frame) => !frame.includes(Buffer.from("private source")) && !frame.includes(Buffer.from("Agent edit:"))), "relay traffic must not contain plaintext source");
  const key = secrets.deriveDocKey(secret);
  const opened = frames.map((frame) => Buffer.from(docCrypto.open(key, room, frame)));
  assert.ok(opened.some((frame) => frame.includes(Buffer.from("Agent edit:"))), "authorized decryption recovers agent update");
  assert.throws(() => docCrypto.open(key, "probe:other.txt", frames.at(-1)), "room authentication must reject cross-room replay");
  console.log(`PASS: ${frames.length} observed relay frames contain ciphertext; authorized key decrypts and wrong-room replay fails`);

  a.sync.send(room, tagged(0, E.Y.encodeStateAsUpdate(a.doc)), { snapshot: true });
  await delay(100);
  const c = machine("late peer");
  await until(() => c.ready && c.text.toString() === agentEdit && fs.readFileSync(path.join(c.dir, "source.txt"), "utf8") === agentEdit, "late peer replay");
  console.log("PASS: late peer restores snapshot to its document and file");
  console.log("Scope: local hub and temporary files; actual packaged Electron modules and committed Yjs bundle. No renderer UI, vendor login, second computer, or external network tested. In 0.2.1 the hub holds the master secret; this verifies transport encryption, not secrecy from the hub.");
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  process.env.PATH = originalPath;
  for (const handle of consoles) handle.stop();
  for (const peer of peers) { peer.watch.closeAll(); peer.awareness.destroy(); peer.sync.destroy(); peer.doc.destroy(); }
  if (spy) spy.close();
  if (hub && hub.exitCode === null) { hub.kill("SIGTERM"); await Promise.race([new Promise((resolve) => hub.once("exit", resolve)), delay(2000)]); }
  fs.rmSync(fixture, { recursive: true, force: true });
});
