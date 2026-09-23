// What the renderer can reach, and what it must never reach.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THESE ARE SOURCE ASSERTIONS AND NOT A RUNNING APP
//
// `desktop/main.js` registers `ipcMain.handle` callbacks and `desktop/
// preload.js` calls `contextBridge.exposeInMainWorld`. Neither does anything at
// all outside Electron: importing main.js from `node --test` throws on
// `require("electron")` before a single handler exists, and there is no harness
// in this repo that can dispatch an IPC message. `test/desktop-packaging.test.
// mjs` faced exactly this and answered it by asserting against the SOURCE TEXT;
// this file follows that precedent rather than inventing an Electron harness,
// which would itself be a large untested thing standing between the suite and
// the code.
//
// ⚠️ WHAT THAT BUYS AND WHAT IT DOES NOT. A source assertion catches a
// capability being widened, a guard being deleted, a credential being added to
// a payload, and the two halves of a bridge drifting apart — which are the
// regressions that are invisible in a diff review and expensive in the field.
// It CANNOT tell you the thing works. Nothing here has run inside Electron,
// nothing here has opened a socket, and a handler that is registered correctly
// and does the wrong thing at runtime passes every case below. The parts that
// can be tested for real are tested for real, in test/file-watch.test.mjs and
// test/doc-sync.test.mjs, against real directories and a real hub.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const main = readFileSync(path.join(DESKTOP, "main.js"), "utf8");
const preload = readFileSync(path.join(DESKTOP, "preload.js"), "utf8");

/**
 * Comments out, so that a case asserting "this word does not appear" is about
 * the CODE and not about the prose around it. These files argue with
 * themselves at length — the word "secret" appears dozens of times explaining
 * why the secret must not cross — and a naive search would be unfalsifiable.
 *
 * Crude on purpose: it also eats `//` inside a string literal. There are no
 * URLs in the handler bodies this is applied to, and a more careful version
 * would be a JavaScript parser, which is not worth it for this.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The body of one `ipcMain.handle("channel", …)`, up to the next handler. */
function handlerBody(channel) {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  assert.ok(start >= 0, `main.js has no handler for ${channel}`);
  const after = main.indexOf("ipcMain.handle(", start + 10);
  return main.slice(start, after < 0 ? main.length : after);
}

/** The body of one property on an `exposeInMainWorld` object, by name. */
function bridgeSource(world) {
  const start = preload.indexOf(`contextBridge.exposeInMainWorld("${world}"`);
  assert.ok(start >= 0, `preload.js never exposes ${world}`);
  const after = preload.indexOf("contextBridge.exposeInMainWorld(", start + 10);
  return preload.slice(start, after < 0 ? preload.length : after);
}

