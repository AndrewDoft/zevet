"use strict";
// THE IPC TABLE: the one place a bridge call is written down.
//
// From this table, `npm run ipc:gen` (the kit's desktop-kit-ipc) generates
//   desktop/preload.js                     the contextBridge exposure (what a page can call)
//   board/src/lib/bridge.generated.d.ts    the types board/src/lib/bridge.ts re-exports
// and desktop/main.js registers every handler through the same table
// (createIpcRegistry: a channel that is not here is refused, and one nobody
// handled fails at startup). `npm test` runs `--check`, so a hand edit of
// either generated file, or a table change nobody regenerated, fails.
//
// Entry fields: `channel`; `params` (names, in order); `pack: "object"` sends
// them as one { name: value } object, `payload` sends an expression instead;
// `type` is the board's TypeScript view of the call and `optional` says an older
// desktop build may not have it (the hub serves one board to whatever build is
// installed); `doc` lands in both outputs.
const { defineIpc } = require("@masora/desktop-kit");

const zevet = defineIpc({
  global: "zevet",
  typeName: "ZevetBridge",
  // Error reporting (Sentry) for the preload realm and setup.html; not an IPC call, so it rides as verbatim prelude.
  prelude: `// Error reporting for BOTH renderer realms this preload runs in front of.
//
// \`@sentry/electron/preload\` (required for its side effect) hooks up IPC to
// the main process and, under contextIsolation, exposes it to the PAGE's own
// world via contextBridge -- that is what lets board/src's and setup.html's
// own \`Sentry.init()\` (a separate realm each, see below) reach the main
// process at all, remote origin or not.
//
// \`@sentry/electron/renderer\`'s own \`init()\` HERE, in the preload's realm, is
// a second, independent thing: contextIsolation gives the preload script its
// own JS realm, and per Sentry's own Electron guide an uncaught exception in
// THAT realm is invisible to a Sentry client initialized only in the page --
// each realm needs its own client to catch its own errors.
//
// NO dsn/release/environment HERE: passing them to the renderer init is
// deprecated in this SDK version (verified against node_modules/@sentry/
// electron/renderer/sdk.js) precisely because every renderer sends through
// the MAIN process's own client over IPC -- the main process is what
// actually holds the DSN (desktop/sentry.js) and what scrubs and tags every
// event, this one included, via its own beforeSend. Passing a real DSN here
// would be inert at best, misleading at worst (implying this realm talks to
// Sentry directly, which it never does).
// This file lives in the payload, outside the asar where node_modules is, so bare specifiers do not resolve
// from here: main passes the shell's directory (bootstrap.js) and packages are resolved from there.
const shellDir = (process.argv.find((a) => a.startsWith("--zevet-shell-dir=")) || "").slice("--zevet-shell-dir=".length);
const shellRequire = shellDir ? require("node:module").createRequire(require("node:path").join(shellDir, "bootstrap.js")) : require;
shellRequire("@sentry/electron/preload");
let SentryPreload = null;
try {
  SentryPreload = shellRequire("@sentry/electron/renderer");
  SentryPreload.init({ sendDefaultPii: false });
  SentryPreload.setTag("realm", "preload");
} catch (err) {
  // Error reporting must never be why the app fails to start.
  console.error(\`zevet: preload Sentry init failed: \${err.message}\`);
}

/**
 * setup.html has no bundler, so it cannot import \`@sentry/electron/renderer\`
 * itself the way board/src does (lib/sentry.ts) -- it forwards through this
 * instead, to the SAME preload-realm client just initialized above, tagged so
 * it reads apart from a genuine preload-script error.
 *
 * \`reportError\` rebuilds a plain \`Error\` on THIS side rather than accepting
 * one across the bridge: contextBridge structured-clones its arguments, and
 * an \`Error\` that crossed that boundary is not reliably still an \`Error\` --
 * rebuilding from \`{message, stack}\` is what makes the shape predictable.
 */
contextBridge.exposeInMainWorld("zevetSentry", {
  reportError: (info) => {
    if (!SentryPreload) return;
    try {
      const err = new Error(String((info && info.message) || "renderer error"));
      if (info && typeof info.stack === "string") err.stack = info.stack;
      SentryPreload.captureException(err, { tags: { realm: "renderer-page" } });
    } catch {
      // Reporting must never throw back into the page.
    }
  },
  reportMessage: (message) => {
    if (!SentryPreload) return;
    try {
      SentryPreload.captureMessage(String(message || ""), { tags: { realm: "renderer-page" } });
    } catch {
      // Reporting must never throw back into the page.
    }
  },
});`,
  declareWindow: false, // board/src/lib/bridge.ts declares the (looser, optional) Window shape
  dtsHeader: `import type { SessionsResult, SessionResult, SessionAgentsResult } from "./sessions.d.mts";
import type { LocalWorkspace, LocalEntry, UsableAgent, ColorThemeSpec } from "./types";
import type { ReadResult, StartAgentResult, StatsResult, AgentSchedule, SchedulesResult, CommitsResult, IndexSearchResult, MemoriesResult, PermitRequest, AgentSettings, AgentSettingsResult, StatusResult, AskRequest, AgentEvent, AgentIntegration, HeldConsole, ChatSummary, StoredChat, ZevetConfig } from "./bridge";`,
  header: `The only bridge between a renderer and this machine: named calls, no
\`require\`, no \`ipcRenderer\` handle, nothing that takes a channel name from
the page.

This comment used to end "the board window has no preload at all, because it
loads a remote origin". That has not been true since the workspace bridge was
added, and main.js rewrote its own version of the same sentence rather than
leave it to rot — a comment claiming a protection the code stopped providing
is worse than no comment. What holds now is that BOTH windows get this
preload, the board window does load a remote origin (the hub's own page), and
every capability below is named, narrow and re-checked in the main process.
\`openBoard()\` in main.js argues why that is acceptable at all.

⚠️ WHAT IS NOT HERE, AND MUST NOT BE. There is no call that returns the
master secret, the derived auth token or the document key, and no handle to
the DocSync instance. The board renderer runs code the HUB served, so
anything readable from it is readable by the hub — and the hub is exactly who
the document encryption keeps out. \`window.zevet.config()\` is redacted in the
main process for the same reason (see \`zevet:config\` there). Adding a
"give me the config" call that answers with a credential would quietly undo
all of it.

Subscribe to a main-process push, and hand back the way to stop.

⚠️ RETURNING THE UNSUBSCRIBE IS NOT A COURTESY. \`ipcRenderer\` lives in this
preload's world, which SURVIVES nothing — but a renderer that registers a
listener on every component mount and never removes one accumulates them for
as long as the page lives, and every document update is then delivered N
times to N stale closures holding N dead Y.Docs. Node also starts printing
MaxListenersExceededWarning at eleven, which is the point at which this is
discovered by accident.

A full page RELOAD is the one case that cleans up by itself: the old world is
destroyed and its listeners with it. Every other case — a tab closing, a
component unmounting, a room being left — is the renderer's to call.`,
  calls: {
    config: { channel: "zevet:config", params: [], type: `() => Promise<ZevetConfig | null | undefined>`, doc: `The saved settings, REDACTED, or null on a first run.

\`{ hub, actor, hasSecret, legacy }\` — never the secret and never the token.
\`actor\` is here because the board needs it to label a remote cursor with a
person's name rather than a client number, and a display name is not a
credential. See \`zevet:config\` in main.js for what this call used to return
and why it stopped.` },
    test: { channel: "zevet:test", params: [["hub","unknown"],["token","unknown"]], pack: "object", returns: "Promise<unknown>", optional: true, doc: `Ask the hub whether this URL and token actually work, before saving them.` },
    save: { channel: "zevet:save", params: [["hub","unknown"],["token","unknown"],["actor","unknown"]], pack: "object", returns: "Promise<unknown>", optional: true, doc: `Write ~/.zevet/config.json.` },
    githubStart: { channel: "zevet:githubStart", params: ["hub","team"], pack: "object", type: `(hub?: string | null, team?: string) => Promise<{ ok?: boolean; error?: string; userCode?: string }>`, doc: `Sign in with GitHub.

\`githubStart\` resolves with \`{ userCode, url }\` as soon as GitHub has
issued a code, and the main process has already opened the browser on it.
\`githubWait\` then resolves when the person has clicked Authorize — up to
fifteen minutes later — and by the time it does, the config is written.

⚠️ NEITHER CALL RETURNS THE SECRET OR THE SESSION, on purpose and for the
same reason \`config()\` redacts them: the BOARD window loads HTML from the
hub, so anything on this bridge is something a hub that has been taken over
can read out of its own page. The renderer is told a login and a yes.` },
    githubWait: { channel: "zevet:githubWait", params: [], type: `() => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; login?: string }>` },
    githubCancel: { channel: "zevet:githubCancel", params: [], type: `() => void` },
    githubLogout: { channel: "zevet:githubLogout", params: [], type: `() => Promise<{ ok?: boolean; error?: string } | null | undefined>`, optional: true, doc: `End this machine's GitHub session, hub-side and locally.` },
    teamCreate: { channel: "zevet:teamCreate", params: [["hub","unknown"],["name","unknown"]], pack: "object", returns: "Promise<unknown>", optional: true, doc: `Mint a brand new, independently-owned team on the given hub — see
 main.js's \`zevet:teamCreate\` and hub/server.mjs's \`/team/create\`.
 Resolves \`{ ok, team }\` or \`{ ok: false, error }\`.` },
    teamResolve: { channel: "zevet:teamResolve", params: [["hub","unknown"],["name","unknown"]], pack: "object", returns: "Promise<unknown>", optional: true },
    teamJoin: { channel: "zevet:teamJoin", params: [["team","unknown"],["key","unknown"]], pack: "object", returns: "Promise<unknown>", optional: true, doc: `Redeem a per-invitee key — hub/server.mjs's \`/team/join\`. Resolves
 \`{ ok, login, owner, teamName }\` or \`{ ok: false, error }\`; the secret
 and session are written to config by the main process and never handed
 to this window, same rule as githubWait/googleWait above.` },
    googleStart: { channel: "zevet:googleStart", params: ["hub","team"], pack: "object", type: `(hub?: string | null, team?: string) => Promise<{ ok?: boolean; error?: string; url?: string; expiresIn?: number; domain?: string }>`, optional: true, doc: `Sign in with Google.

Same shape as the GitHub trio and one difference worth knowing: there is no
\`userCode\`, because Google's web flow never shows the person a code.
\`googleStart\` resolves with \`{ url, domain }\` once the hub has minted a
pairing code and the main process has opened the browser; \`googleWait\` then
resolves when the browser has come back to the hub, and by then the config
is written.

⚠️ NEITHER CALL RETURNS THE SECRET OR THE SESSION — the same rule as the
GitHub pair, for the same reason.

The same three calls for Google. The flow differs — the hub owns the
callback, so \`googleStart\` hands back a URL to open rather than a code to
type — but the app's side of it is the same start / wait / cancel.` },
    googleWait: { channel: "zevet:googleWait", params: [], type: `() => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; login?: string; owner?: boolean }>`, optional: true },
    googleCancel: { channel: "zevet:googleCancel", params: [], type: `() => void`, optional: true },
    googleLogout: { channel: "zevet:googleLogout", params: [], type: `() => Promise<{ ok?: boolean; error?: string } | null | undefined>`, optional: true, doc: `End this machine's session, hub-side and locally. A session does not
 remember which provider minted it, so this is the same call as
 \`githubLogout\` under the name the Google button expects.` },
    microsoftStart: { channel: "zevet:microsoftStart", params: ["hub","team"], pack: "object", type: `(hub?: string | null, team?: string) => Promise<{ ok?: boolean; error?: string; url?: string; expiresIn?: number; domain?: string }>`, optional: true, doc: `Sign in with Microsoft (Entra ID or a personal Microsoft account). Exactly
Google's shape — the hub owns the callback, so \`microsoftStart\` hands back a URL
opened by the main process and \`microsoftWait\` resolves once the config is written.
Neither call returns the secret or the session.` },
    microsoftWait: { channel: "zevet:microsoftWait", params: [], type: `() => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; login?: string; owner?: boolean }>`, optional: true },
    microsoftCancel: { channel: "zevet:microsoftCancel", params: [], type: `() => void`, optional: true },
    microsoftLogout: { channel: "zevet:microsoftLogout", params: [], type: `() => Promise<{ ok?: boolean; error?: string } | null | undefined>`, optional: true, doc: `End this machine's session; the same call as \`githubLogout\` and \`googleLogout\`.` },
    sendReport: { channel: "zevet:sendReport", params: ["text"], pack: "object", type: `(text: string) => Promise<{ ok: boolean }>`, optional: true, doc: `Send what the person typed plus the scrubbed tail of the app log to Sentry. \`{ ok }\`.` },
    signOutTeam: { channel: "zevet:signOutTeam", params: [], type: `() => Promise<{ ok?: boolean; error?: string } | null | undefined>`, optional: true, doc: `Leave the team entirely: ends the hub session, then drops session,
 secret AND hub from config.json (backed up first) so this machine
 falls back to first-run setup. See main.js's \`signOutTeam\`.

Leave the team on this machine — drops session, secret and hub from
 config.json (backed up first) and returns to first-run setup.` },
    masoraConfig: { channel: "zevet:masoraConfig", params: [], type: `() => Promise<{ url: string; paired: boolean; member?: string; repos: Record<string, boolean>; chat?: boolean }>`, optional: true, doc: `Linking with Masora (T5, docs/contracts/cross_app_context.md). The link
runs in the main process in the background; the renderer reads its status
and can retry or open the approval page. The token is written straight to
the OS keychain there and this bridge has no call that reads it back.

Linking with Masora (T5, docs/contracts/cross_app_context.md). The link
runs in the background in the main process; this reads its status. No call
returns a token -- it is written straight to the OS keychain there.` },
    masoraSaveUrl: { channel: "zevet:masoraSaveUrl", params: ["url"], pack: "object", type: `(url: string) => Promise<{ url: string; paired: boolean; repos: Record<string, boolean> }>`, optional: true },
    masoraLinkStatus: { channel: "zevet:masoraLinkStatus", params: [], type: `() => Promise<{ phase: string; paired?: boolean; code?: string; error?: string }>`, optional: true },
    masoraLinkStart: { channel: "zevet:masoraLinkStart", params: [], type: `() => Promise<{ phase: string; paired?: boolean; code?: string; error?: string }>`, optional: true },
    masoraLinkApprove: { channel: "zevet:masoraLinkApprove", params: [], type: `() => Promise<boolean>`, optional: true },
    masoraUnpair: { channel: "zevet:masoraUnpair", params: [], type: `() => Promise<boolean>`, optional: true },
    reportingStatus: { channel: "zevet:reportingStatus", params: [], type: `() => Promise<{ problem: string }>`, optional: true, doc: `Settings: the one line saying why this machine's agents are not reaching the team hub, or an empty string when they are.` },
    familyStatus: { channel: "zevet:familyStatus", params: [], type: `() => Promise<unknown[]>`, optional: true, doc: `Family panel: one row per sibling app, and the click on its chip.

Family panel (desktop/family.js).` },
    familyAct: { channel: "zevet:familyAct", params: ["app","action"], pack: "object", type: `(app: string, action: string) => Promise<{ ok?: boolean; download?: string | null; requested?: boolean; pairing?: string } | undefined>`, optional: true },
    masoraChatPush: { channel: "zevet:masoraChatPush", params: ["on"], pack: "object", type: `(on: boolean) => Promise<{ url: string; paired: boolean; repos: Record<string, boolean>; chat?: boolean }>`, optional: true, doc: `Zevet Chat push to Masora (C1 \`zevet_chat\`), off by default.` },
    masoraSources: { channel: "masora:sources", params: [], type: `() => Promise<{ sources?: { kind: string; status: string }[]; error?: string }>`, optional: true, doc: `Connections panel: which sources are linked, and connecting a new one.
Channel names have no "zevet:" prefix -- they are \`masora:sources\` /
\`masora:connect\`, matching main.js's own registration.

Connections panel: linked-source status, and connecting a new one.` },
    masoraConnect: { channel: "masora:connect", params: ["arg"], type: `(arg: { provider: string }) => Promise<{ ok?: boolean; error?: string }>`, optional: true },
    listCredentials: { channel: "zevet:listCredentials", params: [], type: `() => Promise<{
    ok?: boolean;
    credentials?: Array<{
      id: string;
      scope: "team" | "personal";
      label: string;
      provider: string;
      kind: string;
      last4: string;
      addedBy?: string;
      createdAt?: string;
    }>;
    default?: { scope: "team" | "personal" | "auto"; id?: string } | null;
    error?: string;
  }>`, optional: true, doc: `Model credentials (D-0NN). \`listCredentials\` merges team (fetched from
the hub) and personal (this machine's own safeStorage-encrypted store,
desktop/credentials.js) into one metadata-only list, plus the member's
chosen default. \`addCredential\`/\`removeCredential\` take \`{scope}\` of
"team" or "personal"; a personal secret never crosses this bridge except
as the \`key\` the person just typed, going IN.

Model credentials (D-0NN): team (hub-held) and personal (this machine
 only, safeStorage-encrypted) merged into one metadata-only list, never
 a secret. \`default\` is this member's chosen spawn credential, if any —
 {scope:"personal"|"team", id} or {scope:"auto"} to use the ladder.` },
    addCredential: { channel: "zevet:addCredential", params: ["arg"], type: `(arg: {
    scope: "team" | "personal";
    label?: string;
    provider: string;
    kind: string;
    key: string;
  }) => Promise<{ ok?: boolean; id?: string; error?: string }>`, optional: true },
    removeCredential: { channel: "zevet:removeCredential", params: ["arg"], type: `(arg: { scope: "team" | "personal"; id: string }) => Promise<{ ok?: boolean; error?: string }>`, optional: true },
    setDefaultCredential: { channel: "zevet:setDefaultCredential", params: ["arg"], type: `(
    arg: { scope: "team" | "personal"; id: string } | { scope: "auto" } | null,
  ) => Promise<{ ok?: boolean; default?: unknown }>`, optional: true },
    credentialLadder: { channel: "zevet:credentialLadder", params: [], type: `() => Promise<Array<{ credentialId: string; untilPct: number }>>`, optional: true, doc: `"Auto" mode's rotation ladder — an ordered [{credentialId, untilPct}].
 See desktop/credential-ladder.js for how it is walked.

The "Auto" rotation ladder — an ordered list of {credentialId, untilPct}.` },
    setCredentialLadder: { channel: "zevet:setCredentialLadder", params: ["ladder"], type: `(
    ladder: Array<{ credentialId: string; untilPct: number }>,
  ) => Promise<{ ok?: boolean; ladder?: Array<{ credentialId: string; untilPct: number }> }>`, optional: true },
    pickRepo: { channel: "zevet:pickRepo", params: [], returns: "Promise<unknown>", optional: true, doc: `Native folder picker; resolves to a path or null.` },
    install: { channel: "zevet:install", params: [["repo","unknown"]], returns: "Promise<unknown>", optional: true, doc: `Install the hooks into that repo.` },
    done: { channel: "zevet:done", params: [], returns: "Promise<unknown>", optional: true, doc: `Setup is finished — open the board.` },
  },
  events: {
  },
});

