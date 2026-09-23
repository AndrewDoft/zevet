// The only bridge between a renderer and this machine: named calls, no
// `require`, no `ipcRenderer` handle, nothing that takes a channel name from
// the page.
//
// This comment used to end "the board window has no preload at all, because it
// loads a remote origin". That has not been true since the workspace bridge was
// added, and main.js rewrote its own version of the same sentence rather than
// leave it to rot — a comment claiming a protection the code stopped providing
// is worse than no comment. What holds now is that BOTH windows get this
// preload, the board window does load a remote origin (the hub's own page), and
// every capability below is named, narrow and re-checked in the main process.
// `openBoard()` in main.js argues why that is acceptable at all.
//
// ⚠️ WHAT IS NOT HERE, AND MUST NOT BE. There is no call that returns the
// master secret, the derived auth token or the document key, and no handle to
// the DocSync instance. The board renderer runs code the HUB served, so
// anything readable from it is readable by the hub — and the hub is exactly who
// the document encryption keeps out. `window.zevet.config()` is redacted in the
// main process for the same reason (see `zevet:config` there). Adding a
// "give me the config" call that answers with a credential would quietly undo
// all of it.
const { contextBridge, ipcRenderer } = require("electron");

/**
 * Subscribe to a main-process push, and hand back the way to stop.
 *
 * ⚠️ RETURNING THE UNSUBSCRIBE IS NOT A COURTESY. `ipcRenderer` lives in this
 * preload's world, which SURVIVES nothing — but a renderer that registers a
 * listener on every component mount and never removes one accumulates them for
 * as long as the page lives, and every document update is then delivered N
 * times to N stale closures holding N dead Y.Docs. Node also starts printing
 * MaxListenersExceededWarning at eleven, which is the point at which this is
 * discovered by accident.
 *
 * A full page RELOAD is the one case that cleans up by itself: the old world is
 * destroyed and its listeners with it. Every other case — a tab closing, a
 * component unmounting, a room being left — is the renderer's to call.
 */
