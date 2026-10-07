// The board half of advisory claims and the overlap gate (D-070). No jsdom in
// this repo, so the components are rendered to markup through vite's SSR (same
// as author-color.test.mjs) and the wiring is pinned from source.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";
import { chipText, claimOfPath, repoNameOf, claimedBySession, gateSend, hitLine, pathsIn } from "../board/src/lib/claims.mjs";

const src = (...rel) => readFileSync(path.join(ROOT, ...rel), "utf8");

let vite;
let render;
let mod;
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
  mod = { React, ...(await vite.ssrLoadModule("/src/components/claims.tsx")) };
  render = (C, props) => renderToStaticMarkup(React.createElement(C, props));
});
after(async () => {
  if (vite) await vite.close();
});

describe("the chip on a session's card", () => {
  test("one file: its name. Several: a count. None: nothing", () => {
    assert.match(render(mod.ClaimChip, { paths: ["src/db.ts"] }), />claimed: db\.ts</);
    assert.match(render(mod.ClaimChip, { paths: ["a.ts", "b.ts", "c.ts"] }), />claimed: 3 files</);
    assert.equal(render(mod.ClaimChip, { paths: [] }), "");
    assert.equal(chipText(["x/y/z.ts"]), "z.ts");
  });
  test("the hover lists every path", () => {
    assert.match(render(mod.ClaimChip, { paths: ["a.ts", "b.ts"] }), /title="a\.ts\nb\.ts"/);
  });
  test("both kinds of card carry it: a teammate's by its session, mine by its console's", () => {
    const people = src("board", "src", "components", "people.tsx");
    assert.match(people, /<SessionClaimChip session=\{a\.session\}/);
    assert.match(people, /<SessionClaimChip session=\{c\?\.sessionId\}/);
  });
  test("a session's claims are only that session's", () => {
    const claims = [
      { actor: "Kai", session: "s1", repo: "r", paths: ["a.ts"] },
      { actor: "Kai", session: "s2", repo: "r", paths: ["b.ts"] },
    ];
    assert.deepEqual(claimedBySession(claims, "s1"), ["a.ts"]);
    assert.deepEqual(claimedBySession(claims, ""), []);
  });
});

describe("the marker in the file tree", () => {
  test("a dot in the claimer's colour, their name on hover", () => {
    const html = render(mod.ClaimMark, { actor: "Kai", colour: "var(--who-2)" });
    assert.match(html, /class="claim-mark"/);
    assert.match(html, /--who:var\(--who-2\)/);
    assert.match(html, /title="Kai · claimed"/);
  });
  test("a file row shows it only for a claimed file, and uses the team colours", () => {
    const tree = src("board", "src", "components", "tree.tsx");
    assert.match(tree, /claim \? <ClaimMark actor=\{claim\.actor\} colour=\{hueOf\(claim\.mine \? myActor : claim\.actor\)\}/);
    assert.match(tree, /claimOfPath\(s\.claims, path, repo\)/);
  });
  test("claimed in this repo only, by path", () => {
    const claims = [{ actor: "Kai", session: "s", repo: "zevet", paths: ["src/db.ts"] }];
    assert.equal(claimOfPath(claims, "src/db.ts", "zevet").actor, "Kai");
    assert.equal(claimOfPath(claims, "src/db.ts", "other"), null);
    assert.equal(claimOfPath(claims, "src/other.ts", "zevet"), null);
  });
  test("right-click offers Claim, or Release on my own claim, on files and not folders", () => {
    assert.match(render(mod.ClaimMenu, { x: 1, y: 2, mine: false, onPick() {}, onClose() {} }), />Claim</);
    assert.match(render(mod.ClaimMenu, { x: 1, y: 2, mine: true, onPick() {}, onClose() {} }), />Release</);
    const tree = src("board", "src", "components", "tree.tsx");
    assert.match(tree, /onContextMenu=\{!isDir && localRoot/);
    assert.match(tree, /releasePath\(claim\.session, path\) : claimPaths\(localRoot, \[path\], session\)/);
  });
});

describe("the composer's overlap gate", () => {
  test("no hits sends untouched; Send anyway sends; Cancel and anything else do not", async () => {
    const hits = [{ actor: "Kai", session: "s", label: "overlapping" }];
    let asked = 0;
    const ask = (answer) => async () => (asked++, answer);
    assert.equal(await gateSend(async () => [], ask("cancel")), true);
    assert.equal(asked, 0, "nobody is asked when nothing overlaps");
    assert.equal(await gateSend(async () => hits, ask("send")), true);
    assert.equal(await gateSend(async () => hits, ask("cancel")), false);
    assert.equal(await gateSend(async () => hits, ask(undefined)), false, "never sends unasked");
  });
  test("the notice names the teammate and session, and offers exactly Send anyway / Cancel", () => {
    const html = render(mod.OverlapNoticeView, { hits: [{ actor: "Kai", session: "sess-kai-123", label: "overlapping" }], onSend() {}, onCancel() {} });
    assert.match(html, /overlapping · Kai · sess-kai/);
    assert.match(html, />Send anyway</);
    assert.match(html, />Cancel</);
    assert.equal(hitLine({ label: "adjacent", actor: "Mina", session: "" }), "adjacent · Mina");
  });
  test("it sits in the composer, above the input", () => {
    const aui = src("board", "src", "components", "assistant-ui", "elements", "thread.aui.tsx");
    assert.ok(aui.indexOf("<OverlapNotice />") > 0 && aui.indexOf("<OverlapNotice />") < aui.indexOf("<ComposerPrimitive.Input"));
  });
  test("it gates onNew AND the queue (which preempts onNew), and skips steers and slash commands", () => {
    const rt = src("board", "src", "lib", "runtime.tsx");
    assert.match(rt, /if \(!\(await gateRef\.current\(text\)\)\) return;/);
    assert.match(rt, /for \(const name of \["enqueue", "steer"\] as const\)/);
    assert.match(rt, /if \(reading \|\| steering \|\| parseLocal\(text, active\?\.agent \?\? launchAgent\)\) return true;/);
    // Cancel hands the text back rather than losing it.
    assert.match(rt, /if \(!ok\) back\(\);/);
  });
  test("the agent in front claims the files its prompt names, only with a session", () => {
    const rt = src("board", "src", "lib", "runtime.tsx");
    assert.match(rt, /if \(active\.sessionId && localRoot && planned\.length\) void claimPaths\(localRoot, planned, active\.sessionId, true\)/);
  });
});

describe("the repo a claim belongs to", () => {
  test("the folder name, on a Windows or a POSIX path", () => {
    assert.equal(repoNameOf("C:\\dev\\GitHub\\zevet"), "zevet");
    assert.equal(repoNameOf("/home/a/zevet/"), "zevet");
    assert.equal(repoNameOf(null), "");
  });
});

describe("path words in a prompt", () => {
  test("files and paths, not URLs, versions or prose", () => {
    assert.deepEqual(pathsIn("fix src/db.ts and README.md, then look at ./lib/a/b.mjs."), ["src/db.ts", "README.md", "lib/a/b.mjs"]);
    assert.deepEqual(pathsIn("see https://example.com/a/b.html and v1.2 plus e.g. this"), []);
  });
});