const zevetLocal = defineIpc({
  global: "zevetLocal",
  typeName: "LocalBridge",
  declareWindow: false, // board/src/lib/bridge.ts declares the (looser, optional) Window shape
  prelude: `// The workspace surface, exposed to the BOARD window.
//
// This is what makes the desktop app more than a browser tab: it can read the
// machine it is running on. The hub never receives a byte of anyone's source,
// so a real file tree and real file contents can only come from here.
//
// Deliberately narrow: list a tree under a folder the user picked, read one
// text file, write one text file back, start/stop an agent. No arbitrary path,
// no \`require\`, no shell. The main process re-checks every path against the
// chosen root anyway — a renderer is never trusted, and this bridge is a
// convenience, not the guard.`,
  constants: { available: { value: true, type: "boolean" } },
  calls: {
    workspaces: { channel: "local:workspaces", params: [], type: `() => Promise<LocalWorkspace[]>`, doc: `The folders this machine has opened, most recent first.` },
    addWorkspace: { channel: "local:addWorkspace", params: [], type: `() => Promise<LocalWorkspace | null>`, doc: `Native folder picker; adds it to the list.` },
    masoraRepos: { channel: "local:masoraRepos", params: [], type: `() => Promise<Record<string, boolean>>`, optional: true, doc: `C1's per-repo opt-in (\`zevet.masoraRepos\`), keyed by resolved folder
 path; default none.

C1's per-repo opt-in, keyed by resolved folder path; default none.` },
    masoraRepoToggle: { channel: "local:masoraRepoToggle", params: ["root","on"], pack: "object", type: `(root: string, on: boolean) => Promise<{ ok: boolean; error?: string; repos?: Record<string, boolean> }>`, optional: true },
    tree: { channel: "local:tree", params: ["root"], type: `(dir: string) => Promise<{ ok: boolean; entries?: LocalEntry[]; truncated?: boolean; origin?: string; error?: string }>`, doc: `A file tree under one of those folders.` },
    overlapCheck: { channel: "local:overlapCheck", params: ["input"], pack: "object", type: `(input: { task: string; branch: string; repo: string; session: string; openPaths: string[]; plannedPaths: string[]; active: unknown[] }) => Promise<{ ok: boolean; hits: Array<{ actor: string; session: string; label: "overlapping" | "adjacent"; claimed?: boolean }> }>`, optional: true, doc: `The pre-prompt overlap check (D-070): the task against every agent the board knows and every claim, locally.` },
    claim: { channel: "local:claim", params: ["input"], pack: "object", type: `(input: { root: string; paths: string[]; session: string; actor?: string; auto?: boolean }) => Promise<{ ok: boolean; claim?: unknown; shared?: boolean; error?: string }>`, optional: true, doc: `Advisory claim of paths for one agent session; sealed and shared with the team. Never blocks a write.` },
    releaseClaims: { channel: "local:releaseClaims", params: ["session","path"], pack: "object", type: `(session: string, path?: string) => Promise<{ ok: boolean }>`, optional: true, doc: `Release one path, or every path of a session when none is given.` },
    memoryList: { channel: "local:memoryList", params: ["input"], pack: "object", type: `(input: { root: string; path?: string }) => Promise<{ ok: boolean; notes: Array<{ id: string; repo: string; path: string; text: string; hash: string; author: string; createdAt: number; updatedAt: number; retired: boolean; stale: "fresh" | "stale" | "missing" | "unknown" }>; error?: string }>`, optional: true, doc: `Pinned notes for a folder (or one file), each flagged stale when the file's hash moved. Computed locally.` },
    memoryCreate: { channel: "local:memoryCreate", params: ["input"], pack: "object", type: `(input: { root: string; path: string; text: string }) => Promise<{ ok: boolean; note?: unknown; error?: string }>`, optional: true, doc: `Pin a note to a file at its current hash; sealed with the document key.` },
    memoryEdit: { channel: "local:memoryEdit", params: ["input"], pack: "object", type: `(input: { root: string; id: string; text?: string; rehash?: boolean }) => Promise<{ ok: boolean; note?: unknown; error?: string }>`, optional: true, doc: `Edit a note; rehash re-pins it to the file as it is now.` },
    memoryRetire: { channel: "local:memoryRetire", params: ["input"], pack: "object", type: `(input: { root: string; id: string }) => Promise<{ ok: boolean; error?: string }>`, optional: true, doc: `Retire a note.` },
    claims: { channel: "local:claims", params: [], type: `() => Promise<{ ok: boolean; claims: Array<{ actor: string; session: string; repo: string; paths: string[]; expiresAt: number; mine: boolean }>; payers: Array<{ actor: string; session: string; label: string; account: string }> }>`, optional: true, doc: `Live claims, mine and the team's.` },
    read: { channel: "local:read", params: ["root","relPath"], pack: "object", type: `(root: string, relPath: string) => Promise<ReadResult>`, doc: `One text file, by path relative to its root.` },
    write: { channel: "local:write", params: ["root","relPath","text","opts"], pack: "object", type: `(root: string, relPath: string, text: string, opts: { bom?: boolean; eol?: string }) => Promise<{ ok: boolean; error?: string }>`, doc: `One text file back, by path relative to its root.

SAID PLAINLY, because it changes what this bridge is: the board window
loads a REMOTE origin — the hub's own page — with this preload attached.
openBoard() in main.js sets out why that is considered acceptable (the hub
already ships the hook that runs on every teammate's machine, so it is
trusted with code execution already, and a narrow bridge makes a capability
it effectively had explicit and bounded instead of implicit).

That reasoning was written about READING files. This adds writing them, and
the stakes of the same decision are now higher: a hostile hub page could
not merely see your source, it could change it, inside a folder you picked.
The decision stands and is not being reopened here. It is written down so
that whoever does reopen it is looking at the real stake.

\`opts\` is \`{ bom, eol }\` as \`read\` reported them, so a file goes back the
way it came. main.js keeps only those two fields; nothing else crosses.` },
    diffHunks: { channel: "local:diffHunks", params: ["root","relPath"], pack: "object", type: `(root: string, rel: string) => Promise<{ ok: boolean; hunks?: Array<{ start?: number }> }>`, optional: true, doc: `Added-line hunks for one file: \`{ ok, hunks: [{start, count}] }\`. Read-only
 git metadata about a picked folder — narrower than tree/read/write above.` },
    chrome: { channel: "ui:chrome", params: ["spec"], type: `(spec: ColorThemeSpec) => void`, doc: `Line counts and git diff stats for a list of paths under one root.

\`{ ok, lines: {rel: number|null}, diff: {rel: {added, removed, status}} | null }\`.
\`lines[rel]\` is null for a file that was not counted — too big, binary or
unreadable — which is a different thing from zero. \`diff\` is null when git
said nothing useful at all (not a repo, no git, a timeout); an EMPTY diff
object means a clean tree, and the two must not be drawn the same way.

Capped in the main process at 2000 paths per call, with \`truncated\` saying
so. Counting is synchronous there, so an uncapped call from here could
freeze the window.


The status strip's machine-side figures. \`root\` is optional and only
affects the branch segment; it is re-checked against the opened
workspaces in the main process, as every path on this bridge is.

Tell the native window what colour the page just became.` },
    updateStatus: { channel: "app:updateStatus", params: [], type: `() => Promise<unknown>`, doc: `Staying current. \`updateInstall\` is the only one with a consequence, and
it is reachable only from a button the person presses -- nothing here
runs an installer on a timer. See desktop/app-update.js for what that
does per platform, and for what the published checksum does not buy.` },
    updateCheck: { channel: "app:updateCheck", params: [], type: `() => Promise<unknown>` },
    updateInstall: { channel: "app:updateInstall", params: [], type: `() => Promise<{ ok?: boolean; manual?: boolean; error?: string }>` },
    indexStatus: { channel: "local:indexStatus", params: ["root"], pack: "object", type: `(root: string | null) => Promise<{ ok: boolean } & Record<string, unknown>>`, doc: `The code index. Every one of these is inert on a machine the capability
gate turned down, and \`indexEnable\` is the ONLY thing that fetches the
model -- nothing here starts a download on its own.` },
    indexEnable: { channel: "local:indexEnable", params: ["root"], pack: "object", type: `(root: string | null) => Promise<{ ok?: boolean; indexed?: number; skipped?: number; error?: string } | null | undefined>`, optional: true },
    indexSearch: { channel: "local:indexSearch", params: ["root","query","opts"], payload: "{ root, query, ...(opts || {}) }", type: `(root: string | null, query: string, opts?: { k?: number; filter?: string }) => Promise<IndexSearchResult>`, optional: true, doc: `Semantic search over the workspace index. The scores are real cosines —
 \`code-index.js\` clamps them to [-1, 1] — which is why a retrieval panel
 can print one. Optional: a build without the index capability has none.
\`filter\` narrows by PATH and is matched as a literal, case-insensitively
 — it is not a pattern. See main.js § pathFilter: a regex from here runs
 against every chunk on the main process, where one that backtracks takes
 the whole app with it.` },
    status: { channel: "local:status", params: ["root"], pack: "object", type: `(root: string | null) => Promise<StatusResult>` },
    stats: { channel: "local:stats", params: ["root","relPaths"], pack: "object", type: `(root: string, paths: string[]) => Promise<StatsResult>` },
    commits: { channel: "local:commits", params: ["root","limit"], pack: "object", type: `(root: string, limit?: number) => Promise<CommitsResult>`, optional: true, doc: `The last few commits, newest first. Read only — there is no restore.` },
    memories: { channel: "local:memories", params: ["root"], pack: "object", type: `(root: string) => Promise<MemoriesResult>`, optional: true, doc: `What the agent has written down about this repo, if it writes memories
 at all. Read only: there is no bridge call that deletes one.` },
    sessions: { channel: "local:sessions", params: ["opts"], payload: "opts || {}", type: `(opts?: { cwd?: string | null; limit?: number }) => Promise<SessionsResult>`, optional: true, doc: `Every agent session on this machine — claude and codex, terminal,
 desktop app and IDE alike. Read only.

Every agent session on this machine — claude and codex, terminal, desktop
 app and IDE alike. Read only: there is no bridge call that writes or
 deletes one, and a session the CLI still has open is being appended to.
 Optional: an older desktop build has neither, and the pane that lists
 them renders nothing without them.` },
    session: { channel: "local:session", params: ["source","slug","id","child"], pack: "object", type: `(source: string, slug: string, id: string, child?: string) => Promise<SessionResult>`, optional: true },
    sessionAgents: { channel: "local:sessionAgents", params: ["slug","id"], pack: "object", type: `(slug: string, id: string) => Promise<SessionAgentsResult>`, optional: true, doc: `The subagents a claude session spawned, each openable as \`session(..., child)\`.

The subagents a claude session spawned. Open one by passing its id as
 \`session\`'s fourth argument.` },
    sessionLive: { channel: "local:sessionLive", params: ["source","id"], pack: "object", type: `(
    source: string,
    id: string,
  ) => Promise<{
    title: string;
    context: number | null;
    cached: number | null;
    output: number | null;
    window: number | null;
    model?: string;
    effort?: string;
    account?: string;
  } | null>`, optional: true, doc: `A running console's title and (codex) real context, off its session file.

A running console's own title and, for codex, its real context — see
 desktop/agent-sessions.js § live. Null until the CLI has written a file.` },
    defaultMode: { channel: "local:defaultMode", params: ["mode"], type: `(mode: string) => Promise<{ ok?: boolean; error?: string; mode?: string }>`, doc: `Masora Voice: is it installed, and start it so its flow bar comes up.
See desktop/masora-voice.js for why there is no "start recording".
The permission posture a new agent starts with, saved beside the zoom in
~/.zevet/config.json. Returns what is now stored, so the settings pane can
show the truth rather than what it hoped for.

Save this user default permission posture. Returns what is now stored —
never assume the write landed, which is the whole reason it answers.` },
    voiceStatus: { channel: "local:voiceStatus", params: [], returns: "Promise<unknown>", optional: true },
    voiceStart: { channel: "local:voiceStart", params: [], returns: "Promise<unknown>", optional: true },
    voiceMic: { channel: "local:voiceMic", params: [], returns: "Promise<unknown>", optional: true },
    resumeAgent: { channel: "local:resumeAgent", params: ["agent","cwd","resumeFrom","opts"], pack: "object", type: `(
    name: string,
    root: string,
    resumeFrom: string,
    opts: { model: string; mode: string; continues?: string },
  ) => Promise<StartAgentResult>`, optional: true, doc: `A follow-up to a console whose process has exited. All three CLIs can
 resume a session by id (measured 2026-09-21); codex and opencode need a
 new process to do it, which is what this is. Optional: an older desktop
 build has no resume, and the composer falls back to refusing.` },
    agentSettings: { channel: "local:agentSettings", params: ["root"], pack: "object", type: `(root: string) => Promise<AgentSettingsResult>`, optional: true, doc: `Standing instructions for this repo, and which optional capabilities an
 agent started here is given. Optional: an older desktop build has none,
 and the panel that edits them renders nothing without it.` },
    saveAgentSettings: { channel: "local:saveAgentSettings", params: ["root","patch"], pack: "object", type: `(root: string, patch: Partial<AgentSettings>) => Promise<AgentSettingsResult>`, optional: true },
    prefs: { channel: "local:prefs", params: [], type: `() => Promise<Record<string, string>>`, optional: true, doc: `Every "zevet.*" localStorage key, mirrored on this machine so it follows
 the person across a reload, an app update, or a change of hub.

Every "zevet.*" localStorage key, mirrored on this machine. Optional: an
 older desktop build has neither, and \`zStorage\` below is then exactly
 \`window.localStorage\`.` },
    setPref: { channel: "local:setPref", params: ["key","value"], pack: "object", type: `(key: string, value: string | null) => Promise<unknown>`, optional: true },
    setPrefs: { channel: "local:setPrefs", params: ["entries"], pack: "object", type: `(entries: Record<string, string>) => Promise<unknown>`, optional: true, doc: `Seed the mirror in one round trip — an existing user upgrading from a
 build without it has every pref sitting only in localStorage.

Seed the mirror in one batch — see prefs-mirror.mjs's \`hydratePrefsMirror\`,
 called once for an existing user upgrading from a build without it.` },
    schedules: { channel: "local:schedules", params: [], type: `() => Promise<SchedulesResult>`, optional: true, doc: `Agent runs on a timer. Optional: an older desktop build does not have
 them, and the hub serves this board to whatever version is installed.` },
    scheduleSave: { channel: "local:scheduleSave", params: ["s"], payload: "{ schedule: s }", type: `(s: Partial<AgentSchedule>) => Promise<SchedulesResult>`, optional: true },
    scheduleRemove: { channel: "local:scheduleRemove", params: ["id"], pack: "object", type: `(id: string) => Promise<SchedulesResult>`, optional: true },
    scheduleToggle: { channel: "local:scheduleToggle", params: ["id"], pack: "object", type: `(id: string) => Promise<SchedulesResult>`, optional: true },
    watch: { channel: "local:watch", params: ["root","relPath","initialText"], pack: "object", type: `(root: string, relPath: string, lastWritten: string | null) => Promise<{ ok: boolean }>`, doc: `Tell me when something else changes this file on disk.

THE SOMETHING ELSE IS THE POINT: Claude Code and Codex are editing these
files while the editor has them open. Without this the next keystroke
publishes the stale text over the agent's work and nothing anywhere reports
it. Idempotent — watching an already-watched file is a no-op, not a second
stream of events.` },
    unwatch: { channel: "local:unwatch", params: ["root","relPath"], pack: "object", type: `(root: string, relPath: string) => Promise<unknown>` },
    agents: { channel: "local:agents", params: [], type: `() => Promise<UsableAgent[]>`, doc: `Which agents are installed on this machine.` },
    startAgent: { channel: "local:startAgent", params: ["agent","cwd","opts"], pack: "object", type: `(name: string, root: string, opts: { model: string; mode: string; forkFrom?: string; prompt?: string; effort?: string; addDirs?: string[]; continueLatest?: boolean; engine?: string; label?: string }) => Promise<StartAgentResult>`, doc: `Start an agent in a folder. Returns { ok, id }.` },
    sendToAgent: { channel: "local:sendToAgent", params: ["id","text"], pack: "object", type: `(id: string, text: string) => Promise<{ ok: boolean; error?: string }>` },
    notify: { channel: "local:notify", params: ["title","body","key"], pack: "object", type: `(title: string, body: string, key: string) => Promise<{ ok: boolean }>`, optional: true, doc: `An OS notification for an agent that finished or needs a person. The board
decides whether one is wanted (lib/notify.mjs); this only shows it.` },
    boardReply: { channel: "local:boardReply", params: ["reqId","result"], pack: "object", type: `(reqId: string, result: unknown) => Promise<unknown>`, optional: true },
    stopAgent: { channel: "local:stopAgent", params: ["id"], type: `(id: string) => Promise<unknown>` },
    consoles: { channel: "local:consoles", params: [], type: `() => Promise<{ seq: number; consoles: HeldConsole[] }>`, optional: true, doc: `The consoles still held by this app, with every event each has sent —
 what a reloaded board replays to pick them back up.

What the app still holds from before a reload. Optional: an older desktop
 build reaps its agents on reload instead.` },
    forgetAgent: { channel: "local:forgetAgent", params: ["id"], type: `(id: string) => Promise<unknown>`, optional: true },
    integrateAgent: { channel: "local:integrateAgent", params: ["id"], type: `(id: string) => Promise<AgentIntegration>`, optional: true, doc: `Bring a subagent's worktree branch back into the checkout it was cut from.` },
    discardAgent: { channel: "local:discardAgent", params: ["id"], type: `(id: string) => Promise<AgentIntegration>`, optional: true, doc: `Throw a subagent's worktree and branch away.` },
    chatList: { channel: "chat:list", params: ["query"], pack: "object", type: `(query?: string) => Promise<ChatSummary[]>`, optional: true, doc: `Zevet Chat (desktop/chat.js): repo-independent conversations.

Zevet Chat (desktop/chat.js). Optional: an older desktop build has none,
and the Code | Chat switch is then not offered.` },
    chatGet: { channel: "chat:get", params: ["id"], type: `(id: string) => Promise<StoredChat | null>`, optional: true },
    chatCreate: { channel: "chat:create", params: ["folder"], pack: "object", type: `(folder?: string) => Promise<StoredChat>`, optional: true },
    chatSetFolder: { channel: "chat:setFolder", params: ["id","folder"], pack: "object", type: `(id: string, folder: string) => Promise<ChatSummary | null>`, optional: true },
    chatRename: { channel: "chat:rename", params: ["id","title"], pack: "object", type: `(id: string, title: string) => Promise<ChatSummary | null>`, optional: true },
    chatRemove: { channel: "chat:remove", params: ["id"], type: `(id: string) => Promise<boolean>`, optional: true },
    chatSend: { channel: "chat:send", params: ["id","text","opts"], pack: "object", type: `(
    id: string,
    text: string,
    opts?: { agent?: string; model?: string; effort?: string; mode?: string },
  ) => Promise<{ ok: boolean; error?: string; brief?: boolean }>`, optional: true },
    chatStop: { channel: "chat:stop", params: ["id"], type: `(id: string) => Promise<unknown>`, optional: true },
    permitAnswer: { channel: "local:permitAnswer", params: ["id","allow","reason","always"], pack: "object", type: `(id: string, allow: boolean, reason?: string, always?: boolean) => Promise<{ ok: boolean; error?: string }>`, optional: true },
    askAnswer: { channel: "local:askAnswer", params: ["id","picked"], pack: "object", type: `(id: string, picked: string[]) => Promise<{ ok: boolean; error?: string }>`, optional: true, doc: `Answered ONCE, with the chosen LABELS. Answering twice is harmless on the
wire — the main process has already deleted the pending entry — but the
UI must not be able to, which is why the card is removed optimistically.` },
    steerSend: { channel: "local:steerSend", params: ["to","session","repo","text"], pack: "object", type: `(to: string, session: string, repo: string, text: string) => Promise<{ ok: boolean; id?: string; status?: string; approval?: boolean; error?: string }>`, optional: true, doc: `Steer a teammate's agent (D-058): main seals the text with the document
key and sends it through the hub, which enforces the team's steer policy.
Optional: an older desktop build cannot steer.` },
    spawnSend: { channel: "local:spawnSend", params: ["to","repo","agent","model","text"], pack: "object", type: `(to: string, repo: string, agent: string, model: string, text: string) => Promise<{ ok: boolean; id?: string; status?: string; approval?: boolean; error?: string }>`, optional: true, doc: `Start an agent on a teammate's machine (D-060): main seals the prompt and
sends it through the hub, which enforces the team policy. Their app picks the
mode and resolves the repo by name. Optional: an older desktop build cannot.` },
    takeoverSend: { channel: "local:takeoverSend", params: ["to","session","repo","agent"], pack: "object", type: `(to: string, session: string, repo: string, agent: string) => Promise<{ ok: boolean; id?: string; status?: string; approval?: boolean; winner?: string; payer?: string; error?: string }>`, optional: true, doc: `Take over a teammate's running turn: main seals the request with the document
key; the hub allows one winner per session and enforces the team's steer
policy. The new turn runs on THIS machine's account, on the engine named.
Optional: an older desktop build cannot.` },
    payerFor: { channel: "local:payerFor", params: ["agent","model","engine"], pack: "object", type: `(agent: string, model?: string, engine?: string) => Promise<{ engine: string; account: string; label: string }>`, optional: true, doc: `Who pays for an agent's turns on this machine: engine and account, from the engine's own login (never a token). Empty label = unknown.` },
    sharePayer: { channel: "local:sharePayer", params: ["session","agent","model","engine"], pack: "object", type: `(session: string, agent: string, model?: string, engine?: string) => Promise<{ ok: boolean; label?: string }>`, optional: true, doc: `Seal this session's payer with the document key and share it with the team (a release when unknown).` },
    steerAnswer: { channel: "local:steerAnswer", params: ["id","approve"], pack: "object", type: `(id: string, approve: boolean) => Promise<{ ok: boolean; error?: string }>`, optional: true },
    approvalAnswer: { channel: "local:approvalAnswer", params: ["id","allow"], pack: "object", type: `(id: string, allow: boolean) => Promise<{ ok: boolean; status?: string; by?: string; error?: string }>`, optional: true, doc: `Answer a teammate agent's permission prompt (D-086). Main seals the answer with the exact action it was shown; the hub only arbitrates the first answer, and the teammate's app checks it before acting. Editor and above; refused while the team policy is off.` },
  },
  events: {
    onUpdate: { channel: "app:update", payload: "unknown", type: `(cb: (s: unknown) => void) => void` },
    onIndexEvent: { channel: "local:indexEvent", payload: "unknown", type: `(cb: (p: { kind?: string; total?: number; loaded?: number; indexed?: number }) => void) => void` },
    onFileChanged: { channel: "local:fileChanged", payload: "unknown", type: `(cb: (p: { root: string; relPath: string; text?: string; bom?: boolean; eol?: string }) => void) => () => void`, doc: `\`fn({ root, relPath, text, bytes, bom, eol })\`; returns an unsubscribe.

\`bom\` and \`eol\` are carried so they can be handed straight back to \`write\`:
a file that arrived with a BOM and CRLF has to be saved that way or the
next commit is a whole-file diff blamed on whoever pressed save.

A DELETED file produces no event. There is no text to carry and sending an
empty string would tell the editor to publish an empty document — the exact
clobber this exists to prevent. See \`fire()\` in desktop/file-watch.js.` },
    onNotifyClick: { channel: "local:notifyClick", payload: "unknown", type: `(cb: (key: string) => void) => () => void`, optional: true, doc: `A notification from notify() was clicked; key is the one it was sent with.` },
    onSchedulesChanged: { channel: "local:schedulesChanged", payload: "unknown", type: `(cb: (list: unknown) => void) => () => void`, optional: true, doc: `A due schedule just ran (or was skipped); the board's own list is
otherwise only refreshed after a save/toggle/remove round-trip.` },
    onChatEvent: { channel: "chat:event", payload: "unknown", type: `(cb: (p: { id: string; evt: { type: string; [k: string]: unknown } }) => void) => () => void`, optional: true },
    onAgentEvent: { channel: "local:agentEvent", payload: "unknown", type: `(cb: (evt: AgentEvent) => void) => () => void`, doc: `Stream of console events; returns an unsubscribe function.` },
    onAgentIntegration: { channel: "local:agentIntegration", payload: "unknown", type: `(cb: (r: AgentIntegration & { id: string }) => void) => () => void`, optional: true, doc: `A subagent run's integration outcome changed.` },
    onAgentAttached: { channel: "local:agentAttached", payload: "unknown", type: `(cb: (c: HeldConsole) => void) => () => void`, optional: true, doc: `A console the board did not start itself (the loopback agent API, a schedule)
just opened. Without it such an agent only reached the board on a page reload.` },
    onBoardRequest: { channel: "local:boardRequest", payload: "unknown", type: `(cb: (req: { reqId: string; kind: string; [k: string]: unknown }) => void) => () => void`, optional: true, doc: `The loopback agent API asks the board to start or message an agent through
its own actions, as a person's Send would. Answer with boardReply.` },
    onPermitRequest: { channel: "local:permitRequest", payload: "unknown", type: `(cb: (req: PermitRequest) => void) => () => void`, optional: true, doc: `An agent is asking to do something and is BLOCKED until the answer comes
back — see the computer-use block in main.js. The board is the only place
a person can be asked, so this is not a notification.

An agent is asking permission and is waiting on the answer. Optional: a
 build without computer use never sends one.` },
    onAskRequest: { channel: "local:askRequest", payload: "unknown", type: `(cb: (req: AskRequest) => void) => () => void`, optional: true, doc: `An agent has asked the PERSON something (not a yes/no permission — a
question with its own options) and is blocked on the answer. Same shape
as the permit channel above, different event names.

A question from an agent, and the answer back. Optional like the permit
pair beside them: an older main process simply never sends one.` },
    onMemoryEvent: { channel: "local:memoryEvent", payload: "unknown", type: `(cb: (e: { repo: string }) => void) => () => void`, optional: true, doc: `Pinned notes changed (a teammate's note arrived or one was edited).` },
    onClaimsEvent: { channel: "local:claimsEvent", payload: "unknown", type: `(cb: (e: { claims: Array<{ actor: string; session: string; repo: string; paths: string[]; expiresAt: number; mine: boolean }>; payers: Array<{ actor: string; session: string; label: string; account: string }> }) => void) => () => void`, optional: true, doc: `The live claims changed (a claim, a release, an expiry, a teammate's frame).` },
    onSteerEvent: { channel: "local:steerEvent", payload: "unknown", type: `(cb: (e: { kind: string; id: string; [k: string]: unknown }) => void) => () => void`, optional: true, doc: `Steering (D-058): \`ask\` an approval card for a teammate's steer, \`done\`
when one was injected or declined, \`status\` for a steer this person sent.` },
  },
});