function subscribe(channel, fn) {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("zevet", {
  /**
   * The saved settings, REDACTED, or null on a first run.
   *
   * `{ hub, actor, hasSecret, legacy }` — never the secret and never the token.
   * `actor` is here because the board needs it to label a remote cursor with a
   * person's name rather than a client number, and a display name is not a
   * credential. See `zevet:config` in main.js for what this call used to return
   * and why it stopped.
   */
  config: () => ipcRenderer.invoke("zevet:config"),
  /** Ask the hub whether this URL and token actually work, before saving them. */
  test: (hub, token) => ipcRenderer.invoke("zevet:test", { hub, token }),
  /** Write ~/.zevet/config.json. */
  save: (hub, token, actor) => ipcRenderer.invoke("zevet:save", { hub, token, actor }),
  /**
   * Sign in with GitHub.
   *
   * `githubStart` resolves with `{ userCode, url }` as soon as GitHub has
   * issued a code, and the main process has already opened the browser on it.
   * `githubWait` then resolves when the person has clicked Authorize — up to
   * fifteen minutes later — and by the time it does, the config is written.
   *
   * ⚠️ NEITHER CALL RETURNS THE SECRET OR THE SESSION, on purpose and for the
   * same reason `config()` redacts them: the BOARD window loads HTML from the
   * hub, so anything on this bridge is something a hub that has been taken over
   * can read out of its own page. The renderer is told a login and a yes.
   */
  githubStart: (hub, team) => ipcRenderer.invoke("zevet:githubStart", { hub, team }),
  githubWait: () => ipcRenderer.invoke("zevet:githubWait"),
  githubCancel: () => ipcRenderer.invoke("zevet:githubCancel"),
  /** End this machine's GitHub session, hub-side and locally. */
  githubLogout: () => ipcRenderer.invoke("zevet:githubLogout"),
  /** Mint a brand new, independently-owned team on the given hub — see
   *  main.js's `zevet:teamCreate` and hub/server.mjs's `/team/create`.
   *  Resolves `{ ok, team }` or `{ ok: false, error }`. */
  teamCreate: (hub) => ipcRenderer.invoke("zevet:teamCreate", { hub }),
  /**
   * Sign in with Google.
   *
   * Same shape as the GitHub trio and one difference worth knowing: there is no
   * `userCode`, because Google's web flow never shows the person a code.
   * `googleStart` resolves with `{ url, domain }` once the hub has minted a
   * pairing code and the main process has opened the browser; `googleWait` then
   * resolves when the browser has come back to the hub, and by then the config
   * is written.
   *
   * ⚠️ NEITHER CALL RETURNS THE SECRET OR THE SESSION — the same rule as the
   * GitHub pair, for the same reason.
   */
  googleStart: (hub, team) => ipcRenderer.invoke("zevet:googleStart", { hub, team }),
  googleWait: () => ipcRenderer.invoke("zevet:googleWait"),
  googleCancel: () => ipcRenderer.invoke("zevet:googleCancel"),
  /** End this machine's session, hub-side and locally. A session does not
   *  remember which provider minted it, so this is the same call as
   *  `githubLogout` under the name the Google button expects. */
  googleLogout: () => ipcRenderer.invoke("zevet:googleLogout"),
  /**
   * Pairing with Masora (T5, docs/contracts/cross_app_context.md). Same
   * shape as the GitHub/Google trio above and the same reason for it: a code
   * has to paint immediately and then the flow sits for up to fifteen
   * minutes. `masoraPairWait` never returns the token -- it is written
   * straight to the OS keychain in the main process (masora.js) and this
   * bridge has no call that reads it back.
   */
  masoraConfig: () => ipcRenderer.invoke("zevet:masoraConfig"),
  masoraSaveUrl: (url) => ipcRenderer.invoke("zevet:masoraSaveUrl", { url }),
  masoraPairStart: () => ipcRenderer.invoke("zevet:masoraPairStart"),
  masoraPairWait: () => ipcRenderer.invoke("zevet:masoraPairWait"),
  masoraPairCancel: () => ipcRenderer.invoke("zevet:masoraPairCancel"),
  masoraUnpair: () => ipcRenderer.invoke("zevet:masoraUnpair"),
  /** Zevet Chat push to Masora (C1 `zevet_chat`), off by default. */
  masoraChatPush: (on) => ipcRenderer.invoke("zevet:masoraChatPush", { on }),
  /** Connections panel: which sources are linked, and connecting a new one.
      Channel names have no "zevet:" prefix -- they are `masora:sources` /
      `masora:connect`, matching main.js's own registration. */
  masoraSources: () => ipcRenderer.invoke("masora:sources"),
  masoraConnect: (arg) => ipcRenderer.invoke("masora:connect", arg),
  /** Native folder picker; resolves to a path or null. */
  pickRepo: () => ipcRenderer.invoke("zevet:pickRepo"),
  /** Install the hooks into that repo. */
  install: (repo) => ipcRenderer.invoke("zevet:install", repo),
  /** Setup is finished — open the board. */
  done: () => ipcRenderer.invoke("zevet:done"),
});

/**
 * The workspace surface, exposed to the BOARD window.
 *
 * This is what makes the desktop app more than a browser tab: it can read the
 * machine it is running on. The hub never receives a byte of anyone's source,
 * so a real file tree and real file contents can only come from here.
 *
 * Deliberately narrow: list a tree under a folder the user picked, read one
 * text file, write one text file back, start/stop an agent. No arbitrary path,
 * no `require`, no shell. The main process re-checks every path against the
 * chosen root anyway — a renderer is never trusted, and this bridge is a
 * convenience, not the guard.
 */
contextBridge.exposeInMainWorld("zevetLocal", {
  available: true,
  /** The folders this machine has opened, most recent first. */
  workspaces: () => ipcRenderer.invoke("local:workspaces"),
  /** Native folder picker; adds it to the list. */
  addWorkspace: () => ipcRenderer.invoke("local:addWorkspace"),
  /** C1's per-repo opt-in (`zevet.masoraRepos`), keyed by resolved folder
   *  path; default none. */
  masoraRepos: () => ipcRenderer.invoke("local:masoraRepos"),
  masoraRepoToggle: (root, on) => ipcRenderer.invoke("local:masoraRepoToggle", { root, on }),
  /** A file tree under one of those folders. */
  tree: (root) => ipcRenderer.invoke("local:tree", root),
  /** One text file, by path relative to its root. */
  read: (root, relPath) => ipcRenderer.invoke("local:read", { root, relPath }),
  /**
   * One text file back, by path relative to its root.
   *
   * SAID PLAINLY, because it changes what this bridge is: the board window
   * loads a REMOTE origin — the hub's own page — with this preload attached.
   * openBoard() in main.js sets out why that is considered acceptable (the hub
   * already ships the hook that runs on every teammate's machine, so it is
   * trusted with code execution already, and a narrow bridge makes a capability
   * it effectively had explicit and bounded instead of implicit).
   *
   * That reasoning was written about READING files. This adds writing them, and
   * the stakes of the same decision are now higher: a hostile hub page could
   * not merely see your source, it could change it, inside a folder you picked.
   * The decision stands and is not being reopened here. It is written down so
   * that whoever does reopen it is looking at the real stake.
   *
   * `opts` is `{ bom, eol }` as `read` reported them, so a file goes back the
   * way it came. main.js keeps only those two fields; nothing else crosses.
   */
  write: (root, relPath, text, opts) => ipcRenderer.invoke("local:write", { root, relPath, text, opts }),
  /** Added-line hunks for one file: `{ ok, hunks: [{start, count}] }`. Read-only
   *  git metadata about a picked folder — narrower than tree/read/write above. */
  diffHunks: (root, relPath) => ipcRenderer.invoke("local:diffHunks", { root, relPath }),
  /**
   * Line counts and git diff stats for a list of paths under one root.
   *
   * `{ ok, lines: {rel: number|null}, diff: {rel: {added, removed, status}} | null }`.
   * `lines[rel]` is null for a file that was not counted — too big, binary or
   * unreadable — which is a different thing from zero. `diff` is null when git
   * said nothing useful at all (not a repo, no git, a timeout); an EMPTY diff
   * object means a clean tree, and the two must not be drawn the same way.
   *
   * Capped in the main process at 2000 paths per call, with `truncated` saying
   * so. Counting is synchronous there, so an uncapped call from here could
   * freeze the window.
   */
  /**
   * The status strip's machine-side figures. `root` is optional and only
   * affects the branch segment; it is re-checked against the opened
   * workspaces in the main process, as every path on this bridge is.
   */
  /** Tell the native window what colour the page just became. */
  chrome: (spec) => ipcRenderer.invoke("ui:chrome", spec),

  /**
   * Staying current. `updateInstall` is the only one with a consequence, and
   * it is reachable only from a button the person presses -- nothing here
   * runs an installer on a timer. See desktop/app-update.js for what that
   * does per platform, and for what the published checksum does not buy.
   */
  updateStatus: () => ipcRenderer.invoke("app:updateStatus"),
  updateCheck: () => ipcRenderer.invoke("app:updateCheck"),
  updateInstall: () => ipcRenderer.invoke("app:updateInstall"),
  onUpdate: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("app:update", handler);
    return () => ipcRenderer.removeListener("app:update", handler);
  },

  /**
   * The code index. Every one of these is inert on a machine the capability
   * gate turned down, and `indexEnable` is the ONLY thing that fetches the
   * model -- nothing here starts a download on its own.
   */
  indexStatus: (root) => ipcRenderer.invoke("local:indexStatus", { root }),
  indexEnable: (root) => ipcRenderer.invoke("local:indexEnable", { root }),
  indexSearch: (root, query, opts) =>
    ipcRenderer.invoke("local:indexSearch", { root, query, ...(opts || {}) }),
  onIndexEvent: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("local:indexEvent", handler);
    return () => ipcRenderer.removeListener("local:indexEvent", handler);
  },
  status: (root) => ipcRenderer.invoke("local:status", { root }),
  stats: (root, relPaths) => ipcRenderer.invoke("local:stats", { root, relPaths }),
  commits: (root, limit) => ipcRenderer.invoke("local:commits", { root, limit }),
  memories: (root) => ipcRenderer.invoke("local:memories", { root }),
  /** Every agent session on this machine — claude and codex, terminal,
   *  desktop app and IDE alike. Read only. */
  sessions: (opts) => ipcRenderer.invoke("local:sessions", opts || {}),
  session: (source, slug, id, child) =>
    ipcRenderer.invoke("local:session", { source, slug, id, child }),
  /** The subagents a claude session spawned, each openable as `session(..., child)`. */
  sessionAgents: (slug, id) => ipcRenderer.invoke("local:sessionAgents", { slug, id }),
  /** A running console's title and (codex) real context, off its session file. */
  sessionLive: (source, id) => ipcRenderer.invoke("local:sessionLive", { source, id }),
  // Masora Voice: is it installed, and start it so its flow bar comes up.
  // See desktop/masora-voice.js for why there is no "start recording".
  /* The permission posture a new agent starts with, saved beside the zoom in
     ~/.zevet/config.json. Returns what is now stored, so the settings pane can
     show the truth rather than what it hoped for. */
  defaultMode: (mode) => ipcRenderer.invoke("local:defaultMode", mode),
  voiceStatus: () => ipcRenderer.invoke("local:voiceStatus"),
  voiceStart: () => ipcRenderer.invoke("local:voiceStart"),
  voiceMic: () => ipcRenderer.invoke("local:voiceMic"),
  resumeAgent: (agent, cwd, resumeFrom, opts) =>
    ipcRenderer.invoke("local:resumeAgent", { agent, cwd, resumeFrom, opts }),
  agentSettings: (root) => ipcRenderer.invoke("local:agentSettings", { root }),
  saveAgentSettings: (root, patch) => ipcRenderer.invoke("local:saveAgentSettings", { root, patch }),
  /** Every "zevet.*" localStorage key, mirrored on this machine so it follows
   *  the person across a reload, an app update, or a change of hub. */
  prefs: () => ipcRenderer.invoke("local:prefs"),
  setPref: (key, value) => ipcRenderer.invoke("local:setPref", { key, value }),
  /** Seed the mirror in one round trip — an existing user upgrading from a
   *  build without it has every pref sitting only in localStorage. */
  setPrefs: (entries) => ipcRenderer.invoke("local:setPrefs", { entries }),
  schedules: () => ipcRenderer.invoke("local:schedules"),
  scheduleSave: (s) => ipcRenderer.invoke("local:scheduleSave", { schedule: s }),
  scheduleRemove: (id) => ipcRenderer.invoke("local:scheduleRemove", { id }),
  scheduleToggle: (id) => ipcRenderer.invoke("local:scheduleToggle", { id }),
  /**
   * Tell me when something else changes this file on disk.
   *
   * THE SOMETHING ELSE IS THE POINT: Claude Code and Codex are editing these
   * files while the editor has them open. Without this the next keystroke
   * publishes the stale text over the agent's work and nothing anywhere reports
   * it. Idempotent — watching an already-watched file is a no-op, not a second
   * stream of events.
   */
  watch: (root, relPath, initialText) => ipcRenderer.invoke("local:watch", { root, relPath, initialText }),
  unwatch: (root, relPath) => ipcRenderer.invoke("local:unwatch", { root, relPath }),
  /**
   * `fn({ root, relPath, text, bytes, bom, eol })`; returns an unsubscribe.
   *
   * `bom` and `eol` are carried so they can be handed straight back to `write`:
   * a file that arrived with a BOM and CRLF has to be saved that way or the
   * next commit is a whole-file diff blamed on whoever pressed save.
   *
   * A DELETED file produces no event. There is no text to carry and sending an
   * empty string would tell the editor to publish an empty document — the exact
   * clobber this exists to prevent. See `fire()` in desktop/file-watch.js.
   */
  onFileChanged: (fn) => subscribe("local:fileChanged", fn),
  /** A due schedule just ran (or was skipped); the board's own list is
      otherwise only refreshed after a save/toggle/remove round-trip. */
  onSchedulesChanged: (fn) => subscribe("local:schedulesChanged", fn),
  /** Which agents are installed on this machine. */
  agents: () => ipcRenderer.invoke("local:agents"),
  /** Start an agent in a folder. Returns { ok, id }. */
  startAgent: (agent, cwd, opts) => ipcRenderer.invoke("local:startAgent", { agent, cwd, opts }),
  sendToAgent: (id, text) => ipcRenderer.invoke("local:sendToAgent", { id, text }),
  stopAgent: (id) => ipcRenderer.invoke("local:stopAgent", id),
  /** The consoles still held by this app, with every event each has sent —
   *  what a reloaded board replays to pick them back up. */
  consoles: () => ipcRenderer.invoke("local:consoles"),
  forgetAgent: (id) => ipcRenderer.invoke("local:forgetAgent", id),
  /* Zevet Chat (desktop/chat.js): repo-independent conversations. */
  chatList: (query) => ipcRenderer.invoke("chat:list", { query }),
  chatGet: (id) => ipcRenderer.invoke("chat:get", id),
  chatCreate: () => ipcRenderer.invoke("chat:create"),
  chatRename: (id, title) => ipcRenderer.invoke("chat:rename", { id, title }),
  chatRemove: (id) => ipcRenderer.invoke("chat:remove", id),
  chatSend: (id, text, opts) => ipcRenderer.invoke("chat:send", { id, text, opts }),
  chatStop: (id) => ipcRenderer.invoke("chat:stop", id),
  onChatEvent: (fn) => subscribe("chat:event", fn),
  /** Stream of console events; returns an unsubscribe function. */
  onAgentEvent: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("local:agentEvent", handler);
    return () => ipcRenderer.removeListener("local:agentEvent", handler);
  },
  /* An agent is asking to do something and is BLOCKED until the answer comes
     back — see the computer-use block in main.js. The board is the only place
     a person can be asked, so this is not a notification. */
  onPermitRequest: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("local:permitRequest", handler);
    return () => ipcRenderer.removeListener("local:permitRequest", handler);
  },
  permitAnswer: (id, allow, reason) =>
    ipcRenderer.invoke("local:permitAnswer", { id, allow, reason }),
  /* An agent has asked the PERSON something (not a yes/no permission — a
     question with its own options) and is blocked on the answer. Same shape
     as the permit channel above, different event names. */
  onAskRequest: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on("local:askRequest", handler);
    return () => ipcRenderer.removeListener("local:askRequest", handler);
  },
  askAnswer: (id, picked) => ipcRenderer.invoke("local:askAnswer", { id, picked }),
});

