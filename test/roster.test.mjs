// The merged roster: presence, follow-mode, marks, and pane widths.
//
// The roster used to be executed slices of hub/public/index.html against a
// fake DOM. The board is now a bundled React app, so the pure logic lives in
// board/src/lib/roster.mjs — plain JavaScript that the components import —
// and this test runs that exact file. Where behaviour is wired into store
// actions or components (toggleSelection, rendering, persistence) the test
// pins the wiring contract in source instead; the calculation is tested, the
// plumbing is checked for the typo that would silently break it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const {
  AGENT_MARKS,
  clampPaneWidth,
  followAllows,
  lastToolFor,
  liveActorsOf,
  newestHunk,
  spritesByPath,
  turnSummary,
  agoText,
} = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "roster.mjs")).href);

const NOW = 1_000_000;
const ev = (over) => ({
  ts: NOW - 1000, actor: "andrew", kind: "tool", tool: "Edit",
  target: "src/db.ts", detail: "", repo: "zevet", branch: "main", agent: "claude-code",
  ...over,
});

const src = (file) => readFileSync(path.join(ROOT, "board", "src", file), "utf8");

describe("turn summary", () => {
  test("mission is the prompt, terminal-title short; current is the latest tool", () => {
    const events = [
      ev({ kind: "prompt", detail: "migrate the auth table to sessions, keeping every existing test green along the way" }),
      ev({ tool: "Read", target: "src/auth.ts" }),
      ev({ tool: "Bash", target: null, detail: "npm test" }),
    ];
    const { mission, current } = turnSummary({ actor: "andrew" }, events);
    assert.ok(mission.length <= 80);
    assert.match(mission, /migrate the auth table/);
    assert.equal(current, "Bash  npm test");
  });

  test("a quiet person has no mission and no current command", () => {
    const end = ev({ actor: "kai", kind: "turn_end" });
    const { mission, current } = turnSummary({ actor: "kai" }, [end]);
    assert.equal(mission, "");
    assert.equal(current, "turn finished");
  });
});

describe("agent marks", () => {
  test("known agents get their mark, unknown agents the bead", () => {
    for (const agent of ["claude-code", "codex", "opencode"]) {
      const mark = AGENT_MARKS[agent];
      assert.ok(mark, `${agent} lost its mark`);
      assert.ok(mark.includes("<svg"), `${agent} produced an empty mark`);
    }
    assert.equal(AGENT_MARKS["something-new"], undefined, "unknown agents must fall through to the bead");
    const marks = src("components/marks.tsx");
    assert.ok(marks.includes('?? <span className="bead" />'), "the bead fallback is gone");
  });

  test("marks carry inline SVG and are picked only from the fixed map", () => {
    for (const mark of Object.values(AGENT_MARKS)) {
      assert.ok(mark.includes("<svg"), "no inline svg in the mark");
      assert.ok(mark.includes("viewBox"), "mark is not a scaled vector");
    }
    // A mark is chosen by indexing a constant map with the agent name, so a
    // name that is not in the map — however it got into the event stream —
    // can never become markup.
    assert.equal(AGENT_MARKS['<img src=x onerror="alert(1)">'], undefined);
    const marks = src("components/marks.tsx");
    assert.ok(marks.includes("AGENT_MARKS[agent]"), "marks must be looked up in the constant map");
    assert.ok(marks.includes('?? <span className="bead" />'), "the bead fallback is gone");
  });
});

describe("follow mode", () => {
  test("mine follows your own agent and ignores everyone else", () => {
    assert.equal(followAllows("mine", "andrew", "andrew"), true);
    assert.equal(followAllows("mine", "kai", "andrew"), false);
    assert.equal(followAllows("mine", "andrew", null), false);
  });

  test("all follows anyone, off follows nobody", () => {
    assert.equal(followAllows("all", "kai", "andrew"), true);
    assert.equal(followAllows("off", "andrew", "andrew"), false);
  });

  test("follow routes through the one opener only when a local root matches", () => {
    const board = src("lib/board.ts");
    assert.ok(board.includes('if (g.followMode === "off") return;'), "off must halt follow");
    assert.ok(board.includes('if (g.followMode === "mine" && (!myActor || e.actor !== myActor)) return;'), "mine must ignore everyone else");
    assert.ok(board.includes("if (canOpen)"), "without a matching local root nothing opens");
    assert.ok(board.includes("toggleSelection(e.target)"), "a matching local root must open through toggleSelection");
    assert.ok(/selectedPath === e\.target[\s\S]*return;/.test(board), "re-selecting the open file closed it");
  });
});