describe("the bridge surface the renderer is written against", () => {
  // These names are a CONTRACT with the board's renderer, which is written in
  // another file by another author. A rename here that looks harmless breaks
  // both halves at once and breaks them silently: `window.zevetDoc.join` simply
  // becomes undefined, and the editor does nothing with no error anywhere.
  test("window.zevetDoc exposes exactly join, send, leave, onMessage, onStatus", () => {
    const doc = bridgeSource("zevetDoc");
    for (const name of ["available", "join", "send", "leave", "onMessage", "onStatus"]) {
      assert.match(doc, new RegExp(`\\b${name}:`), `zevetDoc is missing ${name}`);
    }
    assert.match(doc, /available:\s*true/);
    // The channel names, which are the other half of the same contract.
    assert.match(doc, /invoke\("doc:join"/);
    assert.match(doc, /invoke\("doc:send"/);
    assert.match(doc, /invoke\("doc:leave"/);
  });

  test("send passes room, bytes and opts, and normalises the bytes on the way", () => {
    const doc = bridgeSource("zevetDoc");
    assert.match(doc, /send:\s*\(room,\s*u8,\s*opts\)/, "send's signature is not (room, u8, opts)");
    assert.match(doc, /bytes:\s*toUint8\(u8\)/, "send ships the caller's object without normalising it");
  });

  test("zevetLocal gains stats, watch, unwatch and onFileChanged, and keeps what it had", () => {
    const local = bridgeSource("zevetLocal");
    for (const name of ["stats", "watch", "unwatch", "onFileChanged", "tree", "read", "write", "workspaces"]) {
      assert.match(local, new RegExp(`\\b${name}:`), `zevetLocal is missing ${name}`);
    }
    assert.match(local, /invoke\("local:stats",\s*\{\s*root,\s*relPaths\s*\}/);
    assert.match(local, /invoke\("local:watch",\s*\{\s*root,\s*relPath,\s*initialText\s*\}/);
    assert.match(local, /invoke\("local:unwatch",\s*\{\s*root,\s*relPath\s*\}/);
  });

  test("every channel the preload invokes is actually handled in main", () => {
    // The failure this prevents is a promise that rejects with "No handler
    // registered for 'local:stats'" — which reaches the renderer as an
    // exception from a call that looks perfectly well formed.
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]);
    const handled = new Set([...main.matchAll(/ipcMain\.handle\("([^"]+)"/g)].map((m) => m[1]));
    assert.ok(invoked.length >= 15, `only found ${invoked.length} invoke calls — did the scrape break?`);
    for (const channel of new Set(invoked)) {
      assert.ok(handled.has(channel), `preload invokes "${channel}" and main.js handles nothing of that name`);
    }
  });

  test("every channel the preload listens on is actually sent from main", () => {
    const listened = [...preload.matchAll(/ipcRenderer\.on\("([^"]+)"|subscribe\("([^"]+)"/g)]
      .map((m) => m[1] || m[2]);
    assert.deepEqual(
      [...new Set(listened)].sort(),
      // ⚠️ A FROZEN LIST, ON PURPOSE. A push channel is main→renderer traffic
      // the renderer did not ask for, and the renderer here is a page served by
      // the hub. Adding one is a decision, so it costs an edit to this line and
      // a sentence saying why.
      //   local:indexEvent — code-index progress. Model download bytes and
      //   refresh counts, so an 86MB fetch is not a frozen button. Carries no
      //   file contents and no paths outside the workspace the user opened.
      //   app:update — the desktop updater's phase, version and percentage, so
      //   the rail can show a download in progress and then a Restart button.
      //   Carries the update DIRECTORY path in `file`, which is inside
      //   userData and is not a path the hub could not already guess; it
      //   carries no credential and nothing about the user's repos. The board
      //   cannot start an install with it — that is an invoke, from a click.
      //   local:permitRequest — an agent has asked to click, type or take a
      //   screenshot and is BLOCKED until a person answers (see the COMPUTER
      //   USE block in main.js). It has to be pushed, because the agent did
      //   not ask the board for anything — the board is being asked. It
      //   carries the MCP tool name and the arguments the model sent, which is
      //   strictly LESS than local:agentEvent above already pushes for every
      //   tool call in the transcript, and the answer travels back the other
      //   way as an invoke, from a click. Denial is the default: the
      //   ask-server times out into a refusal, so a board that never answers
      //   costs the agent an action rather than granting one.
      //   local:askRequest — the SAME gate, for a question rather than a
      //   yes/no: the agent is blocked on `ask_user` (desktop/ask-server.js's
      //   /ask route) and the board is the only place a person can answer it.
      //   Carries the bounded question text and its options (desktop/
      //   zevet-mcp.js's cleanQuestion caps both before this is ever sent);
      //   the answer travels back as an invoke, from a click, and silence
      //   times out to "no answer" rather than blocking forever.
      //   chat:event — Zevet Chat's own stream (desktop/chat.js), the same
      //   agent/exit events local:agentEvent carries for a console, keyed by
      //   chat id, plus a `saved` notice with the chat's id, title and time.
      //   The words are the person's own conversation, which the page already
      //   holds because it sent them; it is a separate channel only so a chat
      //   is never drawn as a console in Code.
      //   local:schedulesChanged — a due schedule just ran (or was skipped);
      //   the board's own scheduled-run list is otherwise only refreshed
      //   after a save/toggle/remove round-trip it initiated itself. Carries
      //   the same schedule records local:schedules already returns to an
      //   invoke, from a click — no new data crosses the boundary here.
      ["app:update", "chat:event", "doc:message", "doc:status", "local:agentEvent", "local:askRequest", "local:fileChanged", "local:indexEvent", "local:permitRequest", "local:schedulesChanged"],
      "the set of pushed channels changed",
    );
    for (const channel of new Set(listened)) {
      assert.ok(
        main.includes(`toBoard("${channel}"`) || main.includes(`send("${channel}"`),
        `preload listens for "${channel}" and nothing in main.js ever sends it`,
      );
    }
  });

  test("every subscription hands back an unsubscribe", () => {
    // A listener registered on every mount and never removed is delivered to N
    // stale closures holding N dead Y.Docs, and Node starts warning about it at
    // eleven — by which time the cause is a long way from the symptom.
    assert.match(
      preload,
      /function subscribe\([\s\S]*?return \(\) => ipcRenderer\.removeListener\(channel, handler\)/,
      "subscribe() does not return a remover",
    );
    for (const name of ["onMessage", "onStatus", "onFileChanged"]) {
      assert.match(
        preload,
        new RegExp(`${name}:[\\s\\S]{0,400}?subscribe\\(`),
        `${name} does not go through subscribe(), so it may not be removable`,
      );
    }
  });
});

describe("the key, the secret and the socket stay in the main process", () => {
  // THE DESIGN RESTS ON THIS. The board window loads the HUB'S OWN PAGE, so
  // anything a renderer can read, the hub can read. The document key is derived
  // from the master secret; hand the hub either and the encryption is defending
  // against nobody. See client/secret.mjs and desktop/doc-sync.js.

  test("zevet:config returns no credential of any kind", () => {
    const body = stripComments(handlerBody("zevet:config"));
    assert.doesNotMatch(body, /\bsecret\s*:/, "zevet:config puts a `secret` field in its answer");
    assert.doesNotMatch(body, /\btoken\s*:/, "zevet:config puts a `token` field in its answer");
    // The original shape of this bug: returning the parsed config whole.
    assert.doesNotMatch(body, /=>\s*readConfig\(\)\s*\)/, "zevet:config returns the raw config object");
    assert.doesNotMatch(body, /return\s+cfg\s*;/, "zevet:config returns the raw config object");
    // What it may return, and what the board needs from it.
    assert.match(body, /hub\s*:/);
    assert.match(body, /actor\s*:/, "the board labels remote cursors with `actor` and cannot do without it");
    assert.match(body, /hasSecret/, "nothing tells the renderer whether a secret is configured");
  });

  test("no bridge call answers with a secret, a token or a key", () => {
    const code = stripComments(preload);
    for (const bad of [/\bsecret\b/, /\bdocKey\b/, /\bdocSync\b/, /\bderiveAuthToken\b/]) {
      assert.doesNotMatch(code, bad, `preload.js mentions ${bad} in code, not just in a comment`);
    }
  });

  test("the only credential in preload.js is one being carried INTO setup, never back out", () => {
    // `token` legitimately appears in this file: the setup window types a
    // credential and it has to reach the main process somehow. The DIRECTION is
    // the whole question, so every line mentioning it is enumerated here — a
    // new one has to be added deliberately, and shows up in the diff as exactly
    // what it is.
    const lines = stripComments(preload)
      .split("\n")
      .filter((l) => /\btoken\b/.test(l))
      .map((l) => l.trim());
    assert.deepEqual(lines, [
      'test: (hub, token) => ipcRenderer.invoke("zevet:test", { hub, token }),',
      'save: (hub, token, actor) => ipcRenderer.invoke("zevet:save", { hub, token, actor }),',
    ]);
  });

  test("what main pushes to the board carries bytes and nothing else", () => {
    // `docMessage` is the single funnel for everything DocSync emits. If a
    // field is ever added to it, it is added here and is visible in this diff.
    const fn = main.slice(main.indexOf("function docMessage("));
    const body = stripComments(fn.slice(0, fn.indexOf("\n}") + 2));
    assert.match(body, /out\.bytes = new Uint8Array\(payload\.bytes\)/, "the pooled Buffer is shipped uncopied");
    assert.doesNotMatch(body, /key|secret|token/, "docMessage puts a credential in a board message");
  });

  test("the DocSync instance is built in main, held in main, and destroyed with the window", () => {
    assert.match(main, /let docSync = null/, "DocSync is not a main-process singleton");
    assert.match(main, /docSync\.destroy\(\)/, "nothing ever destroys the DocSync");
    // A reload is a new renderer with new Y.Docs; the sockets and the OS watch
    // handles behind the old one would otherwise accumulate for the session.
    assert.match(
      main,
      /did-start-loading[\s\S]{0,120}releaseBoardResources\(\)/,
      "a reload does not release the board's sockets and watchers",
    );
    assert.match(
      main,
      /boardWindow\.on\("closed"[\s\S]{0,600}?releaseBoardResources\(\)/,
      "closing the board window does not release its sockets and watchers",
    );
    const release = main.slice(main.indexOf("function releaseBoardResources("));
    assert.match(release.slice(0, 400), /docSync\.destroy\(\)[\s\S]*fileWatch\.closeAll\(\)/);
  });

  test("a reload re-attaches to running agents; close and quit still stop them", () => {
    const fn = main.slice(main.indexOf("function releaseBoardResources("));
    const release = stripComments(fn.slice(0, fn.indexOf("\n}") + 2));
    assert.doesNotMatch(release, /stopAllConsoles/, "a reload kills every running agent");
    assert.match(
      main,
      /boardWindow\.on\("closed"[\s\S]{0,900}?stopAllConsoles\(\)/,
      "closing the board window leaves its agents running",
    );
    assert.match(main, /app\.on\("before-quit", stopAllConsoles\)/, "quitting leaves agents running");
    assert.match(main, /ipcMain\.handle\("local:consoles"/, "a reloaded board cannot ask for its consoles");
    assert.match(preload, /consoles: \(\) => ipcRenderer\.invoke\("local:consoles"\)/);
    assert.match(preload, /forgetAgent: \(id\) => ipcRenderer\.invoke\("local:forgetAgent", id\)/);
  });

  test("a scheduled run reattaches like any other console", () => {
    const start = main.indexOf("async function runDueSchedules(");
    const body = stripComments(main.slice(start, main.indexOf("\nlet scheduleTimer", start)));
    assert.match(body, /consoleLog\.record\(handle\.id, evt\)/, "scheduled events bypass consoleLog and cannot reattach on reload");
    assert.match(body, /consoleLog\.open\(started\.id/, "a scheduled console is never opened, so it is missing from the snapshot");
    assert.match(body, /consoles\.set\(started\.id, started\)/, "a scheduled console is untracked, so local:stopAgent and quit cannot stop it");
    assert.match(body, /scheduled: s\.id/, "the scheduled marker is dropped");
  });

  test("the secret reaches DocSync and the derived token reaches the hub — never the other way round", () => {
    // Comments stripped: this file argues at length about `cfg.secret` in the
    // very comment that explains why `cfg.secret` is not used here, and a
    // search that could not tell the two apart would fail on the explanation.
    const board = stripComments(
      main.slice(main.indexOf("function openBoard("), main.indexOf("function credentialPage(")),
    );
    // The board URL ends up in the renderer's own `location`, readable by the
    // page the hub served, and in every proxy log on the way.
    assert.doesNotMatch(board, /token=\$\{encodeURIComponent\(cfg\.token\)/, "the board URL carries the raw config token");
    assert.doesNotMatch(board, /cfg\.secret/, "the board URL is built from the master secret");
    assert.match(board, /authFor\(cfg\)/, "the board URL does not go through the credential resolver");
    assert.match(board, /encodeURIComponent\(auth\.token\)/);

    // Into DocSync, the secret; out of it, nothing.
    const ensure = main.slice(main.indexOf("function ensureDocSync("));
    assert.match(ensure.slice(0, 2000), /secret:\s*cfg\.secret/, "DocSync is not given the master secret to derive from");
  });
});

describe("the auth migration: one resolver, no raw credentials", () => {
  // `~/.zevet/config.json` moved from {hub, token, actor} to {hub, secret,
  // actor}. client/secret.mjs's resolveAuth is the ONE place that decides what
  // a machine has, so that the hook, the doctor, the board and the editor
  // cannot drift into four answers.

  test("a config with only a secret is a valid config", () => {
    // The bug this prevents is total: judging a config invalid for want of a
    // `token` sends every freshly set-up machine back through setup, forever,
    // with setup writing the same config it just rejected.
    const fn = main.slice(main.indexOf("function readConfig("));
    const body = stripComments(fn.slice(0, fn.indexOf("\n}\n") + 3));
    assert.match(body, /cfg\.secret/, "readConfig never looks at `secret`");
    assert.match(body, /cfg\.token/, "readConfig no longer honours a legacy token");
    assert.doesNotMatch(
      body,
      /typeof cfg\.token === "string" && cfg\.hub && cfg\.token\) return cfg/,
      "readConfig still demands a token",
    );
  });

  test("everything that talks to the hub sends the derived token", () => {
    for (const channel of ["zevet:test"]) {
      const body = stripComments(handlerBody(channel));
      assert.match(body, /authFor\(/, `${channel} does not resolve the credential`);
      assert.match(body, /auth\.token/, `${channel} does not send the derived token`);
      assert.doesNotMatch(body, /"x-zevet-token":\s*String\(token\)/, `${channel} sends the typed value verbatim`);
    }
    // The SSE stream the collision notifier holds open is the third place, and
    // it is easy to forget because nothing about it looks like authentication.
    const watch = main.slice(main.indexOf("async function startCollisionWatch("));
    assert.match(watch.slice(0, 2000), /encodeURIComponent\(auth\.token\)/, "the events stream sends a raw token");
  });

  test("setup saves a master secret as `secret`, and keeps a legacy token only where one exists", () => {
    const body = stripComments(handlerBody("zevet:save"));
    assert.match(body, /writeConfig\(\{\s*hub,\s*secret:/, "setup does not save the master secret as `secret`");
    assert.match(body, /existing\.token/, "the legacy path no longer checks for an existing raw token");
    assert.doesNotMatch(
      body,
      /writeConfig\(\{\s*hub:[^}]*token:\s*String\(cfg\.token\)/,
      "setup still writes the typed value as a raw token",
    );
  });

  test("the credential resolver never loads secret.mjs from the hub's update directory", () => {
    // ~/.zevet/client is where the HUB pushes client files. A secret.mjs from
    // there could make deriveAuthToken return the master secret itself.
    const fn = main.slice(main.indexOf("function loadSecretModule("));
    const body = stripComments(fn.slice(0, fn.indexOf("\n}\n") + 3));
    assert.doesNotMatch(body, /CLIENT_DIR|HOME/, "secret.mjs may be loaded from the hub's update channel");
    assert.match(body, /process\.resourcesPath/, "the packaged copy is not looked for");
    assert.match(body, /__dirname/, "the checkout copy is not looked for");
  });

  test("the environment is ignored, so the board and the editor cannot disagree about who this is", () => {
    // doc-sync.js passes `env: {}`. If main.js honoured ZEVET_SECRET the board
    // could authenticate as one team while the editor derived another team's
    // document key, from the same running app.
    const fn = main.slice(main.indexOf("function authFor("));
    assert.match(fn.slice(0, 800), /resolveAuth\(\{\s*env:\s*\{\}/, "authFor lets the environment win");
  });
});

describe("the workspace guard is still in front of every new handler", () => {
  // `knownRoot` is the allowlist of folders the user picked with a native
  // dialog. Without it a compromised page names `C:\` as its root and every
  // containment check in local-fs.js then passes, because everything is inside
  // `C:\`. It is what makes "inside the workspace" mean anything.
  for (const channel of ["local:stats", "local:watch", "local:unwatch"]) {
    test(`${channel} calls knownRoot before it does anything else`, () => {
      const body = stripComments(handlerBody(channel));
      const guard = body.indexOf("knownRoot(root)");
      assert.ok(guard >= 0, `${channel} does not check the root against the allowlist`);
      for (const work of ["lineCounter.", "repoStats.", "fileWatch."]) {
        const at = body.indexOf(work);
        if (at >= 0) assert.ok(guard < at, `${channel} calls ${work} before knownRoot`);
      }
      // And it is the RESOLVED root that is used afterwards, not the
      // renderer's spelling — which is what the allowlist actually approved.
      assert.match(body, /const dir = knownRoot\(root\)/);
    });
  }

  test("local:stats holds one LineCounter for the app, not one per call", () => {
    // The cache is keyed on (size, mtime) and is the entire reason repo-stats
    // is a module. A fresh counter per call keeps the API and throws the cache
    // away: thousands of file reads a second while an agent is working.
    assert.match(main, /^const lineCounter = new repoStats\.LineCounter\(\);$/m, "no module-level LineCounter");
    const body = handlerBody("local:stats");
    assert.doesNotMatch(body, /new repoStats\.LineCounter\(/, "a LineCounter is constructed inside the handler");
    assert.match(body, /lineCounter\.countAll\(/);
  });

  test("local:stats caps how many paths one call can ask about", () => {
    // Counting is synchronous on the main process: an uncapped call freezes the
    // window, including its own close button, for as long as it takes.
    const body = handlerBody("local:stats");
    assert.match(main, /const MAX_STAT_PATHS = \d+/, "there is no cap");
    assert.match(body, /slice\(0, MAX_STAT_PATHS\)/, "the cap is declared but not applied");
    assert.match(body, /truncated:/, "a truncated answer does not say so");
  });

  test("local:stats converts the diff Map, because a Map does not survive IPC", () => {
    // A Map arrives in the renderer as an object with no entries, which reads
    // as "this repo has no changes" — a wrong answer that looks like a right
    // one. And `null` (git said nothing) must stay distinct from `{}` (a clean
    // tree), or "no git installed" is drawn as "nothing has changed".
    const body = handlerBody("local:stats");
    assert.match(body, /Object\.fromEntries\(byPath\)/, "the diff Map is shipped as a Map");
    assert.match(body, /ok \? Object\.fromEntries\(byPath\) : null/, "no-git and clean-tree are collapsed together");
  });
});

describe("every module main.js requires is actually in the installer", () => {
  test("nothing main.js requires is left out of build.files", () => {
    // ⚠️ THIS ONE FAILS ONLY IN A PACKAGED BUILD, which is the worst place for
    // a failure to first appear. `electron-builder` treats `files` as an
    // allowlist: a module that is required at the top of main.js and absent
    // from that array is simply not copied into the app, and the installed app
    // then dies on its first line with "Cannot find module ./repo-stats.js" —
    // a crash no test, no `npm start` and no code review would have caught,
    // because all three run from the checkout where the file is right there.
    //
    // It was already true of doc-sync.js and repo-stats.js when this was
    // written. Asserted from the require statements rather than from a list,
    // so the next module added needs no one to remember this file exists.
    const pkg = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
    const packaged = new Set(pkg.build.files);
    const required = [...stripComments(main).matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(required.length >= 4, `only found ${required.length} local requires — did the scrape break?`);
    for (const file of new Set(required)) {
      assert.ok(packaged.has(file), `main.js requires ./${file} and build.files does not ship it`);
    }
  });

  test("and nothing it reaches by path, or through another module, is either", () => {
    // ⚠️ THE SCRAPE ABOVE HAS A BLIND SPOT, and computer use walked straight
    // into it. `zevet-mcp.js` is never required — it is SPAWNED, by
    // `path.join(__dirname, "zevet-mcp.js")`, as the MCP server claude is
    // handed. And it requires `computer.js`, which main.js never mentions at
    // all. Neither would have been packaged, and neither absence shows up
    // anywhere but an installed build, where computer use would simply do
    // nothing and say nothing.
    //
    // So: follow both edges the first test cannot see — files named as a path
    // from __dirname, and the requires of every local module that is packaged,
    // transitively.
    const pkg = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
    const packaged = new Set(pkg.build.files);

    const byPath = [...stripComments(main).matchAll(/__dirname,\s*"([^"]+\.(?:js|mjs|cjs|json|html))"/g)].map((m) => m[1]);
    for (const file of new Set(byPath)) {
      assert.ok(packaged.has(file), `main.js reaches ./${file} by path and build.files does not ship it`);
    }

    // Transitive: what the shipped modules themselves pull in.
    const seen = new Set();
    const queue = [...packaged].filter((f) => /\.(js|mjs|cjs)$/.test(f));
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      let src;
      try {
        src = readFileSync(path.join(DESKTOP, file), "utf8");
      } catch {
        continue; // a glob or a directory entry, not a file we can read
      }
      for (const [, dep] of stripComments(src).matchAll(/require\("\.\/([^"]+)"\)/g)) {
        assert.ok(
          packaged.has(dep),
          `${file} requires ./${dep} and build.files does not ship it`,
        );
        if (!seen.has(dep)) queue.push(dep);
      }
    }
  });

  test("client/secret.mjs reaches the packaged app too", () => {
    // It is not in `files` and does not need to be: it lives outside desktop/
    // and rides along as an extraResource, which is where loadSecretModule()
    // looks first via process.resourcesPath. Asserted because the two have to
    // agree and they are declared in different files.
    const pkg = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
    const extra = pkg.build.extraResources.find((r) => r.from === "../client");
    assert.ok(extra, "client/*.mjs is not packaged, so nothing can derive a token");
    assert.equal(extra.to, "client");
    assert.ok(extra.filter.includes("*.mjs"));
    assert.match(main, /process\.resourcesPath, "client", "secret\.mjs"/);
  });
});

describe("the file watcher is wired to the window, not to the app", () => {
  test("changes are pushed to the board on local:fileChanged", () => {
    assert.match(main, /new FileWatch\(\{[\s\S]{0,200}toBoard\("local:fileChanged", evt\)/);
  });

  test("the watcher is given the resolved root, so events echo the approved path", () => {
    const body = stripComments(handlerBody("local:watch"));
    assert.match(body, /fileWatch\.watch\(dir,/, "the renderer's own spelling of the root is passed through");
  });

  test("unwatch for a root that is no longer known still unwatches", () => {
    /* ⚠️ THIS USED TO ASSERT `if (!dir) return { ok: true }`, which is the
       shape of the bug rather than the behaviour in the name. A workspace list
       can change under a renderer that is closing a tab, and unwatch only ever
       removes — so it must not FAIL, and equally it must not silently skip the
       removal. It did skip it, and leaked an fs.watch handle for the life of
       the app every time.

       So: no early return, and fileWatch.unwatch is reached on both paths. */
    const body = stripComments(handlerBody("local:unwatch"));
    assert.doesNotMatch(body, /if \(!dir\) return/, "an unknown root still skips the removal");
    assert.match(body, /fileWatch\.unwatch\(/, "nothing is ever unwatched");
    assert.match(body, /dir \|\|/, "there is no fallback for a root that left the allowlist");
  });
});