/**
 * Whatever arrived, as a real `Uint8Array` of exactly the right length.
 *
 * ⚠️ WHY THIS EXISTS RATHER THAN A CAST. `bytes` starts life in the main
 * process as a Node `Buffer` (that is what `doc-crypto.open()` returns) and
 * crosses two boundaries to get here: Electron's IPC structured clone, and then
 * contextBridge's own clone into the renderer's world. main.js already copies
 * it into a plain `Uint8Array` before the first of those — a `Buffer` is a view
 * over Node's shared 8 KiB pool, and cloning the view drags the whole pool
 * along. This is the second guard, on the second boundary, and it is here
 * because the contract this bridge publishes says `Uint8Array` and a renderer
 * calling `Y.applyUpdate` with anything else fails at a depth nobody will
 * enjoy.
 *
 * WHAT WAS ACTUALLY MEASURED, on Electron 38.1.2 / Windows 11, by running a
 * throwaway app that sent a real pooled `Buffer` from main and printed what
 * arrived at each hop:
 *
 *   • main → preload: a `Buffer` arrives as a PLAIN `Uint8Array`. Not a
 *     Buffer — `Buffer.isBuffer` is false and `constructor.name` is
 *     "Uint8Array" — so nothing here may assume Buffer methods exist.
 *   • preload → renderer, through contextBridge: a `Uint8Array` arrives as a
 *     `Uint8Array` for which `instanceof Uint8Array` is TRUE in the renderer's
 *     own realm, with the right values and an exact-length backing buffer.
 *   • renderer → main, via `invoke`: also a plain `Uint8Array`.
 *
 * So on this platform the FIRST branch is the one that fires and the rest are
 * insurance. That probe was a scratch app and is NOT in the gate (this repo has
 * no Electron harness; the gate asserts against this file's SOURCE, which is
 * the precedent test/desktop-packaging.test.mjs set), and it has NOT been run
 * on macOS or Linux. The normalisation stays unconditional for that reason: it
 * costs nothing when the type is already right.
 */
