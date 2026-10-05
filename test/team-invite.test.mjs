// The rail's pane is "Team", its "+" opens the invite in a dialog, and the
// invite is Settings' own (one component, two homes). The two views differ in
// whether the file tree is open. Source assertions, same precedent as
// test/settings-surface.test.mjs: the board cannot be required outside a DOM.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = (rel) => readFileSync(path.join(ROOT, "board", "src", ...rel.split("/")), "utf8");

describe("Team pane", () => {
  const app = src("App.tsx");
  const invite = src("components/invite.tsx");

  test("the title says Team, not Agents; the id stays #people", () => {
    assert.match(app, /<span>Team<\/span>/);
    assert.doesNotMatch(app, /<span>Agents<\/span>/);
    assert.match(app, /id="people"/);
  });

  test("the title's + is the invite, and it no longer needs an open folder", () => {
    assert.match(app, /<InvitePlus \/>/);
    const title = app.slice(app.indexOf("<span>Team</span>"), app.indexOf("<FollowControl"));
    assert.doesNotMatch(title, /openLauncher|localRoot/);
  });

  test("Settings and the popup render the one TeamInvite", () => {
    assert.match(src("components/settings.tsx"), /<TeamInvite key="team" \/>/);
    const plus = invite.slice(invite.indexOf("export function InvitePlus"));
    assert.match(plus, /<Dialog open=\{open\} onOpenChange=\{setOpen\}>[\s\S]*<TeamInvite \/>/);
    assert.doesNotMatch(src("components/settings.tsx"), /\/auth\/allow/, "a second invite flow crept back into Settings");
  });

  test("only someone who can invite sees the +", () => {
    assert.match(invite, /if \(!owner\) return null;/);
  });

  test("starting an agent stays reachable: Conversation header + and the palette", () => {
    assert.match(app, /aria-label="New agent" title="New agent" onClick=\{openLauncher\}/);
    assert.match(src("components/palette.tsx"), /label: "New agent"/);
    assert.match(app, />\s*New agent \+\s*<\/button>/);
  });
});

describe("Files and Agent views differ in the tree", () => {
  const board = src("lib/board.ts");

  test("Files opens the tree by default, Agent shuts it, each view keeps its own", () => {
    assert.match(board, /pref\("treeHidden\." \+ v, v === "agent" \? "1" : "0"\) === "1"/);
  });

  test("switching view re-derives the tree fold from the new view", () => {
    assert.match(board, /set\(\{ viewMode: v, treeHidden: treeHiddenFor\(v\) \}\)/);
  });
});
