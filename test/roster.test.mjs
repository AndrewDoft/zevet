// The merged roster: presence, follow-mode, marks, and pane widths.
//
// Board UI is one inline script with no build step, so these are executed
// slices of hub/public/index.html against a fake DOM, the same technique as
// test/board-updates.test.mjs. Pure-display mappers (hueOf, verbFor, ago)
// run as their real implementations; toggleSelection is a recording stub,
// because the contract under test is WHEN follow calls it, and the function
// itself is covered by test/board.test.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers.mjs";

const html = readFileSync(path.join(ROOT, "hub", "public", "index.html"), "utf8");

function between(start, end) {
  const a = html.indexOf(start);
  assert.ok(a >= 0, `board boundary moved: ${start}`);
  const b = html.indexOf(end, a);
  assert.ok(b > a, `board boundary moved: ${end}`);
  return html.slice(a, b);
}

const source = [
  between("  function hueOf(", "  function agoEl("),
  between("  function ago(", "  function verbFor("),
  between("  function verbFor(", "  function liveDots("),
  between("  function liveDots(", "  function followEvent("),
  between("  function followEvent(", "  function blankNode("),
  between("  function renderPeople(", "  function folderOf("),
  between("  function folderOf(", "  function refreshLocalWorkspaces("),
  between("  var AGENT_MARKS", "  function renderTree("),
  between("  function clampPaneWidth(", "  function applyPaneWidths("),
  between("  function newestHunk(", "  function followAllows("),
  between("  function followAllows(", "  function lastToolFor("),
  between("  function lastToolFor(", "  function refreshAgentLine("),
].join("\n");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = { setProperty: () => {} };
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.parentNode = null;
    this.disabled = false;
    this._text = "";
    this.className = "";
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  set textContent(value) {
    this._text = String(value);
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(" "); }
  // innerHTML on the fake records rather than parses: enough to assert WHAT
  // markup the board chose without a DOM.
  set innerHTML(value) { this._html = String(value); }
  get innerHTML() { return this._html || ""; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  click() { if (!this.disabled) return this.listeners.click?.({ shiftKey: false }); }
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

const NOW = 1_000_000;
const ev = (over) => ({
  ts: NOW - 1000, actor: "andrew", kind: "tool", tool: "Edit",
  target: "src/db.ts", detail: "", repo: "zevet", branch: "main", agent: "claude-code",
  ...over,
});

function board(over = {}) {
  // The sliced followMode initializer reads localStorage, exactly like the
  // page: seed the store rather than handing the var in from outside, so the
  // harness exercises the real persistence path including its default.
  const store = {
    "zevet.expanded.v1": JSON.stringify(over.expanded || []),
    "zevet.follow.v1": over.follow || "mine",
  };
  const context = {
    HUES: 5,
    IDLE_FALLBACK: 90000,
    events: over.events || [],
    roster: over.roster || [],
    idleAfterMs: 90000,
    selectedActor: null,
    selectedRepo: over.selectedRepo !== undefined ? over.selectedRepo : "zevet",
    selectedPath: null,
    LOCAL: over.local || false,
    localRoot: over.localRoot || null,
    render: () => {},
    followMode: over.follow || "mine",
    window: { __zevetCfg: { actor: "andrew" }, zevet: {} },
    document: {
      createElement: (tag) => new Element(tag),
      createTextNode: (text) => Object.assign(new Element("#text"), { _text: String(text) }),
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    $: (id) => (id === "people" ? context.host : null),
    el: (tag, className) => Object.assign(new Element(tag), { className: className || "" }),
    tx: (node, text) => { node.textContent = text; return node; },
    toggleSelection: (p) => { context.toggled.push(p); },
  };
  context.host = new Element("div");
  context.toggled = [];
  context.store = store;
  new vm.Script(source, { filename: "board-roster" }).runInContext(vm.createContext(context));
  return context;
}

describe("turn summary", () => {
  test("mission is the prompt, terminal-title short; current is the latest tool", () => {
    const ui = board({
      events: [
        ev({ kind: "prompt", detail: "migrate the auth table to sessions, keeping every existing test green along the way" }),
        ev({ tool: "Read", target: "src/auth.ts" }),
        ev({ tool: "Bash", target: null, detail: "npm test" }),
      ],
      roster: [{ actor: "andrew", lastTs: NOW, lastEvent: ev({}) }],
    });
    assert.equal(ui.missionOf(ui.roster[0]).length <= 80, true);
    assert.match(ui.missionOf(ui.roster[0]), /migrate the auth table/);
    assert.equal(ui.currentOf(ui.roster[0]), "Bash  npm test");
  });

  test("a quiet person has no mission and no current command", () => {
    const end = ev({ actor: "kai", kind: "turn_end" });
    const ui = board({
      events: [end],
      roster: [{ actor: "kai", lastTs: NOW - 999999, lastEvent: end }],
    });
    assert.equal(ui.missionOf(ui.roster[0]), "");
    assert.equal(ui.currentOf(ui.roster[0]), "turn finished");
  });
});

describe("agent marks", () => {
  test("known agents get their mark, unknown agents the bead", () => {
    const ui = board({});
    for (const agent of ["claude-code", "codex", "opencode"]) {
      const mark = ui.agentBadge(agent);
      assert.equal(mark.className, "mark");
      assert.ok(mark.innerHTML.includes("<svg"), `${agent} produced an empty mark`);
    }
    const bead = ui.agentBadge("something-new");
    assert.equal(bead.className, "bead");
  });

  test("marks carry inline SVG and never touch model output", () => {
    const ui = board({});
    const mark = ui.agentBadge("codex");
    assert.ok(mark.innerHTML.includes("<svg"), "no inline svg in the mark");
    assert.ok(mark.innerHTML.includes("viewBox"), "mark is not a scaled vector");
  });
});

describe("follow mode", () => {
  test("mine follows your own agent without opening foreign checkouts", () => {
    const ui = board({ follow: "mine" });
    ui.followEvent(ev({ target: "src/db.ts", repo: "zevet" }));
    assert.equal(ui.selectedPath, "src/db.ts");
    assert.deepEqual(ui.toggled, [], "no local root: highlight, never open");
  });

  test("mine ignores everyone else", () => {
    const ui = board({ follow: "mine" });
    ui.followEvent(ev({ actor: "kai", target: "src/x.ts", repo: "zevet" }));
    assert.equal(ui.selectedPath, null);
  });

  test("all follows anyone, off follows nobody", () => {
    const all = board({ follow: "all" });
    all.followEvent(ev({ actor: "kai", target: "src/x.ts", repo: "zevet" }));
    assert.equal(all.selectedPath, "src/x.ts");
    const off = board({ follow: "off" });
    off.followEvent(ev({ target: "src/db.ts", repo: "zevet" }));
    assert.equal(off.selectedPath, null);
  });

  test("an already-open file is not toggled shut", () => {
    const ui = board({ follow: "all", local: true, localRoot: "C:\\dev\\zevet" });
    ui.selectedPath = "src/db.ts";
    ui.followEvent(ev({ actor: "kai", target: "src/db.ts", repo: "zevet" }));
    assert.deepEqual(ui.toggled, [], "re-selecting the open file closed it");
  });

  test("a matching local root opens through toggleSelection", () => {
    const ui = board({ follow: "all", local: true, localRoot: "C:\\dev\\zevet" });
    ui.followEvent(ev({ actor: "kai", target: "src/new.ts", repo: "zevet" }));
    // The stub records the call without running the real selection logic;
    // what matters here is that follow routes through the one opener.
    assert.deepEqual(ui.toggled, ["src/new.ts"]);
  });
});

describe("roster rendering", () => {
  test("rows show marks and expand to mission plus current", () => {
    const ui = board({
      expanded: ["andrew"],
      events: [
        ev({ kind: "prompt", detail: "fix the login redirect" }),
        ev({ tool: "Edit", target: "src/auth.ts" }),
      ],
      roster: [{ actor: "andrew", lastTs: NOW, lastEvent: ev({ tool: "Edit", target: "src/auth.ts" }) }],
    });
    ui.renderPeople(NOW);
    assert.match(ui.host.textContent, /andrew/);
    assert.match(ui.host.textContent, /fix the login redirect/);
    assert.match(ui.host.textContent, /src\/auth\.ts/);
    assert.ok(find(ui.host, (n) => n.className === "mark"), "no agent mark on the row");
  });

  test("clicking a row expands it and persists the choice", () => {
    const ui = board({
      events: [ev({ kind: "prompt", detail: "hello" })],
      roster: [{ actor: "andrew", lastTs: NOW, lastEvent: ev({}) }],
    });
    ui.renderPeople(NOW);
    const row = find(ui.host, (n) => (n.listeners.click ? true : false) && n.tag === "button");
    assert.ok(row, "no clickable row");
    row.click();
    assert.deepEqual(JSON.parse(ui.store["zevet.expanded.v1"]), ["andrew"]);
  });

  test("repos carry one dot per live actor", () => {
    const ui = board({
      roster: [
        { actor: "andrew", lastTs: NOW, lastEvent: ev({ repo: "zevet" }) },
        { actor: "kai", lastTs: NOW, lastEvent: ev({ actor: "kai", repo: "zevet" }) },
      ],
    });
    const host = new Element("div");
    ui.liveDots("zevet", host);
    assert.equal(host.children.filter((c) => c.className === "livedot").length, 2);
    assert.equal(host.dataset.live, "true");
    const empty = new Element("div");
    ui.liveDots("other", empty);
    assert.equal(empty.dataset.live, "false");
  });
});

describe("pane widths", () => {
  test("clampPaneWidth holds the rails inside their limits", () => {
    const ui = board({});
    assert.equal(ui.clampPaneWidth(500, 180, 420), 420);
    assert.equal(ui.clampPaneWidth(10, 180, 420), 180);
    assert.equal(ui.clampPaneWidth("nope", 180, 420), 180);
    assert.equal(ui.clampPaneWidth(250.6, 180, 420), 251);
  });
});

describe("agent hunk seating", () => {
  test("newestHunk picks the latest hunk and nothing else", () => {
    const ui = board({});
    assert.deepEqual(ui.newestHunk([{ start: 10, count: 2 }, { start: 40, count: 1 }]), { start: 40, count: 1 });
    assert.equal(ui.newestHunk([]), null);
    assert.equal(ui.newestHunk([{ start: "x" }, null]), null);
  });

  test("followAllows gates scroll by mode and actor", () => {
    assert.equal(board({ follow: "off" }).followAllows("andrew"), false);
    assert.equal(board({ follow: "all" }).followAllows("kai"), true);
    assert.equal(board({ follow: "mine" }).followAllows("andrew"), true);
    assert.equal(board({ follow: "mine" }).followAllows("kai"), false);
  });

  test("lastToolFor finds the latest tool on a file", () => {
    const ui = board({
      events: [
        ev({ tool: "Read", target: "src/db.ts" }),
        ev({ tool: "Edit", target: "src/db.ts" }),
        ev({ tool: "Edit", target: "src/other.ts" }),
      ],
    });
    assert.equal(ui.lastToolFor("zevet", "src/db.ts").tool, "Edit");
    assert.equal(ui.lastToolFor("zevet", "src/missing.ts"), null);
    assert.equal(ui.lastToolFor("other-repo", "src/db.ts"), null);
  });
});

describe("repo wording", () => {
  test("user-facing workspace wording is gone", () => {
    const src = readFileSync(path.join(ROOT, "hub", "public", "index.html"), "utf8");
    assert.ok(src.includes(">Repos<"), "Repos title missing");
    assert.ok(!src.includes(">Workspaces<"), "Workspaces title still present");
    assert.ok(src.includes("Follow mine"), "follow control missing");
  });
});