function toUint8(value) {
  if (value instanceof Uint8Array) {
    // A VIEW OVER A BIGGER BUFFER IS COPIED, for the reason measured in the
    // probe above: the clone carries the whole backing store, not the window
    // onto it, so a 3-byte view over Node's 8 KiB pool put 8192 bytes on the
    // wire. The same hazard exists going the other way — a Yjs encoder that
    // hands back a subarray of a larger scratch buffer would ship the scratch
    // buffer. When the view already owns its buffer exactly this is a pointer
    // comparison and nothing is copied.
    return value.byteLength === value.buffer.byteLength ? value : new Uint8Array(value);
  }
  // A Buffer is a Uint8Array subclass, so it never reaches here; a Uint8Array
  // from ANOTHER JavaScript realm is not `instanceof` this one's, and that is
  // precisely what a cross-world clone could hand over.
  if (ArrayBuffer.isView(value)) {
    /* ⚠️ COPIED, NOT RE-VIEWED. This returned
       `new Uint8Array(value.buffer, value.byteOffset, value.byteLength)`,
       which is still a VIEW over the original store — so it walked straight
       into the hazard the branch above spells out and was written to prevent,
       in the branch that handles the case that comment names as the likely
       source. The inner call takes the window, the outer copies it. */
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  /* `instanceof` is false for ANOTHER REALM's ArrayBuffer, and an ArrayBuffer
     has no `length`, so a cross-realm one fell past the array-like check below
     and became `new Uint8Array(0)`: doc:send synced nothing and reported no
     error. The brand check is realm-independent. */
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value);
  }
  // An array-like `{0:…, 1:…, length:n}` is what a structured clone that lost
  // the type would look like. `Uint8Array.from` reads it correctly; a plain
  // `new Uint8Array(obj)` would silently produce a zero-length array, which
  // would sync nothing and report no error at all.
  if (value && typeof value.length === "number") return Uint8Array.from(value);
  return new Uint8Array(0);
}