describe("roster rendering", () => {
  test("the rail says who and what is running, and never a tool call", () => {
    const people = src("components/people.tsx");
    // ⚠️ THE TOOL TRACE IS GONE ON PURPOSE. Seven rows of `currentOf`/`turnOf`
    // per teammate was the single biggest thing the rail spent height on, and
    // the conversation column shows the same work in full. Andrew: "there's no
    // need in this People thing on the side to show any sort of tool use, I
    // think that just takes up too much space."
    assert.ok(!people.includes("currentOf"), "the tool trace came back to the rail");
    assert.ok(!people.includes("turnOf"), "the turn trace came back to the rail");
    // What a teammate is working on, in their own words, survives.
    assert.ok(people.includes("missionOf(r)"), "the row lost its mission");
    // Which agent is running is named by its own group now, not by the person
    // row: one disclosure per CLI, with that CLI's mark.
    assert.ok(people.includes("<AgentGroup"), "the agent-type groups are gone");
    assert.ok(people.includes("<AgentLogo"), "the agent mark is gone");
  });

  test("People shows only sessions still being written to", () => {
    const people = src("components/people.tsx");
    const constants = src("lib/constants.ts");
    // ⚠️ RECENCY, NOT LIVENESS — a session on disk has no pid and no end
    // marker, so the window is the whole of the evidence. Andrew: "once agents
    // are done, they should go somewhere like to history."
    assert.ok(people.includes("LIVE_SESSION_MS"), "the live window is not applied");
    assert.ok(
      /now - Number\(s\.updated \|\| 0\) >= LIVE_SESSION_MS/.test(people),
      "a session must be dropped once it goes quiet",
    );
    assert.ok(/LIVE_SESSION_MS = \d+ \* 60 \* 1000/.test(constants), "the window lost its units");
    // The full history belongs to the repo column, not the rail.
    // The rendered list, not the word — people.tsx's comments still name the
    // component it took the fetch away from.
    assert.ok(!people.includes("<SessionsPane"), "the whole session list came back to the rail");
    assert.ok(src("components/detail.tsx").includes("<SessionsPane />"), "the history has no home");
  });

  test("clicking a row expands it and persists the choice", () => {
    const people = src("components/people.tsx");
    assert.ok(people.includes('"zevet.expanded.v1"'), "the expansion key is gone");
    assert.ok(people.includes("JSON.stringify(next)"), "expansion must persist the whole list");
  });

  test("repos carry one dot per live actor", () => {
    const roster = [
      { actor: "andrew", lastEvent: ev({ repo: "zevet" }) },
      { actor: "kai", lastEvent: ev({ actor: "kai", repo: "zevet" }) },
    ];
    assert.equal(liveActorsOf(roster, "zevet").length, 2);
    assert.equal(liveActorsOf(roster, "other").length, 0);
    assert.equal(liveActorsOf(roster, "").length, 0);
    const ws = src("components/workspaces.tsx");
    assert.ok(ws.includes('className="livedot"'), "the dot rendering is gone");
    assert.ok(ws.includes("inRepo.length > 0"), "the live flag is gone");
  });
});

describe("pane widths", () => {
  test("clampPaneWidth holds the rails inside their limits", () => {
    assert.equal(clampPaneWidth(500, 180, 420), 420);
    assert.equal(clampPaneWidth(10, 180, 420), 180);
    assert.equal(clampPaneWidth("nope", 180, 420), 180);
    assert.equal(clampPaneWidth(250.6, 180, 420), 251);
  });
});

describe("agent hunk seating", () => {
  test("newestHunk picks the latest hunk and nothing else", () => {
    assert.deepEqual(newestHunk([{ start: 10, count: 2 }, { start: 40, count: 1 }]), { start: 40, count: 1 });
    assert.equal(newestHunk([]), null);
    assert.equal(newestHunk([{ start: "x" }, null]), null);
  });

  test("lastToolFor finds the latest tool on a file", () => {
    const events = [
      ev({ tool: "Read", target: "src/db.ts" }),
      ev({ tool: "Edit", target: "src/db.ts" }),
      ev({ tool: "Edit", target: "src/other.ts" }),
    ];
    assert.equal(lastToolFor(events, "zevet", "src/db.ts").tool, "Edit");
    assert.equal(lastToolFor(events, "zevet", "src/missing.ts"), null);
    assert.equal(lastToolFor(events, "other-repo", "src/db.ts"), null);
  });
});

