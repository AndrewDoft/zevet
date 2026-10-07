// "Comment on this turn" must render wherever the conversation does (D-078).
// It used to live in TurnDetail, which only renders while NO file is selected,
// while the button needs an open file's comment room: it could never appear.
// Rendered through vite SSR like claims-ui.test.mjs; no jsdom in this repo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

// board.ts reads window/localStorage at import; a bare stub is enough to load it.
const store_ = new Map();
globalThis.window = globalThis;
globalThis.localStorage = { getItem: (k) => store_.get(k) ?? null, setItem: (k, v) => store_.set(k, String(v)), removeItem: (k) => store_.delete(k) };
globalThis.document = { body: { dataset: {} }, documentElement: { dataset: {}, style: {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
let vite, render, mod, presence, Y;
before(async () => {
  const BOARD = realpathSync.native(path.join(ROOT, "board"));
  const boardReq = createRequire(path.join(BOARD, "package.json"));
  ({ createServer: vite } = await import(pathToFileURL(boardReq.resolve("vite")).href));
  vite = await vite({
    configFile: path.join(BOARD, "vite.config.ts"),
    root: BOARD,
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "lucide-react": path.join(ROOT, "test", "author-color.lucide-stub.mjs") } },
  });
  const React = boardReq("react");
  const { renderToStaticMarkup } = boardReq("react-dom/server");
  mod = await vite.ssrLoadModule("/src/components/turndetail.tsx");
  presence = await vite.ssrLoadModule("/src/lib/presence-session.ts");
  Y = createRequire(path.join(ROOT, "editor", "package.json"))("yjs");
  render = (C, props) => renderToStaticMarkup(React.createElement(C, props));
});
after(async () => {
  presence?.detach();
  if (vite) await vite.close();
});

const openRoom = () =>
  presence.attachPresence({
    E: { Y, Awareness: class {}, awarenessProtocol: {} },
    ydoc: new Y.Doc(),
    awareness: {},
    room: "r1",
    relPath: "src/a.js",
    handle: { view: null },
    getText: () => "",
    sendAwareness: () => {},
    colorOf: () => "#000",
    me: () => "me",
  });

test("a turn comment button renders next to the conversation once a room is open, and not before", async () => {
  const c = { key: "c1", agent: "claude", sessionId: "s1", transcript: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } };
  assert.equal(render(mod.TurnCommentButton, { active: c }), "", "no room, no button");
  openRoom();
  await new Promise((r) => setTimeout(r, 10)); // refresh() publishes the room on a microtask
  assert.match(render(mod.TurnCommentButton, { active: c }), /Comment on this turn/);
});

test("it is mounted by the conversation card, not only by the file-less TurnDetail", () => {
  const src = readFileSync(path.join(ROOT, "board", "src", "components", "conversation.tsx"), "utf8");
  assert.match(src, /<TurnCommentButton active=\{active\} \/>/);
  const td = readFileSync(path.join(ROOT, "board", "src", "components", "turndetail.tsx"), "utf8");
  assert.equal(td.split('<AnchorButton label="Comment on this turn"').length - 1, 1);
  assert.ok(td.indexOf('<AnchorButton label="Comment on this turn"') > td.indexOf("export function TurnCommentButton"));
});