/**
 * The shared document, exposed to the BOARD window.
 *
 * The split is deliberate and is described at length in desktop/doc-sync.js:
 * the renderer owns the Y.Doc, CodeMirror and awareness and sees only
 * PLAINTEXT; the main process owns the key and the socket and is the only
 * place ciphertext exists. Nothing on this object can be used to recover the
 * key — `send` takes bytes and gives back a boolean, `onMessage` hands out
 * bytes, and there is no accessor for anything in between.
 *
 * ⚠️ HOW TO TELL THE TWO FAILURES APART, because they have opposite remedies:
 *
 *   `join` resolving `{ok:false}` is ALWAYS a broken or legacy INSTALL — this
 *   machine has no master secret, or one that is not usable. Nothing in that
 *   path touches the network, so it is never about the hub. It will not fix
 *   itself and a retry button is the wrong answer; re-running setup is the
 *   right one. `code` says `setup-required`, or `unavailable` for a build that
 *   cannot sync at all (a missing crypto module), and `error` is a sentence
 *   written to be shown to a person.
 *
 *   THE HUB BEING DOWN never fails `join`. The join succeeds, the socket
 *   retries behind it with backoff, and the only place it shows up is
 *   `onStatus` — `connecting`, `retrying`, `open`, and `undecipherable` for a
 *   frame from a teammate on a different secret. That one does fix itself and
 *   is worth waiting out.
 */
