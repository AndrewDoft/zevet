// The onboarding paths, read from source: what the real (unstubbed) build does
// where scripts/drive's ZEVET_TEST_HOOKS stub would hide it. Behaviour is in
// setup-window.test.mjs (driven) and masora-link.test.mjs (unit).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const main = read("desktop", "main.js");
const preload = read("desktop", "preload.js");
const setup = read("desktop", "setup.html");
const pkg = JSON.parse(read("desktop", "package.json"));

/** The body of `ipcMain.handle("<channel>", ...)`, up to its closing `});`. */
function handler(channel) {
  const i = main.indexOf(`ipcMain.handle("${channel}"`);
  assert.ok(i >= 0, `${channel} is registered`);
  return main.slice(i, main.indexOf("\n});", i));
}

describe("sign-in opens the system browser", () => {
  test("GitHub and Google both call shell.openExternal with the URL the hub gave, and report whether it opened", () => {
    const gh = handler("zevet:githubStart");
    assert.match(gh, /opened = await shell\.openExternal\(r\.verificationUriComplete\)\.then\(\(\) => true, \(\) => false\)/);
    assert.match(gh, /expiresIn: r\.expiresIn, opened/);
    const g = handler("zevet:googleStart");
    assert.match(g, /opened = await shell\.openExternal\(r\.authUrl\)\.then\(\(\) => true, \(\) => false\)/);
    assert.match(g, /domain: r\.domain, opened/);
  });

  test("the setup window says so when the browser did not open", () => {
    assert.match(setup, /started\.opened === false/g);
  });

  test("the test hook is the only thing that replaces shell.openExternal", () => {
    const assigns = main.match(/shell\.openExternal\s*=/g) || [];
    assert.equal(assigns.length, 1);
    assert.match(main, /if \(process\.env\.ZEVET_TEST_HOOKS === "1"\) \{\s*const openedLog/);
  });
});

describe("hubs are named", () => {
  test("teamCreate refuses an empty name and sends the name to the hub", () => {
    const t = handler("zevet:teamCreate");
    assert.match(t, /Name the team/);
    assert.match(t, /JSON\.stringify\(\{ name: teamName \}\)/);
  });

  test("setup requires a name before creating, and shows the name it got back", () => {
    assert.match(setup, /id="teamName"/);
    assert.match(setup, /"Name\?"/);
    assert.match(setup, /teamCreate\(hub, name\)/);
  });

  test("the address is the name: setup derives hub and team from it, hosted hub by default", () => {
    assert.match(setup, /HOSTED_HUB = "https:\/\/34-74-69-129\.sslip\.io"/);
    assert.match(setup, /teamResolve\(hub, name\)/);
    assert.match(handler("zevet:teamResolve"), /\/team\/resolve\?name=/);
    assert.match(setup, /<details id="other">\s*<summary>Other hub/);
  });

  test("the rail and Settings show it", () => {
    assert.match(read("board", "src", "App.tsx"), /id="railTeam"/);
    assert.match(read("board", "src", "components", "settings.tsx"), /<SRow k="Team" v=\{teamName\}/);
  });
});

describe("the setup window is frameless like the board", () => {
  const open = main.slice(main.indexOf("function openSetup"), main.indexOf("setupWindow.loadFile"));
  test("same titleBarStyle/overlay treatment as openBoard, with a drag bar in the page", () => {
    assert.match(open, /titleBarStyle: "hidden"/);
    assert.match(open, /titleBarStyle: "hiddenInset"/);
    assert.match(open, /titleBarOverlay: chromeFor\("light", 0\)/);
    assert.match(setup, /\.titlebar \{[^}]*-webkit-app-region: drag/);
  });
});

describe("the family runs from the main process", () => {
  test("it starts with the app, stops with it, and the bridge exposes the panel", () => {
    assert.match(main, /appUpdater\.start\(\);\s*family\.start\(\)/);
    assert.match(main, /before-quit", \(\) => family\.stop\(\)/);
    for (const n of ["familyStatus", "familyAct"]) assert.match(preload, new RegExp(n + ":"));
    assert.ok(pkg.build.files.includes("family.js"));
  });
  test("a 401 from Masora re-pairs", () => {
    assert.match(handler("masora:sources"), /res\.status === 401\) void family\.repair\(\)/);
  });
});

describe("the Masora link is a background job", () => {
  test("the board starts it, and Open zevet does not wait on it", () => {
    assert.match(main, /masoraLink\.start\(\);\s*boardWindow = new BrowserWindow/);
    assert.doesNotMatch(handler("zevet:done"), /masora/i);
    assert.doesNotMatch(setup, /window.zevet.masora/);
  });

  test("the bridge exposes status, retry and approve, and no blocking pair calls", () => {
    for (const n of ["masoraLinkStatus", "masoraLinkStart", "masoraLinkApprove"]) assert.match(preload, new RegExp(`${n}:`));
    assert.doesNotMatch(preload, /masoraPair/);
    assert.doesNotMatch(main, /masoraPair/);
  });

  test("it ships in the installer", () => {
    assert.ok(pkg.build.files.includes("masora-link.js"));
  });
});

describe("Settings copy is provider-neutral", () => {
  test("a Google login is not prefixed with @, and the session is not called GitHub's", () => {
    const s = read("board", "src", "components", "settings.tsx");
    assert.doesNotMatch(s, /"@" \+ p\.login|summary=\{login \? "@"/);
    assert.match(s, /login\.includes\("@"\) \? login/);
    assert.doesNotMatch(s, /"GitHub sign-in" \+ \(c\.hasSecret/);
  });
});