const zevetDoc = defineIpc({
  global: "zevetDoc",
  typeName: "ZevetDocBridge",
  declareWindow: false, // board/src/lib/bridge.ts declares the (looser, optional) Window shape
  prelude: `/**
 * Whatever arrived, as a real \`Uint8Array\` of exactly the right length.
 *
 * ⚠️ WHY THIS EXISTS RATHER THAN A CAST. \`bytes\` starts life in the main
 * process as a Node \`Buffer\` (that is what \`doc-crypto.open()\` returns) and
 * crosses two boundaries to get here: Electron's IPC structured clone, and then
 * contextBridge's own clone into the renderer's world. main.js already copies
 * it into a plain \`Uint8Array\` before the first of those — a \`Buffer\` is a view
 * over Node's shared 8 KiB pool, and cloning the view drags the whole pool
 * along. This is the second guard, on the second boundary, and it is here
 * because the contract this bridge publishes says \`Uint8Array\` and a renderer
 * calling \`Y.applyUpdate\` with anything else fails at a depth nobody will
 * enjoy.
 *
 * WHAT WAS ACTUALLY MEASURED, on Electron 38.1.2 / Windows 11, by running a
 * throwaway app that sent a real pooled \`Buffer\` from main and printed what
 * arrived at each hop:
 *
 *   • main → preload: a \`Buffer\` arrives as a PLAIN \`Uint8Array\`. Not a
 *     Buffer — \`Buffer.isBuffer\` is false and \`constructor.name\` is
 *     "Uint8Array" — so nothing here may assume Buffer methods exist.
 *   • preload → renderer, through contextBridge: a \`Uint8Array\` arrives as a
 *     \`Uint8Array\` for which \`instanceof Uint8Array\` is TRUE in the renderer's
 *     own realm, with the right values and an exact-length backing buffer.
 *   • renderer → main, via \`invoke\`: also a plain \`Uint8Array\`.
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
  // from ANOTHER JavaScript realm is not \`instanceof\` this one's, and that is
  // precisely what a cross-world clone could hand over.
  if (ArrayBuffer.isView(value)) {
    /* ⚠️ COPIED, NOT RE-VIEWED. This returned
       \`new Uint8Array(value.buffer, value.byteOffset, value.byteLength)\`,
       which is still a VIEW over the original store — so it walked straight
       into the hazard the branch above spells out and was written to prevent,
       in the branch that handles the case that comment names as the likely
       source. The inner call takes the window, the outer copies it. */
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  /* \`instanceof\` is false for ANOTHER REALM's ArrayBuffer, and an ArrayBuffer
     has no \`length\`, so a cross-realm one fell past the array-like check below
     and became \`new Uint8Array(0)\`: doc:send synced nothing and reported no
     error. The brand check is realm-independent. */
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value);
  }
  // An array-like \`{0:…, 1:…, length:n}\` is what a structured clone that lost
  // the type would look like. \`Uint8Array.from\` reads it correctly; a plain
  // \`new Uint8Array(obj)\` would silently produce a zero-length array, which
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
 * key — \`send\` takes bytes and gives back a boolean, \`onMessage\` hands out
 * bytes, and there is no accessor for anything in between.
 *
 * ⚠️ HOW TO TELL THE TWO FAILURES APART, because they have opposite remedies:
 *
 *   \`join\` resolving \`{ok:false}\` is ALWAYS a broken or legacy INSTALL — this
 *   machine has no master secret, or one that is not usable. Nothing in that
 *   path touches the network, so it is never about the hub. It will not fix
 *   itself and a retry button is the wrong answer; re-running setup is the
 *   right one. \`code\` says \`setup-required\`, or \`unavailable\` for a build that
 *   cannot sync at all (a missing crypto module), and \`error\` is a sentence
 *   written to be shown to a person.
 *
 *   THE HUB BEING DOWN never fails \`join\`. The join succeeds, the socket
 *   retries behind it with backoff, and the only place it shows up is
 *   \`onStatus\` — \`connecting\`, \`retrying\`, \`open\`, and \`undecipherable\` for a
 *   frame from a teammate on a different secret. That one does fix itself and
 *   is worth waiting out.
 */`,
  constants: { available: { value: true, type: "boolean" } },
  calls: {
    join: { channel: "doc:join", params: [["room","unknown"]], returns: "Promise<unknown>", optional: true, doc: `Join a room and start receiving it. \`{ ok, error?, code? }\`.` },
    send: { channel: "doc:send", params: [["room","unknown"],["u8","unknown"],["opts","unknown"]], payload: "{ room, bytes: toUint8(u8), opts }", returns: "Promise<unknown>", optional: true, doc: `Send one plaintext Yjs update. \`opts.snapshot\` marks it as a full state
that the hub may replace the room's whole log with — which is what keeps
a long-lived room from being trimmed out from under a late joiner.` },
    comments: { channel: "doc:comments", params: [["room","unknown"],["data","unknown"]], payload: "{ room, data }", returns: "Promise<unknown>", optional: true, doc: `Publish this room's unresolved comments to ~/.zevet/comments/<repo>/<path>.json, where agents can read them. \`{ ok }\`.` },
    leave: { channel: "doc:leave", params: [["room","unknown"]], returns: "Promise<unknown>", optional: true, doc: `Leave. Always \`{ ok: true }\`; leaving a room never joined is what a
 closing tab does and is not worth an error.` },
  },
  events: {
    onMessage: { channel: "doc:message", transform: "payload && payload.bytes ? { ...payload, bytes: toUint8(payload.bytes) } : payload", payload: "unknown", optional: true, doc: `\`fn({ room, kind, bytes? })\`; returns an unsubscribe.

  \`ready\`         the socket is open and joined — send your full state now,
                  which is what seeds an empty room and what gets offline
                  edits to everyone else.
  \`update\`        \`bytes\` is a plaintext Yjs update from a teammate.
  \`snapshot-due\`  send your whole document with \`{snapshot:true}\`.

⚠️ \`ready\` FIRES ON EVERY RECONNECT, not once. After a hub restart the
renderer is asked for its state again, and that is the mechanism by which
the room refills rather than a duplicate to be filtered out.` },
    onStatus: { channel: "doc:status", payload: "unknown", optional: true, doc: `\`fn({ room, state, detail })\`; returns an unsubscribe. The ONLY place a
 connection problem is reported — an editor that silently stops syncing is
 this project's worst failure, so the status is a first-class output.` },
  },
});

module.exports = { tables: [zevet, zevetLocal, zevetDoc] };