contextBridge.exposeInMainWorld("zevetDoc", {
  available: true,
  /** Join a room and start receiving it. `{ ok, error?, code? }`. */
  join: (room) => ipcRenderer.invoke("doc:join", room),
  /**
   * Send one plaintext Yjs update. `opts.snapshot` marks it as a full state
   * that the hub may replace the room's whole log with — which is what keeps
   * a long-lived room from being trimmed out from under a late joiner.
   */
  send: (room, u8, opts) => ipcRenderer.invoke("doc:send", { room, bytes: toUint8(u8), opts }),
  /** Leave. Always `{ ok: true }`; leaving a room never joined is what a
   *  closing tab does and is not worth an error. */
  leave: (room) => ipcRenderer.invoke("doc:leave", room),
  /**
   * `fn({ room, kind, bytes? })`; returns an unsubscribe.
   *
   *   `ready`         the socket is open and joined — send your full state now,
   *                   which is what seeds an empty room and what gets offline
   *                   edits to everyone else.
   *   `update`        `bytes` is a plaintext Yjs update from a teammate.
   *   `snapshot-due`  send your whole document with `{snapshot:true}`.
   *
   * ⚠️ `ready` FIRES ON EVERY RECONNECT, not once. After a hub restart the
   * renderer is asked for its state again, and that is the mechanism by which
   * the room refills rather than a duplicate to be filtered out.
   */
  onMessage: (fn) =>
    subscribe("doc:message", (payload) =>
      fn(payload && payload.bytes ? { ...payload, bytes: toUint8(payload.bytes) } : payload),
    ),
  /** `fn({ room, state, detail })`; returns an unsubscribe. The ONLY place a
   *  connection problem is reported — an editor that silently stops syncing is
   *  this project's worst failure, so the status is a first-class output. */
  onStatus: (fn) => subscribe("doc:status", fn),
});