describe("file-tree sprite map", () => {
  const opts = { repoName: "zevet", followMode: "all", myActor: "andrew", now: NOW, idleAfterMs: 60_000 };

  test("the most recent actor wins when two people touch one path", () => {
    const events = [
      ev({ actor: "andrew", tool: "Read", target: "src/db.ts", ts: NOW - 5000 }),
      ev({ actor: "kai", tool: "Edit", target: "src/db.ts", ts: NOW - 1000 }),
    ];
    const map = spritesByPath(events, opts);
    assert.deepEqual(map["src/db.ts"], { actor: "kai", tool: "Edit", ts: NOW - 1000 });
    assert.equal(Object.keys(map).length, 1);
  });

  test("an event past the idle threshold does not draw", () => {
    const events = [ev({ target: "src/old.ts", ts: NOW - 90_000 })];
    assert.deepEqual(spritesByPath(events, opts), {});
  });

  test("follow mode gates the map the same way the editor rider does", () => {
    const events = [ev({ actor: "kai", target: "src/db.ts" })];
    assert.deepEqual(spritesByPath(events, { ...opts, followMode: "off" }), {});
    assert.deepEqual(spritesByPath(events, { ...opts, followMode: "mine", myActor: "andrew" }), {});
    assert.equal(
      spritesByPath(events, { ...opts, followMode: "mine", myActor: "kai" })["src/db.ts"].actor,
      "kai",
    );
  });

  test("a non-tool event, a wrong repo, and a prompt with no target are all ignored", () => {
    const events = [
      ev({ kind: "prompt", target: null }),
      ev({ repo: "other-repo", target: "src/db.ts" }),
      ev({ target: null }),
    ];
    assert.deepEqual(spritesByPath(events, opts), {});
  });
});

describe("repo wording", () => {
  test("user-facing workspace wording is gone", () => {
    // The rule is the WORD, not where it sits. This asserted a "Repos" title
    // in App.tsx, and that title is gone — it was a header labelling a
    // dropdown that says what it is ("get rid of the repo header and have the
    // dropdown just start with open a repo"). What must not come back is the
    // internal word: the store still calls these workspaces, and the board
    // must not.
    const app = src("App.tsx");
    const ws = src("components/workspaces.tsx");
    const tree = src("components/tree.tsx");
    assert.ok(ws.includes("Open a repo"), "the folder picker no longer says repo");
    assert.ok(!app.includes(">Workspaces"), "Workspaces title still present");
    assert.ok(tree.includes("Follow mine"), "follow control missing");
  });

  test("the Files column has no header, but keeps a grip on the window", () => {
    // Two asks, one row. "Files — zevet" said two things already on screen,
    // so the title went; then "move the follow mine/all/off to next to
    // people, so you can move the file tree up" took the last thing in that
    // row and the row itself with it.
    //
    // ⚠️ WHAT MUST NOT GO IS THE DRAG REGION. `.pane-title` carries
    // -webkit-app-region: drag and the native caption is hidden, so those
    // strips are the only thing holding this window. Deleting the row
    // outright would leave the middle third of the top edge ungrabbable and
    // put a clickable file row where somebody aims to move the window.
    const tree = src("components/tree.tsx");
    const css = readFileSync(path.join(ROOT, "board", "src", "styles", "masora.css"), "utf8");
    assert.ok(tree.includes("treecol-grip"), "the drag grip is gone from the Files column");
    assert.match(tree, /className="pane-title treecol-grip"/,
      "the grip must keep the pane-title class, which is what carries the drag region");
    assert.match(css, /\.treecol-grip\s*\{[^}]*height:/, "the grip has no height rule");
    assert.ok(!tree.includes('id="filesTitle"'), "the Files title text is back");
  });

  test("the follow control is in the rail, beside People", () => {
    const app = src("App.tsx");
    const tree = src("components/tree.tsx");
    assert.ok(tree.includes("export function FollowControl"), "FollowControl is not exported");
    assert.ok(app.includes("<FollowControl"), "the rail does not render the follow control");
  });
});