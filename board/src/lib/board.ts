import { create } from "zustand";
import { bridge, type AgentSchedule, type AgentSettings, type MemoryNote, type PermitRequest, type RepoCommit, type StatusResult } from "./bridge";
import { shortInput } from "./fmt";
import {
  appendAgentPayload,
  appendRaw,
  appendUserText,
  closeTranscript,
  emptyTranscript,
} from "./transcript.mjs";
import { sessionTranscript } from "./sessions.mjs";
import type { SessionAgent, SessionSummary } from "./sessions.d.mts";
import type { TranscriptState } from "./transcript.d.mts";
import {
  canInstallState,
  createUpdateControl,
  type UpdateControl,
  type UpdatesLike,
} from "./update.mjs";
import {
  clampPaneWidth,
  followAllows as rosterFollowAllows,
  lastToolFor as rosterLastToolFor,
  newestHunk,
} from "./roster.mjs";
import {
  HUES, IDLE_FALLBACK, MODELS, PANE_DEFAULTS, PANE_KEY, PANE_LIMITS,
  STATS_EVERY_MS, STATS_MAX_PATHS, STATUS_EVERY_MS,
} from "./constants";
import type {
  Collision, Conn, ConsoleEntry, ConsoleLine, HubEvent, LaunchMode, LocalEntry,
  LocalFileData, LocalWorkspace, RateWindow, RosterEntry, Snapshot, Theme, UpdateState, ViewMode,
} from "./types";

/* ---------------------------------------------------------------------------
 * THE BRIDGE SURFACES THE RENDERER DRIVES
 * ------------------------------------------------------------------------- */

type ConsoleLinePartKind = "out" | "tool" | "err" | "meta";

export { MODELS, PANE_KEY, PANE_LIMITS, PANE_DEFAULTS, IDLE_FALLBACK, HUES };

/** A single yjs-backed editor session. The DOM-heavy halves (ydoc, awareness,
 *  the CodeMirror view) are deliberately NOT in the store, which stays lean
 *  enough for zustand's shallow-equality renders. */
interface EditorSession {
  root: string;
  relPath: string;
  room: string;
  text: string | null;
  bom: boolean;
  eol: string;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  saving: boolean;
  savedAt: number;
  lastWritten: string | null;
  watching: boolean;
  seeded: boolean;
  seedTimer: number | null;
  saveTimer: number | null;
  unsub: Array<() => void>;
  agentLine: { actor: string; tool?: string; line: number } | null;
  // yjs / CM6
  ydoc: unknown;
  awareness: unknown;
  view: { dom: HTMLElement; scrollDOM: HTMLElement; state: { doc: { length: number; lines: number }; line: (n: number) => { from: number } }; lineBlockAt: (p: number) => { top: number } } | null;
  destroyView: (() => void) | null;
  setDark: ((d: boolean) => void) | null;
  getText: (() => string | null) | null;
  setText: ((t: string) => void) | null;
}

/* ---------------------------------------------------------------------------
 * STORE
 * ------------------------------------------------------------------------- */

interface Stats {
  lines: Record<string, number | undefined>;
  diff: Record<string, { status: string; added?: number; removed?: number } | undefined> | null;
  root: string | null;
}

interface LiveStrip {
  model: string | null;
  context: number | null;
  cacheHit: number | null;
  cost: number | null;
}

interface Strip {
  live: LiveStrip;
  machine: StatusResult | null;
}

/**
 * Starting a console as a BRANCH of one that already ran.
 *
 * claude takes `--resume <id> --fork-session`; codex takes `exec fork <id>`
 * (both measured 2026-09-21). Forking rather than resuming is the whole point:
 * resuming writes more history into the same session, so a second answer would
 * replace the first and there would be nothing to compare. A fork leaves the
 * original alone.
 */
export interface ForkLaunch {
  /** The session id to branch from. Absent for an ordinary start: the same
   *  shape carries "start this agent and ask it X", which is what the
   *  composer does when no console is running yet. */
  forkFrom?: string;
  /** Asked as soon as the fork is up. */
  prompt: string;
  /** The model and posture of the run it came from, so the two answers differ
   *  by the prompt and nothing else. */
  model?: string;
  mode?: LaunchMode;
  /** The `key` of the console being branched. Recorded on the new console as
   *  `forkedFrom`; a fork's own session id is new, so this is the only link
   *  between two answers to the same question. */
  fromKey?: number;
}

interface BoardState {
  conn: Conn;
  needsToken: boolean;
  skewMs: number;
  idleAfterMs: number;

  events: HubEvent[];
  roster: RosterEntry[];
  collisions: Collision[];

  selectedActor: string | null;
  selectedRepo: string | null;
  collapsed: Record<string, boolean>;
  selectedPath: string | null;

  followMode: "mine" | "all" | "off";
  viewMode: ViewMode;
  theme: Theme;

  localRoot: string | null;
  localEntries: LocalEntry[] | null;
  localError: string | null;
  /** The tree was cut short. NOT an error - see openLocalRoot. */
  localTruncated: string | null;
  localAgents: UsableAgentShape[];
  localWorkspaces: LocalWorkspace[];
  localFile: LocalFileData | null;

  stats: Stats;
  statsAt: number;
  statsPending: boolean;

  myConsoles: ConsoleEntry[];
  /** Which console the conversation column is showing. The thread list picks
   *  it; null means "the newest one", so a freshly started agent is in front
   *  without anything having to select it. */
  activeConsole: number | null;
  /** When each console was last in front. A console that finished while you
   *  were reading another one is the thing the background inbox exists to
   *  surface, and nothing else in the store knows you looked away. */
  seenConsole: Record<number, number>;
  /** Commits observed while zevet was watching, newest last. Built from the
   *  repo status poll, which already runs — this only remembers that the sha
   *  moved, which is the one thing the poll throws away. */
  checkpoints: { sha: string; branch: string; ts: number }[];
  /** The repo's actual last few commits, with a real files-changed count read
   *  from `git log`. `checkpoints` above only knows the sha moved; this knows
   *  what moved in it, which is what a checkpoint list has to say to be worth
   *  showing. Refreshed when the sha changes, never on a timer. */
  repoCommits: RepoCommit[];
  /** Agent runs on a timer, as the desktop app holds them. Empty on a build
   *  that does not have the capability, which is not an error. */
  schedules: AgentSchedule[];
  /** What the agent has written down about this repo. Read from the agent's
   *  own memory directory; empty for an agent that keeps none. */
  memories: MemoryNote[];
  /** Standing instructions and optional capabilities for the open repo. Null
   *  until read, and on a desktop build that does not have them. */
  agentSettings: AgentSettings | null;
  /** Things an agent has asked to do and is waiting on. Oldest first; a
   *  question that is answered leaves the list. */
  permits: PermitRequest[];
  /** MCP servers the agent reported at startup, by console key. Read off
   *  claude's init payload; absent for a CLI that does not announce them. */
  mcpServers: Record<number, { name: string; status: string; tools: string[] }[]>;
  /** Show the launcher instead of a thread. Separate from activeConsole
   *  BECAUSE null there already means "the newest one" — overloading it made
   *  the launcher unreachable the moment a console existed. */
  launching: boolean;
  /** Which CLI the composer will start when there is no console yet.
   *
   *  The model picker sets it, because a ModelOption's id is
   *  `<agent>:<alias>` — picking a model IS picking an agent. Empty until
   *  something has been picked or the agents have been read. */
  launchAgent: string;
  launchModel: string;
  /** Reasoning effort, for the one CLI that takes the flag (codex). Sticky
   *  across model switches; the selector only shows it for a model that
   *  declares support, so it is carried even while it does not apply. */
  launchEffort: string;
  launchMode: LaunchMode;

  edView: EditorViewState | null;
  docStatus: Record<string, { state: string; detail?: string }>;

  strip: Strip;

  who: { state: WhoStateShape | null; busy: boolean };
  index: { state: unknown; barPct: number; progressText: string };
  indexStatus: unknown;

  updates: {
    state: UpdateState | null;
    revision: number;
    checking: boolean;
    installing: boolean;
    installError: string;
    notice: string;
  };

  panes: Record<string, number>;
  sheetOpen: boolean;
  /** Masora Voice is missing and the mic was pressed: the download URL to
   *  offer, or null. See lib/voice.ts. */
  voiceAsk: string | null;
  /** What the microphone last did, as one sentence to show under the
   *  composer. The mic is a button; a button that does nothing visible is the
   *  bug lib/voice.ts exists to remove. */
  voiceHotkey: string | null;

  /** Every agent session on this machine — claude and codex, terminal,
   *  desktop app and IDE alike. Read only; see desktop/agent-sessions.js.
   *  `open` is the one being read instead of a live console. */
  sessions: {
    list: SessionSummary[];
    total: number;
    loading: boolean;
    loaded: boolean;
    query: string;
    /** "repo" scopes to the open folder, "all" to the machine. */
    scope: "repo" | "all";
    open: SessionSummary | null;
    openTranscript: TranscriptState | null;
    openTruncated: boolean;
    openLoading: boolean;
    /** The subagents the open session spawned, and which one is being read.
     *  Fetched when a session opens, because the count on the row comes free
     *  from a readdir but the descriptions cost a file each. */
    agents: SessionAgent[];
    openAgent: SessionAgent | null;
    error: string;
  };

  myActor: string | null;

  /* --- actions --- */
  setConn: (c: Conn, label?: string) => void;
  setNeedsToken: (v: boolean) => void;
  applySnapshot: (s: Snapshot) => void;
  pushEvent: (e: HubEvent) => void;
  setSelectedActor: (a: string | null) => void;
  toggleRepo: (repo: string) => void;
  /** `collapsed` is the NEW collapsed state, not the new open state — see the
   *  implementation for the release-long bug that distinction caused. */
  setCollapsed: (path: string, collapsed: boolean) => void;
  setFollowMode: (m: "mine" | "all" | "off") => void;
  setView: (v: ViewMode) => void;
  setTheme: (t: Theme) => void;
  clearSelectedPath: () => void;

  setLaunchMode: (m: LaunchMode) => void;
  setLaunchModel: (m: string) => void;
  setLaunchEffort: (e: string) => void;
  setLaunchAgent: (a: string) => void;
  adoptDefaultAgent: () => void;
  /** Start an agent. `launch` is for a FORK: the session to branch from, the
   *  prompt to ask it, and the model/posture of the run it came from. */
  startAgent: (name: string, launch?: ForkLaunch) => void;
  closeConsole: (key: number) => void;
  setActiveConsole: (key: number | null) => void;
  markConsoleSeen: (key: number) => void;
  openLauncher: () => void;
  stopConsole: (key: number) => void;
  sendPrompt: (key: number, text: string) => void;

  openLocalRoot: (dir: string) => void;
  unsetLocalRoot: () => void;
  addWorkspace: () => void;
  refreshLocalAgents: () => void;
  refreshLocalWorkspaces: () => Promise<void>;
  refreshStats: (force?: boolean) => void;

  updateCheck: () => void;
  updateInstall: () => void;
  receiveUpdate: (s: UpdateState) => void;
  setUpdateChecking: (v: boolean) => void;

  refreshWhoami: () => void;
  setWhoBusy: (v: boolean) => void;

  setIndex: (patch: Partial<BoardState["index"]>) => void;
  setIndexStatus: (r: unknown) => void;
  refreshIndexStatus: () => void;

  setPanes: (p: Record<string, number>) => void;
  openSettings: () => void;
  setVoiceAsk: (url: string | null) => void;
  setVoiceHotkey: (k: string) => void;
  closeSettings: () => void;

  refreshSessions: (force?: boolean) => void;
  setSessionQuery: (q: string) => void;
  setSessionScope: (v: "repo" | "all") => void;
  openSession: (s: SessionSummary) => void;
  openSessionAgent: (a: SessionAgent | null) => void;
  closeSession: () => void;

  setMyActor: (a: string | null) => void;
  setEdView: (v: EditorViewState | null) => void;
  updateEdView: (patch: Partial<EditorViewState>) => void;
  setDocStatus: (room: string, st: { state: string; detail?: string }) => void;
  syncDocStatus: () => void;
  setStripLive: (patch: Partial<LiveStrip>) => void;
  setStripMachine: (m: StatusResult | null) => void;

  tick: number;
  bumpTick: () => void;
}

export type UsableAgentShape = {
  name: string;
  ok: boolean;
  signedIn: boolean;
  detail: string;
};

interface WhoStateShape {
  ok?: boolean;
  actor?: string;
  login?: string;
  owner?: boolean;
  allow?: string[];
  shared?: boolean;
  githubSignIn?: boolean;
  people?: Array<{ login: string; owner?: boolean; pending?: boolean }>;
}

export interface EditorViewState {
  root: string;
  relPath: string;
  room: string;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  dirty: boolean;
  saving: boolean;
  savedAt: number;
  watching: boolean;
  shareState: string;
  shareDetail: string;
}

/* ---------------------------------------------------------------------------
 * PREFS
 * ------------------------------------------------------------------------- */

function pref(key: string, fallback: string): string {
  try {
    const v = window.localStorage.getItem("zevet." + key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function setPref(key: string, value: string): void {
  try {
    window.localStorage.setItem("zevet." + key, value);
  } catch {
    /* preference applies for this session only */
  }
}

let ed: EditorSession | null = null;
let pendingAgentLine: { repo: string; target: string } | null = null;

/* ---------------------------------------------------------------------------
 * THE STORE
 * ------------------------------------------------------------------------- */

let consoleSeq = 0;

export const useBoard = create<BoardState>((set, get) => ({
  conn: "init",
  needsToken: false,
  skewMs: 0,
  idleAfterMs: IDLE_FALLBACK,

  events: [],
  roster: [],
  collisions: [],

  selectedActor: null,
  selectedRepo: null,
  collapsed: Object.create(null) as Record<string, boolean>,
  selectedPath: null,

  followMode: (() => {
    try {
      const v = window.localStorage.getItem("zevet.follow.v1");
      if (v === "all" || v === "off") return v;
    } catch {
      /* private mode etc */
    }
    return "mine";
  })(),
  viewMode: (pref("view", "ide") === "agent" ? "agent" : "ide") as ViewMode,
  theme: (pref("theme", "light") === "dark" ? "dark" : "light") as Theme,

  localRoot: null,
  localEntries: null,
  localError: null,
  localTruncated: null,
  localAgents: [],
  localWorkspaces: [],
  localFile: null,

  stats: { lines: Object.create(null) as Record<string, number | undefined>, diff: null, root: null },
  statsAt: 0,
  statsPending: false,

  myConsoles: [],
  activeConsole: null,
  launching: false,
  seenConsole: {},
  checkpoints: [],
  repoCommits: [],
  schedules: [],
  memories: [],
  agentSettings: null,
  permits: [],
  mcpServers: {},
  launchAgent: "",
  launchModel: "",
  launchEffort: "",
  launchMode: "auto",

  edView: null,
  docStatus: Object.create(null) as Record<string, { state: string; detail?: string }>,

  strip: { live: { model: null, context: null, cacheHit: null, cost: null }, machine: null },

  who: { state: null, busy: false },
  index: { state: null, barPct: 0, progressText: "ready" },
  indexStatus: null,

  updates: { state: null, revision: 0, checking: false, installing: false, installError: "", notice: "" },

  panes: (() => {
    const d: Record<string, number> = { ...PANE_DEFAULTS };
    try {
      const s = JSON.parse(window.localStorage.getItem(PANE_KEY) || "{}");
      for (const k of ["rail", "tree"]) {
        if (typeof s[k] === "number") d[k] = clampPaneWidth(s[k], PANE_LIMITS[k][0], PANE_LIMITS[k][1]);
      }
    } catch {
      /* defaults */
    }
    return d;
  })(),
  sheetOpen: false,
  voiceAsk: null,
  voiceHotkey: null,
  sessions: {
    list: [],
    total: 0,
    loading: false,
    loaded: false,
    query: "",
    scope: "repo",
    open: null,
    openTranscript: null,
    openTruncated: false,
    openLoading: false,
    agents: [],
    openAgent: null,
    error: "",
  },

  myActor: (bridge.cfg && bridge.cfg.actor) || null,

  setConn: (c) => set({ conn: c }),
  setNeedsToken: (v) => set({ needsToken: v }),

  applySnapshot: (s) => {
    const skew = typeof s.now === "number" ? s.now - Date.now() : 0;
    set((g) => ({
      skewMs: skew,
      roster: s.roster || [],
      collisions: s.collisions || [],
      idleAfterMs: s.idleAfterMs || IDLE_FALLBACK,
      events: s.events || [],
      selectedRepo: g.selectedRepo ? g.selectedRepo : lastRepoOf(s.events || []),
    }));
  },

  pushEvent: (e) => {
    const g = get();
    const events = [...g.events, e];
    if (events.length > 900) events.shift();
    const roster = [...g.roster];
    if (!roster.some((r) => r.actor === e.actor)) {
      const now = serverNow();
      roster.push({
        actor: e.actor,
        hue: 0,
        lastTs: e.ts,
        lastEvent: e,
        turns: 0,
        tools: 0,
        idle: now - e.ts > g.idleAfterMs,
        agoMs: now - e.ts,
      });
      roster.sort((a, b) => a.actor.localeCompare(b.actor));
    }
    const r = roster.find((x) => x.actor === e.actor);
    if (r) {
      r.lastTs = e.ts;
      r.lastEvent = e;
    }
    const patch: Partial<BoardState> = { events, roster };
    if (!g.selectedRepo) patch.selectedRepo = e.repo || null;
    set(patch);
    followEvent(e);
  },

  setSelectedActor: (a) => set({ selectedActor: a }),
  toggleRepo: (repo) =>
    set((g) => ({ selectedRepo: g.selectedRepo === repo ? null : repo })),
  /* ⚠️ THE ARGUMENT IS "IS IT COLLAPSED", AND IT USED TO BE NAMED `open`.
     It was always written straight into the `collapsed` map, so the name was
     the only thing that said otherwise — and tree.tsx believed the name. It
     passed `!open`, which is `collapsed[path]` again, so every click wrote the
     value back unchanged and a directory could not be collapsed at any point
     in zevet's life. Nothing threw; the chevron just never turned. */
  setCollapsed: (path, collapsed) =>
    set((g) => ({ collapsed: { ...g.collapsed, [path]: collapsed } })),
  setFollowMode: (m) => {
    try {
      window.localStorage.setItem("zevet.follow.v1", m);
    } catch {
      /* private mode etc */
    }
    set({ followMode: m });
  },
  setView: (v) => {
    setPref("view", v);
    set({ viewMode: v });
    requestMeasureEditor();
  },
  setTheme: (t) => {
    setPref("theme", t);
    set({ theme: t });
    if (ed && ed.setDark) try { ed.setDark(t === "dark"); } catch { /* torn down */ }
    drawRiders();
  },
  clearSelectedPath: () => set({ selectedPath: null }),

  setLaunchMode: (m) => set({ launchMode: m }),
  setLaunchModel: (m) => set({ launchModel: m }),
  setLaunchEffort: (e) => set({ launchEffort: e }),
  setLaunchAgent: (a) => set({ launchAgent: a }),

  startAgent: (name, launch) => {
    const br = bridge.local;
    const root = useBoard.getState().localRoot;
    if (!br || !root) return;
    /* A fork carries the model and posture of the run it came from, not the
       launcher's current pick — otherwise "ask that again" would quietly ask a
       different model, and the two answers would not be comparable. */
    const from = launch && launch.forkFrom ? launch : null;
    // A start with no fork still carries a prompt: that is the composer
    // starting a run because somebody pressed Send with nothing running.
    const model = from && from.model !== undefined ? from.model : get().launchModel;
    const mode = from && from.mode !== undefined ? from.mode : get().launchMode;
    const c: ConsoleEntry = {
      key: ++consoleSeq,
      id: null,
      agent: name,
      lines: [],
      transcript: emptyTranscript(),
      running: true,
      error: null,
      mode,
      model,
      root,
      hue: get().myConsoles.length % 5,
      usage: { context: null, cacheHit: null, cost: null, model: null, input: null, cachedInput: null, output: null, window: null, series: [] },
      limits: [],
      sessionId: null,
      // Which console this is a branch of, if any — see `forkedFrom` in
      // types.ts for why it cannot be worked out after the fact.
      forkedFrom: launch && typeof launch.fromKey === "number" ? launch.fromKey : null,
      startedAt: Date.now(),
      exitCode: null,
    };
    set((g) => ({
      myConsoles: [...g.myConsoles, c],
      activeConsole: c.key,
      launching: false,
      seenConsole: { ...g.seenConsole, [c.key]: Date.now() },
    }));
    br.startAgent(name, root, {
      model,
      mode,
      ...(launch && launch.forkFrom ? { forkFrom: launch.forkFrom } : {}),
    }).then((r) => {
      if (!r || !r.ok) {
        c.running = false;
        c.error = (r && r.error) || "could not start";
      } else {
        c.id = r.id ? String(r.id) : null;
        // The prompt a fork was started to ask. It goes only after the spawn
        // succeeded, because a prompt sent to a console with no process is the
        // one case where the composer's own guard cannot help.
        if (launch && launch.prompt) get().sendPrompt(c.key, launch.prompt);
      }
      signalConsolesChanged();
    });
  },

  setActiveConsole: (key) =>
    set((g) => ({
      activeConsole: key,
      launching: false,
      seenConsole: key == null ? g.seenConsole : { ...g.seenConsole, [key]: Date.now() },
    })),
  markConsoleSeen: (key) =>
    set((g) => ({ seenConsole: { ...g.seenConsole, [key]: Date.now() } })),
  openLauncher: () => set({ launching: true }),

  closeConsole: (key) => {
    const del = get().myConsoles.find((x) => x.key === key);
    set((g) => ({
      myConsoles: g.myConsoles.filter((x) => x.key !== key),
      // Closing the console you were reading must not leave the conversation
      // column pointed at a thread that no longer exists.
      activeConsole: g.activeConsole === key ? null : g.activeConsole,
    }));
    if (del && del.running && del.id) void bridge.local?.stopAgent(del.id);
    const cur = get();
    if (cur.edView) { /* unchanged */ }
  },

  stopConsole: (key) => {
    const c = get().myConsoles.find((x) => x.key === key);
    if (!c) return;
    if (c.running && c.id) void bridge.local?.stopAgent(c.id);
    set((g) => ({
      myConsoles: g.myConsoles.map((x) => (x.key === key ? { ...x, running: false } : x)),
    }));
  },

  sendPrompt: (key, text) => {
    const c = get().myConsoles.find((x) => x.key === key);
    if (!c) return;
    pushConsoleLine(c, "you", text);
    c.transcript = appendUserText(c.transcript, text);

    /* ⚠️ A FOLLOW-UP TO A FINISHED RUN IS A NEW PROCESS, NOT A WRITE TO A DEAD
       PIPE. codex and opencode close stdin after one prompt, so their console
       is already gone by the time you have read the answer — which is why the
       composer used to refuse the second prompt to those two.
       
       All three can resume a session by id, measured 2026-09-21, so the
       refusal is no longer the only honest answer. The console keeps its key
       and its transcript; only the process underneath it is new. */
    if (!c.running && c.sessionId && typeof bridge.local?.resumeAgent === "function") {
      c.running = true;
      c.exitCode = null;
      signalConsolesChanged();
      bridge.local.resumeAgent(c.agent, c.root, c.sessionId, { model: c.model, mode: c.mode }).then((r) => {
        if (!r || !r.ok) {
          c.running = false;
          pushConsoleLine(c, "err", (r && r.error) || "could not continue");
          signalConsolesChanged();
          return;
        }
        // The events for this turn arrive under the NEW process id, so the
        // console has to answer to it — `consoleById` matches on `c.id`.
        c.id = r.id ? String(r.id) : null;
        signalConsolesChanged();
        if (c.id) void bridge.local?.sendToAgent(c.id, text);
      });
      return;
    }

    /* ⚠️ NOT A SILENT RETURN. The user line and the transcript entry are
       already appended above, so dropping here showed the prompt as sent and
       never sent it — the console just sits there. Reachable by typing a
       second message inside the `startAgent` round trip. Say so instead. */
    if (!c.id) {
      pushConsoleLine(c, "err", "still starting — send that again in a moment");
      signalConsolesChanged();
      return;
    }
    bridge.local?.sendToAgent(c.id, text).then((r) => {
      if (r && r.ok === false) {
        pushConsoleLine(c, "err", r.error || "could not send");
      }
      signalConsolesChanged();
    });
  },

  openLocalRoot: (dir) => {
    closeEditor();
    // Which repo you had open, so the next launch can put it back. See
    // `restoreLastRoot` for why this is the renderer's job and not main's.
    try {
      localStorage.setItem(LAST_ROOT_KEY, dir);
    } catch {
      // Private mode, cleared site data, a quota that is full: the app works
      // without this and re-picking a folder is not a failure worth reporting.
    }
    /* ⚠️ THE INDEX LINE BELONGS TO A FOLDER. "done — 812 indexed, 40 skipped"
       is only ever written and never cleared, so it stayed pinned in Settings
       after the build that produced it — and after you opened a DIFFERENT
       repo, where it sat directly under "Index: not built for this folder",
       contradicting it. Reset alongside `stats` just below, for the same
       reason: both describe the repo being replaced. */
    set({ index: { state: null, barPct: 0, progressText: "ready" } });
    set((g) => ({
      stats: { lines: Object.create(null) as Stats["lines"], diff: null, root: null },
      localRoot: dir,
      localEntries: null,
      localFile: null,
      localError: null,
      localTruncated: null,
      selectedPath: g.selectedPath,
    }));
    bridge.local?.tree(dir).then((r) => {
      if (r && r.ok) {
        /* A CUT-SHORT TREE IS NOT A FAILED ONE. This wrote the truncation
           notice into `localError`, and the rail renders localError as a row
           under the folder picker - so opening any large repo printed
           "showing the first 4000 entries" into the bottom corner, styled as
           a fault, in the space that was just reclaimed by dropping the Repos
           header. Found by opening masora2 in the running app.

           Two readers, two meanings, so two fields: the rail shows only real
           failures, the tree says its own list is partial, and provenance.tsx
           - which rightly treats BOTH as "the tree cannot confirm this path"
           - reads them together. */
        set({
          localEntries: r.entries || null,
          localError: null,
          localTruncated: r.truncated
            ? `showing the first ${(r.entries || []).length} entries`
            : null,
        });
      } else {
        set({
          localEntries: [],
          localError: (r && r.error) || "could not read that folder",
          localTruncated: null,
        });
      }
      get().refreshStats(true);
    });
  },

  unsetLocalRoot: () => {
    closeEditor();
    try {
      localStorage.removeItem(LAST_ROOT_KEY);
    } catch {
      // See openLocalRoot.
    }
    set({ localRoot: null, localEntries: null, localFile: null, selectedPath: null });
  },

  addWorkspace: () => {
    bridge.local?.addWorkspace().then((w) => {
      if (w) {
        void get().refreshLocalWorkspaces().then(() => get().openLocalRoot(w.dir));
      }
    });
  },

  refreshLocalAgents: () => {
    if (!bridge.local) return;
    bridge.local.agents().then((list) => {
      set({ localAgents: list || [] });
      // The composer can start a run, so it needs to know what to start
      // before anybody has opened the picker.
      get().adoptDefaultAgent();
    });
  },

  /** Pick a default agent as soon as we know which ones exist.
   *
   *  The composer has to be able to start SOMETHING the moment it is typed
   *  into, and "whichever is installed and signed in" is the only answer that
   *  does not make somebody choose before they have said anything. Preference
   *  order is the one the launcher shows: the first usable, signed-in agent. */
  adoptDefaultAgent: (): void => {
    const g = get();
    if (g.launchAgent) return;
    const usable = g.localAgents.filter((a) => a.ok);
    const pick = usable.find((a) => a.signedIn) || usable[0];
    if (pick) set({ launchAgent: pick.name });
  },

  refreshLocalWorkspaces: (): Promise<void> => {
    if (!bridge.local) return Promise.resolve();
    return bridge.local.workspaces().then((list) => set({ localWorkspaces: list || [] }));
  },

  refreshStats: (force) => {
    void refreshCommits();
    void refreshSchedules();
    void refreshMemories();
    void refreshAgentSettings();
    const g = get();
    if (!bridge.local || !g.localRoot || !g.localEntries) return;
    const now = Date.now();
    if (!force && now - g.statsAt < STATS_EVERY_MS) {
      if (!g.statsPending) {
        set({ statsPending: true });
        window.setTimeout(() => set({ statsPending: false }), STATS_EVERY_MS);
      }
      return;
    }
    const root = g.localRoot;
    set({ statsAt: now });
    const paths: string[] = [];
    for (const en of g.localEntries) {
      if (paths.length >= STATS_MAX_PATHS) break;
      if (en.kind !== "dir") paths.push(en.path);
    }
    bridge.local.stats(root, paths).then((r) => {
      if (root !== get().localRoot) return;
      if (!r || !r.ok) return;
      const lines: Record<string, number | undefined> = Object.create(null);
      if (r.lines) Object.assign(lines, r.lines);
      set({ stats: { lines, diff: r.diff || null, root } });
    });
  },

  updateCheck: () => updateCtl().check(),
  updateInstall: () => updateCtl().install(),
  receiveUpdate: (s) => updateCtl().receiveUpdate(s),

  setUpdateChecking: (v) => updateCtl().setBusy({ checking: v }),

  refreshWhoami: () => {
    fetch("/auth/whoami", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => {
        if (r && r.ok) set({ who: { state: r, busy: false } });
      })
      .catch(() => { /* the section says it cannot tell */ });
  },
  setWhoBusy: (v) => set((g) => ({ who: { ...g.who, busy: v } })),

  setIndex: (patch) => set((g) => ({ index: { ...g.index, ...patch } })),
  setIndexStatus: (r) => set({ indexStatus: r }),

  refreshIndexStatus: () => {
    const br = bridge.local;
    if (!br || typeof br.indexStatus !== "function") return;
    void br.indexStatus(useBoard.getState().localRoot).then((r) => {
      if (r && r.ok) useBoard.getState().setIndexStatus(r);
    });
  },

  setPanes: (p) => {
    set({ panes: p });
    try {
      window.localStorage.setItem(PANE_KEY, JSON.stringify(p));
    } catch {
      /* defaults next time */
    }
  },

  /* SESSIONS — everything the two CLIs have written on this machine.
   *
   * Scoped to the open folder by default. 127 sessions here and 625 MB of
   * transcript: "all" is a deliberate second step rather than the landing
   * state, and the desktop side caps what it describes either way. */
  refreshSessions: (force = false) => {
    const g = get();
    if (!bridge.local || typeof bridge.local.sessions !== "function") return;
    if (g.sessions.loading) return;
    if (g.sessions.loaded && !force) return;
    set((st) => ({ sessions: { ...st.sessions, loading: true, error: "" } }));
    const scoped = g.sessions.scope === "repo" ? g.localRoot : null;
    /* ⚠️ WHAT THIS ANSWER IS AN ANSWER TO — the scope AND the folder, because
       a repo-scoped question is different the moment the folder changes.
       Either can change while the fetch is in flight, the `loading` guard
       above swallows the re-fire, and the old answer then lands with
       loaded:true and is never corrected.

       The folder half was the one that bit on every launch: the pane mounts
       and fetches while `localRoot` is still null, so a "repo"-scoped request
       goes out with cwd null and the desktop side answers with EVERY session
       on the machine; `restoreLastRoot` then opens the folder, the effect
       re-fires, the guard eats it, and the pane settled showing all 127
       sessions with "This repo" reading as pressed. */
    const asked = { scope: g.sessions.scope, cwd: scoped };
    bridge.local
      .sessions({ cwd: scoped || null })
      .then((r) => {
        const st0 = get();
        const nowWant = st0.sessions.scope === "repo" ? st0.localRoot : null;
        if (st0.sessions.scope !== asked.scope || nowWant !== asked.cwd) {
          set((st) => ({ sessions: { ...st.sessions, loading: false } }));
          get().refreshSessions(true);
          return;
        }
        set((st) => ({
          sessions: {
            ...st.sessions,
            list: (r && r.sessions) || [],
            total: (r && r.total) || 0,
            loading: false,
            loaded: true,
          },
        }));
      })
      .catch((err: unknown) =>
        set((st) => ({
          sessions: { ...st.sessions, loading: false, loaded: true, error: String(err) },
        })),
      );
  },

  setSessionQuery: (q) => set((st) => ({ sessions: { ...st.sessions, query: q } })),

  setSessionScope: (v) => {
    // The scope changes WHAT THE DESKTOP SIDE READS, not just what is shown,
    // so the list has to be fetched again rather than filtered.
    set((st) => ({ sessions: { ...st.sessions, scope: v, loaded: false } }));
    get().refreshSessions(true);
  },

  /** Read one session and render it in the conversation column.
   *
   *  It replaces the live thread rather than opening beside it: there is one
   *  conversation column, and a read-only transcript is what it is for while
   *  a session is open. `closeSession` puts the live console back. */
  openSession: (summary) => {
    if (!bridge.local || typeof bridge.local.session !== "function") return;
    set((st) => ({
      sessions: {
        ...st.sessions,
        open: summary,
        openTranscript: null,
        openTruncated: false,
        openLoading: true,
        agents: [],
        openAgent: null,
        error: "",
      },
    }));
    /* The subagents, in parallel with the transcript. Nothing depends on the
     * order and the list is one readdir plus a small file per child, so a
     * session with none pays a readdir that fails. */
    if (summary.children > 0 && typeof bridge.local.sessionAgents === "function") {
      bridge.local
        .sessionAgents(summary.slug, summary.id)
        .then((r) => {
          if (get().sessions.open?.id !== summary.id) return;
          set((st) => ({ sessions: { ...st.sessions, agents: (r && r.children) || [] } }));
        })
        .catch(() => {
          /* the transcript is the point; a missing child list is not an error
             worth putting in front of somebody */
        });
    }
    bridge.local
      .session(summary.source, summary.slug, summary.id)
      .then((r) => {
        if (get().sessions.open?.id !== summary.id) return; // a later click won
        if (!r || !r.ok) {
          set((st) => ({
            sessions: {
              ...st.sessions,
              openLoading: false,
              error: (r && r.error) || "could not read that session",
            },
          }));
          return;
        }
        set((st) => ({
          sessions: {
            ...st.sessions,
            openLoading: false,
            openTruncated: Boolean(r.truncated),
            openTranscript: sessionTranscript(r.records, {
              cwd: summary.cwd,
              source: summary.source,
            }),
          },
        }));
      })
      .catch((err: unknown) =>
        set((st) => ({
          sessions: { ...st.sessions, openLoading: false, error: String(err) },
        })),
      );
  },

  /** Read one of the open session's subagents, or (null) go back to the
   *  parent. The parent stays `open` throughout — a subagent is a view INTO a
   *  session, not a session of its own, and leaving it would lose the list. */
  openSessionAgent: (agent) => {
    const parent = get().sessions.open;
    if (!parent || !bridge.local || typeof bridge.local.session !== "function") return;
    set((st) => ({
      sessions: { ...st.sessions, openAgent: agent, openTranscript: null, openLoading: true },
    }));
    bridge.local
      .session(parent.source, parent.slug, parent.id, agent ? agent.id : "")
      .then((r) => {
        const st0 = get().sessions;
        if (st0.open?.id !== parent.id || st0.openAgent?.id !== (agent ? agent.id : undefined)) {
          if (agent || st0.openAgent) return; // a later click won
        }
        if (!r || !r.ok) {
          set((st) => ({
            sessions: {
              ...st.sessions,
              openLoading: false,
              error: (r && r.error) || "could not read that agent",
            },
          }));
          return;
        }
        set((st) => ({
          sessions: {
            ...st.sessions,
            openLoading: false,
            openTruncated: Boolean(r.truncated),
            openTranscript: sessionTranscript(r.records, {
              cwd: parent.cwd,
              source: parent.source,
            }),
          },
        }));
      })
      .catch((err: unknown) =>
        set((st) => ({ sessions: { ...st.sessions, openLoading: false, error: String(err) } })),
      );
  },

  closeSession: () =>
    set((st) => ({
      sessions: {
        ...st.sessions,
        open: null,
        openTranscript: null,
        openTruncated: false,
        openLoading: false,
        agents: [],
        openAgent: null,
      },
    })),

  setVoiceAsk: (url) => set({ voiceAsk: url }),
  setVoiceHotkey: (k) => set({ voiceHotkey: k }),
  openSettings: () => set({ sheetOpen: true }),
  closeSettings: () => set({ sheetOpen: false }),

  setMyActor: (a) => set({ myActor: a }),

  setEdView: (v) => set({ edView: v }),
  updateEdView: (patch) =>
    set((g) => (g.edView ? { edView: { ...g.edView, ...patch } } : {})),
  setDocStatus: (room, st) => set((g) => ({ docStatus: { ...g.docStatus, [room]: st } })),
  syncDocStatus: () => set((g) => ({ docStatus: { ...g.docStatus } })),
  setStripLive: (patch) => set((g) => ({ strip: { ...g.strip, live: { ...g.strip.live, ...patch } } })),
  setStripMachine: (m) =>
    set((g) => {
      // A commit that happened while zevet was watching. The status poll
      // already runs and already carries the sha; it just throws away the fact
      // that it MOVED, which is the only part worth keeping.
      const repo = m && (m.repo as { sha?: string; branch?: string } | undefined);
      const sha = repo && typeof repo.sha === "string" ? repo.sha : null;
      const last = g.checkpoints[g.checkpoints.length - 1];
      const moved = sha && (!last || last.sha !== sha);
      // Only on the edge: a commit is rare and `git log` is a process spawn,
      // so it is read when the sha moves and never on the 4s poll itself.
      if (moved) void refreshCommits();
      return {
        strip: { ...g.strip, machine: m },
        checkpoints: moved
          ? [...g.checkpoints, { sha, branch: String((repo && repo.branch) || ""), ts: Date.now() }].slice(-40)
          : g.checkpoints,
      };
    }),

  tick: 0,
  bumpTick: () => set((g) => ({ tick: (g.tick + 1) % 1_000_000 })),
}));

/* The update state machine, created once and mirrored into the store. The
 * control is deferred so the store exists before its onChange fires. */
let updateCtlHandle: UpdateControl | null = null;
function updateCtl(): UpdateControl {
  if (!updateCtlHandle) {
    updateCtlHandle = createUpdateControl(
      () => bridge.local,
      (u: UpdatesLike) => useBoard.setState({ updates: u as never }),
    );
  }
  return updateCtlHandle;
}

/* ---------------------------------------------------------------------------
 * SELECTOR-FRIENDLY HELPERS
 * ------------------------------------------------------------------------- */

export function serverNow(): number {
  return Date.now() + useBoard.getState().skewMs;
}

export function lastRepo(): string | null {
  const evts = useBoard.getState().events;
  for (let i = evts.length - 1; i >= 0; i--) if (evts[i].repo) return evts[i].repo!;
  return null;
}

function lastRepoOf(events: HubEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].repo) return events[i].repo!;
  return null;
}

export function scoped(): HubEvent[] {
  const g = useBoard.getState();
  return g.events.filter((e) => !g.selectedRepo || e.repo === g.selectedRepo);
}

export function workspaces(): Array<{ repo: string; branch?: string; lastTs: number }> {
  const seen: Array<{ repo: string; branch?: string; lastTs: number }> = [];
  useBoard.getState().events.forEach((e) => {
    if (!e.repo) return;
    const hit = seen.find((w) => w.repo === e.repo);
    if (!hit) seen.push({ repo: e.repo, branch: e.branch, lastTs: e.ts });
    else {
      hit.lastTs = Math.max(hit.lastTs, e.ts);
      if (e.branch) hit.branch = e.branch;
    }
  });
  return seen.sort((a, b) => b.lastTs - a.lastTs);
}

export function hueOf(actor: string | null | undefined): string {
  const i = useBoard.getState().roster.findIndex((r) => r.actor === actor);
  return "var(--who-" + ((i < 0 ? 0 : i) % HUES) + ")";
}

export function isIdle(r: { actor: string; lastTs: number }, now: number): boolean {
  return now - r.lastTs > useBoard.getState().idleAfterMs;
}

/* ---------------------------------------------------------------------------
 * TREE
 * ------------------------------------------------------------------------- */

export interface TreeNode {
  name: string;
  kind: "dir" | "file";
  children: Record<string, TreeNode>;
  who: Record<string, number>;
  lastTs: number;
}

function blankNode(name: string, kind: "dir" | "file"): TreeNode {
  return { name, kind, children: Object.create(null), who: Object.create(null), lastTs: 0 };
}

export function buildTree(): { root: TreeNode; now: number } {
  const now = serverNow();
  const g = useBoard.getState();
  const root = blankNode("", "dir");

  if (bridge.local && g.localEntries) {
    g.localEntries.forEach((entry) => {
      const parts = String(entry.path).split("/").filter(Boolean);
      let node = root;
      parts.forEach((part, i) => {
        const isLast = i === parts.length - 1;
        const kind = isLast ? entry.kind : "dir";
        if (!node.children[part]) node.children[part] = blankNode(part, kind);
        node = node.children[part];
      });
    });
  }

  scoped().forEach((e) => {
    if (!e.target || e.kind !== "tool") return;
    const parts = String(e.target).split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (!node.children[part]) node.children[part] = blankNode(part, isFile ? "file" : "dir");
      node = node.children[part];
      const prev = node.who[e.actor] || 0;
      if (e.ts > prev) node.who[e.actor] = e.ts;
      node.lastTs = Math.max(node.lastTs, e.ts);
    });
  });
  return { root, now };
}

export function collisionSet(): Record<string, boolean> {
  const s: Record<string, boolean> = Object.create(null);
  const g = useBoard.getState();
  g.collisions.forEach((c) => {
    if (g.selectedRepo && c.repo && c.repo !== g.selectedRepo) return;
    s[c.target] = true;
  });
  return s;
}

/* ---------------------------------------------------------------------------
 * PAIRWISE HELPERS USED BY CONSOLES
 * ------------------------------------------------------------------------- */


function pushConsoleLine(c: ConsoleEntry, kind: ConsoleLine["kind"], text: string): void {
  c.lines.push({ kind, text: String(text) });
  if (c.lines.length > 400) c.lines.splice(0, c.lines.length - 400);
}

function signalConsolesChanged(): void {
  const cur = useBoard.getState();
  const c = cur.myConsoles;
  useBoard.setState({ myConsoles: [...c] });
}

/**
 * The console an agent event belongs to.
 *
 * The fallback exists because a console is created here the moment you press
 * Send and only learns its process id when `startAgent` resolves — events can
 * and do arrive inside that window, and dropping them loses the first line of
 * every run.
 *
 * ⚠️ BUT IT USED TO GUESS. `list.find((c) => c.id === null)` returns the FIRST
 * console still waiting for an id, so with two agents started close together —
 * which is the whole point of the rail — B's opening events were folded into
 * A's transcript, usage, limits and session id. Nothing errors; you get one
 * console with two runs in it and one that never speaks.
 *
 * So the fallback applies only while exactly one console is waiting. With two,
 * there is no honest answer and the event is dropped rather than misfiled.
 */
function consoleById(id: string | null | undefined): ConsoleEntry | undefined {
  const list = useBoard.getState().myConsoles;
  const exact = id != null ? list.find((c) => c.id === id) : undefined;
  if (exact) return exact;
  const pending = list.filter((c) => c.id === null);
  return pending.length === 1 ? pending[0] : undefined;
}

/** Fold one decoded stream-json agent event into the store. */
function ingressAgentEvent(evt: { id?: string; type: string; code?: number | null; signal?: string | null; text?: string; payload?: unknown }): void {
  if (evt.type === "agent") {
    const payload = (evt.payload || {}) as { type?: string; model?: string; total_cost_usd?: number };
    if (payload.type === "system" && typeof payload.model === "string") useBoard.getState().setStripLive({ model: payload.model });
    // claude announces its MCP servers in the same init line. Nothing else
    // reports them, and which tools an agent can actually reach is worth
    // seeing before you trust what it says it cannot do.
    const announced = (payload as { mcp_servers?: unknown }).mcp_servers;
    if (Array.isArray(announced) && announced.length) {
      const c0 = consoleById(evt.id);
      if (c0) {
        const servers = announced
          .map((raw) => {
            const o = (raw || {}) as { name?: unknown; status?: unknown; tools?: unknown };
            return {
              name: String(o.name ?? "server"),
              status: String(o.status ?? "connected"),
              tools: Array.isArray(o.tools) ? o.tools.map((t) => String(t)) : [],
            };
          })
          .filter((s) => s.name);
        useBoard.setState((g) => ({ mcpServers: { ...g.mcpServers, [c0.key]: servers } }));
      }
    }
    /* The session id, which every claude payload carries and codex announces
       once as `thread_id`. It is what `--resume` / `exec resume` take, so it
       is the difference between being able to ask again from here and not. */
    const sid = sessionIdOf(payload);
    if (sid) {
      const cs = consoleById(evt.id);
      if (cs && cs.sessionId !== sid) {
        cs.sessionId = sid;
        signalConsolesChanged();
      }
    }

    /* The provider's own rate-limit windows and the model's real context
       window. Both arrive on payloads nothing used to read: `rate_limit_event`
       every turn, and `modelUsage` on the result. */
    const limits = limitsOf(payload);
    const window = windowOf(payload);
    if (limits || window != null) {
      const cl = consoleById(evt.id);
      if (cl) {
        if (limits) cl.limits = limits;
        if (window != null) cl.usage = { ...cl.usage, window };
        signalConsolesChanged();
      }
    }

    const u = usageOf(payload);
    const cost = typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : null;
    if (u || cost != null) {
      /* ⚠️ THE STRIP IS ONE SET OF NUMBERS AND THERE CAN BE THREE AGENTS.
         Before this, every usage payload went straight to strip.live, so the
         console that spoke last owned the rail AND the meters under whichever
         thread you happened to be reading. Attribute them first; the strip
         then only takes the ones belonging to the console in front. */
      const cu = consoleById(evt.id);
      if (cu) recordUsage(cu, u, cost);
      const front = selectActiveConsole(useBoard.getState());
      if (!cu || !front || front.key === cu.key) {
        if (u) {
          useBoard.getState().setStripLive({ context: u.context, ...(u.cacheHit != null ? { cacheHit: u.cacheHit } : {}), ...(u.model ? { model: u.model } : {}) });
        }
        if (cost != null) useBoard.getState().setStripLive({ cost });
      }
    }
  }

  const c = consoleById(evt.id);
  if (!c) return;
  if (evt.type === "exit") {
    c.running = false;
    c.exitCode = evt.code ?? null;
    pushConsoleLine(c, "meta", `agent exited (${evt.code === null ? "signal " + evt.signal : "code " + evt.code})`);
    c.transcript = closeTranscript(c.transcript, { code: evt.code ?? null });
  } else if (evt.type === "stderr") {
    /* ⚠️ STDERR IS NOT THE AGENT SPEAKING, and it used to be rendered as if it
       were. This called `appendRaw`, which appends to the OPEN ASSISTANT
       MESSAGE — so a codex run whose unrelated MCP servers failed to
       authenticate opened with a wall of
       "ERROR rmcp::transport::worker: worker quit with fatal: Transport
       channel closed" in the agent's own voice, as its answer. Found by
       running a real codex turn through the board.

       It goes to `lines` only, which components/rawoutput.tsx shows as what it
       is: the process's stderr, labelled. Nothing is lost — that panel is why
       `lines` exists. */
    pushConsoleLine(c, "err", evt.text || "");
  } else if (evt.type === "agent") {
    const payload = (evt.payload || {}) as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
      part?: { type?: string; text?: string; tool?: string; state?: { title?: string; input?: unknown }; reason?: string; tokens?: unknown };
      error?: { message?: string; name?: string };
      text?: string;
      terminal_reason?: string;
      subtype?: string;
    };
    const localRoot = useBoard.getState().localRoot;
    for (const [k, text] of classifyAgent(payload, localRoot)) {
      pushConsoleLine(c, k as ConsoleLine["kind"], text);
    }
    c.transcript = appendAgentPayload(c.transcript, evt.payload, { agent: c.agent, localRoot });
  } else if (evt.type === "stdout-line") {
    pushConsoleLine(c, "out", evt.text || "");
    c.transcript = appendRaw(c.transcript, evt.text || "");
  }
  signalConsolesChanged();
}

function classifyAgent(
  p: {
    type?: string;
    message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
    part?: { type?: string; text?: string; tool?: string; state?: { title?: string; input?: unknown }; reason?: string; tokens?: unknown };
    error?: { message?: string; name?: string };
    text?: string;
    terminal_reason?: string;
    subtype?: string;
  },
  localRoot: string | null,
): Array<[ConsoleLinePartKind, string]> {
  const out: Array<[ConsoleLinePartKind, string]> = [];
  if (p.type === "assistant" && p.message && Array.isArray(p.message.content)) {
    for (const part of p.message.content) {
      if (part.type === "text" && part.text) out.push(["out", part.text]);
      if (part.type === "tool_use") out.push(["tool", String(part.name) + "  " + shortInput(part.input, localRoot)]);
    }
  } else if (p.type === "result") {
    out.push(["meta", "turn finished (" + (p.terminal_reason || p.subtype || "done") + ")"]);
  } else if (p.type === "text" && p.part && p.part.type === "text" && p.part.text) {
    out.push(["out", p.part.text]);
  } else if (p.type === "tool_use" && p.part && p.part.type === "tool") {
    const ost = (p.part.state || {}) as { title?: string; input?: unknown };
    const about = ost.title || shortInput(ost.input, localRoot);
    out.push(["tool", (p.part.tool || "tool") + (about ? "  " + about : "")]);
  } else if (p.type === "step_finish") {
    out.push(["meta", "turn finished (" + ((p.part && p.part.reason) || "done") + ")"]);
  } else if (p.type === "error") {
    const err = p.error;
    out.push(["err", (err && (err.message || err.name)) || "agent error"]);
  }
  return out;
}

/** The usage on one stream-json line. Feeds the live strip, not the rolling
 *  totals. Must agree with desktop/status-sources.js usageFrom(). */
/** How many context readings one console keeps. A long run reports a usage
 *  payload per turn; the chart is 300px wide and the shape of the last 120 is
 *  the whole story. */
const SERIES_CAP = 120;

/** Fold one usage reading into the console that reported it. Mutates, as every
 *  other console update here does — `signalConsolesChanged` publishes. */
function recordUsage(c: ConsoleEntry, u: UsageReading | null, cost: number | null): void {
  const prev = c.usage;
  const next = { ...prev };
  if (u) {
    next.context = u.context;
    if (u.cacheHit != null) next.cacheHit = u.cacheHit;
    if (u.model) next.model = u.model;
    next.input = u.input;
    next.cachedInput = u.cachedInput;
    next.output = u.output;
    // Only a reading that MOVED is a new point. claude repeats the same usage
    // block on several payloads of one turn, and a flat run of identical
    // points draws a line that says the context stalled.
    if (prev.series[prev.series.length - 1] !== u.context) {
      next.series = [...prev.series, u.context].slice(-SERIES_CAP);
    }
  }
  if (cost != null) next.cost = cost;
  c.usage = next;
}

/**
 * The agent's own id for this session.
 *
 * claude puts `session_id` on every payload; codex announces `thread_id` once
 * on `thread.started`. opencode says neither, and an agent that does not name
 * its session cannot be resumed — which is why the panels that fork a run
 * check for this rather than assuming it.
 */
function sessionIdOf(payload: unknown): string | null {
  const p = (payload || {}) as { session_id?: unknown; thread_id?: unknown; sessionID?: unknown };
  // Three CLIs, three spellings, all measured: claude `session_id`, codex
  // `thread_id` on thread.started, opencode `sessionID` on every event.
  const id = p.session_id ?? p.thread_id ?? p.sessionID;
  return typeof id === "string" && id ? id : null;
}

/**
 * The provider's rate-limit windows, as the agent reported them.
 *
 * ⚠️ THE OLD NOTE SAID THESE DID NOT EXIST, AND IT WAS TRUE WHEN WRITTEN.
 * `desktop/status-sources.js` states flatly that a headless agent's stream-json
 * does not carry the 5h/7d numbers and that zevet must not start pretending to
 * know them. Measured again 2026-09-21 against claude 2.1.278, it now does:
 *
 *   {"type":"rate_limit_event","rate_limit_info":{
 *      "status":"allowed","resetsAt":1789972800,"rateLimitType":"five_hour",
 *      "unifiedWindows":{"five_hour":{"utilization":0.11,"resetsAt":…},
 *                        "seven_day":{"utilization":0.11,"resetsAt":…}}}}
 *
 * So this reads what is there and nothing else. `utilization` is a ratio the
 * provider computed; `resetsAt` is in SECONDS in the payload and milliseconds
 * everywhere in this store. An agent that reports none of it gets an empty
 * list, which is the difference between "not reported" and "zero used".
 */
function limitsOf(payload: unknown): RateWindow[] | null {
  const p = payload as { type?: string; rate_limit_info?: unknown } | null;
  if (!p || p.type !== "rate_limit_event") return null;
  const info = p.rate_limit_info as { unifiedWindows?: Record<string, unknown> } | undefined;
  const windows = info && info.unifiedWindows;
  if (!windows || typeof windows !== "object") return null;

  const out: RateWindow[] = [];
  for (const [key, raw] of Object.entries(windows)) {
    const w = (raw || {}) as { utilization?: unknown; resetsAt?: unknown };
    if (typeof w.utilization !== "number" || !isFinite(w.utilization)) continue;
    out.push({
      key,
      utilization: w.utilization,
      resetsAt: typeof w.resetsAt === "number" && isFinite(w.resetsAt) ? w.resetsAt * 1000 : 0,
    });
  }
  return out.length ? out : null;
}

/**
 * The model's real context window, off the result payload's `modelUsage`.
 *
 * There is one entry per model the run touched; a run that switched models has
 * more than one, and the LARGEST is the window the conversation is being
 * carried in. Absent for an agent that does not report it, and the 200k floor
 * stays the fallback rather than becoming the answer.
 */
function windowOf(payload: unknown): number | null {
  const mu = (payload as { modelUsage?: Record<string, unknown> } | null)?.modelUsage;
  if (!mu || typeof mu !== "object") return null;
  let best = 0;
  for (const raw of Object.values(mu)) {
    const n = (raw as { contextWindow?: unknown } | null)?.contextWindow;
    if (typeof n === "number" && isFinite(n) && n > best) best = n;
  }
  return best > 0 ? best : null;
}

/** One usage reading, with the parts kept.
 *
 *  `context` and `cacheHit` are what the strip has always shown. The three
 *  raw counts beside them exist because a panel that says "cached" ought to
 *  print the number the agent reported rather than a share recovered from a
 *  rounded percentage. `cachedInput` is the READ cache only — cache creation
 *  is fresh input that happens to have been written down. */
interface UsageReading {
  context: number;
  cacheHit: number | null;
  model: string | null;
  input: number;
  cachedInput: number;
  output: number;
}

function usageOf(payload: { message?: { usage?: unknown; model?: string }; usage?: unknown; part?: { tokens?: unknown }; model?: string }): UsageReading | null {
  if (!payload || typeof payload !== "object") return null;
  const u = ((payload.message && payload.message.usage) || payload.usage) as { input_tokens?: unknown; cache_read_input_tokens?: unknown; cached_input_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_write_input_tokens?: unknown; output_tokens?: unknown } | undefined;
  const tokens = payload.part && payload.part.tokens;
  if ((!u || typeof u !== "object") && tokens && typeof tokens === "object") {
    const ti = tokens as { input?: unknown; output?: unknown };
    const n2 = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);
    const cx = n2(ti.input);
    if (!cx && !n2(ti.output)) return null;
    // opencode reports input and output and says nothing about caching, so
    // the cache share is 0 rather than unknown-shown-as-something.
    return { context: cx, cacheHit: cx > 0 ? 0 : null, model: null, input: cx, cachedInput: 0, output: n2(ti.output) };
  }
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : 0);

  /* ⚠️ TWO CLIs, TWO SPELLINGS, AND ONE OF THEM MEASURES DIFFERENTLY.
   *
   * claude reports `cache_read_input_tokens` ALONGSIDE `input_tokens`: the
   * window is the sum of the three. codex reports `cached_input_tokens` as a
   * SUBSET of its `input_tokens` (measured 2026-09-21: input 17,039 of which
   * cached 9,984), so adding them would count the cache twice and report a
   * context nearly 60% larger than the one the agent is actually carrying.
   *
   * Before this, codex matched neither spelling, so every codex turn read as a
   * 0% cache hit — wrong, and wrong in the flattering direction. */
  const codexStyle = u.cached_input_tokens !== undefined;
  const read = codexStyle ? n(u.cached_input_tokens) : n(u.cache_read_input_tokens);
  const written = codexStyle ? n(u.cache_write_input_tokens) : n(u.cache_creation_input_tokens);
  const context = codexStyle ? n(u.input_tokens) + written : n(u.input_tokens) + read + written;
  if (!context && !n(u.output_tokens)) return null;
  return {
    context,
    cacheHit: context > 0 ? (read / context) * 100 : null,
    model: (payload.message && (payload.message as { model?: string }).model) || payload.model || null,
    input: Math.max(0, context - read),
    cachedInput: read,
    output: n(u.output_tokens),
  };
}

/* ---------------------------------------------------------------------------
 * FOLLOW / SELECTION
 * ------------------------------------------------------------------------- */

export function toggleSelection(path: string): void {
  const g = useBoard.getState();
  const next = g.selectedPath === path ? null : path;
  if (next && bridge.local && g.localRoot) {
    /* ⚠️ THE SELECTION ITSELF WAS NEVER RECORDED. This opened the file and
       stopped; nothing on either branch below ever SET `selectedPath`, only
       cleared it. Two consequences, both visible: tree.tsx renders
       `data-sel={selectedPath === path}` so no row ever highlighted — measured
       in the running app with 438 files and 0 selected after a click — and
       `next` above could never come back null, so clicking the open file
       re-opened it instead of toggling it closed, which is the one thing this
       function is named for. */
    useBoard.setState({ selectedPath: next });
    if (window.zevetEditor) openEditor(next);
    else openLocalFile(next);
  } else {
    useBoard.getState().clearSelectedPath();
    if (!next) closeEditor();
  }
}

function followEvent(e: HubEvent): void {
  const g = useBoard.getState();
  if (g.followMode === "off") return;
  if (!e || e.kind !== "tool" || !e.target || !e.repo) return;
  const myActor = g.myActor;
  if (g.followMode === "mine" && (!myActor || e.actor !== myActor)) return;
  const patch: Partial<BoardState> = {};
  if (g.selectedRepo !== e.repo) patch.selectedRepo = e.repo;
  if (g.selectedPath === e.target) {
    if (Object.keys(patch).length) useBoard.setState(patch);
    return;
  }
  const canOpen =
    bridge.local && g.localRoot &&
    String(g.localRoot).split("\\").join("/").split("/").pop() === e.repo;
  if (canOpen) {
    pendingAgentLine = { repo: e.repo, target: e.target! };
    toggleSelection(e.target);
  } else {
    patch.selectedPath = e.target;
  }
  useBoard.setState(patch);
}

/* ---------------------------------------------------------------------------
 * LOCAL VIEWER (no editor bundle)
 * ------------------------------------------------------------------------- */

function openLocalFile(relPath: string): void {
  const br = bridge.local;
  const root = useBoard.getState().localRoot;
  if (!br || !root) return;
  useBoard.setState({ localFile: { path: relPath, loading: true } as LocalFileData });
  br.read(root, relPath).then((r) => {
    useBoard.setState({
      localFile: r && r.ok
        ? { path: relPath, text: r.text, truncated: r.truncated, bytes: r.bytes }
        : { path: relPath, error: (r && r.error) || "could not read it" },
    });
  });
}

export function setLocalFileForSelected(): void {
  /* the viewer state lives in the store directly */
}

/* ---------------------------------------------------------------------------
 * THE EDITOR
 * ------------------------------------------------------------------------- */

const Y_TEXT = "content";
const SEED_CLIENT_ID = 1;
const MSG_DOC = 0;
const MSG_AWARENESS = 1;
const SEED_GRACE_MS = 500;
const SAVE_AFTER_MS = 700;

type EditorBundle = {
  Y: {
    Doc: new () => unknown;
    applyUpdate: (doc: unknown, u: Uint8Array, origin: string) => void;
    encodeStateAsUpdate: (doc: unknown) => Uint8Array;
    createRelativePositionFromJSON: (o: unknown) => unknown;
    createAbsolutePositionFromRelativePosition: (r: unknown, d: unknown) => { index: number } | null;
  };
  Awareness: new (doc: unknown) => unknown;
  awarenessProtocol: {
    applyAwarenessUpdate: (a: unknown, b: Uint8Array, origin: string) => void;
    encodeAwarenessUpdate: (a: { clientID: number }, c: number[]) => Uint8Array;
    removeAwarenessStates: (a: unknown, c: number[], origin: string) => void;
  };
  createEditor: (o: unknown) => unknown;
  languageForPath: (p: string) => string;
} | null;

function zevetEditorBundle(): EditorBundle {
  return (window.zevetEditor as EditorBundle | undefined) || null;
}

function tagged(kind: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = kind;
  out.set(bytes, 1);
  return out;
}

function roomFor(root: string, relPath: string): string {
  const repo = useBoard.getState().selectedRepo;
  let r = repo;
  if (!r && root) r = String(root).replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? null;
  return (r || "repo") + ":" + relPath;
}

function cssColour(varExpr: string): string {
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(String(varExpr));
  if (!m) return String(varExpr);
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]);
  return (v || "").trim() || "#2f6f8f";
}

export function closeEditor(): void {
  if (!ed) return;
  const e = ed;
  ed = null;
  if (e.seedTimer) window.clearTimeout(e.seedTimer);
  if (e.saveTimer) window.clearTimeout(e.saveTimer);
  (e.unsub || []).forEach((fn) => {
    try { fn(); } catch { /* already detached */ }
  });
  if (e.watching && bridge.local && typeof bridge.local.unwatch === "function") {
    try { void bridge.local.unwatch(e.root, e.relPath); } catch { /* nothing to undo */ }
  }
  const doc = window.zevetDoc as { send?: (r: string, b: Uint8Array) => void; leave?: (r: string) => void; onMessage?: never } | undefined;
  const E = zevetEditorBundle();
  if (bridge.canShare && e.room && doc && E) {
    try {
      if (e.awareness) {
        const a = e.awareness as { clientID: number };
        E.awarenessProtocol.removeAwarenessStates(e.awareness, [a.clientID], "local");
        const gone = E.awarenessProtocol.encodeAwarenessUpdate({ clientID: a.clientID }, [a.clientID]);
        doc.send?.(e.room, tagged(MSG_AWARENESS, gone));
      }
    } catch { /* socket already gone */ }
    try { doc.leave?.(e.room); } catch { /* ditto */ }
  }
  if (e.destroyView) {
    try { e.destroyView(); } catch { /* ditto */ }
  }
  if (e.ydoc && E && "destroy" in (e.ydoc as object)) {
    try { (e.ydoc as { destroy: () => void }).destroy(); } catch { /* ditto */ }
  }
  useBoard.getState().setEdView(null);
}

/** Open `relPath` for editing. The read comes first and always: with no peers
 *  and no write capability this still shows the file. */
export function openEditor(relPath: string): void {
  closeEditor();
  const br = bridge.local;
  const root = useBoard.getState().localRoot;
  if (!br || !root) return;

  const mine: EditorSession = {
    root,
    relPath,
    room: roomFor(root, relPath),
    text: null,
    bom: false,
    eol: "lf",
    truncated: false,
    loading: true,
    error: null,
    dirty: false,
    saving: false,
    savedAt: 0,
    lastWritten: null,
    watching: false,
    seeded: false,
    seedTimer: null,
    saveTimer: null,
    unsub: [],
    agentLine: null,
    ydoc: null,
    awareness: null,
    view: null,
    destroyView: null,
    setDark: null,
    getText: null,
    setText: null,
  };
  ed = mine;
  publishEdView(mine);

  void br.read(root, relPath).then(
    (r) => {
      if (ed !== mine) return;
      mine.loading = false;
      if (!r || !r.ok) {
        mine.error = (r && r.error) || "could not read it";
        publishEdView(mine);
        return;
      }
      mine.text = r.text ?? null;
      mine.bom = Boolean(r.bom);
      mine.eol = r.eol || "lf";
      mine.truncated = Boolean(r.truncated);
      mine.lastWritten = r.text ?? null;
      publishEdView(mine);
      requestAnimationFrame(() => mountEditor(mine));
    },
    (err) => {
      if (ed !== mine) return;
      mine.loading = false;
      mine.error = String((err && (err as Error).message) || err);
      publishEdView(mine);
    },
  );
}

function publishEdView(e: EditorSession): void {
  const g = useBoard.getState();
  const st = g.docStatus[e.room];
  g.setEdView({
    root: e.root,
    relPath: e.relPath,
    room: e.room,
    loading: e.loading,
    error: e.error,
    truncated: e.truncated,
    dirty: e.dirty,
    saving: e.saving,
    savedAt: e.savedAt,
    watching: e.watching,
    shareState: bridge.canShare ? ((st && st.state) || "connecting") : "solo",
    shareDetail: (st && st.detail) || "",
  });
}

async function mountEditor(e: EditorSession): Promise<void> {
  if (!ed || ed !== e || e.view) return;
  const host = document.getElementById("edHost");
  if (!host) return;
  const E = zevetEditorBundle();
  if (!E) return;

  const shareable = bridge.canShare && !e.truncated;

  if (shareable) {
    const Doc = E.Y.Doc;
    const Awareness = E.Awareness;
    e.ydoc = new Doc();
    e.awareness = new Awareness(e.ydoc);
    const a = e.awareness as { setLocalStateField: (k: string, v: unknown) => void; clientID: number };
    a.setLocalStateField("user", {
      name: useBoard.getState().myActor || "me",
      color: cssColour(hueOf(useBoard.getState().myActor)),
      colorLight: cssColour(hueOf(useBoard.getState().myActor)) + "33",
    });
    joinRoom(e);
  }

  const handle = E.createEditor({
    parent: host,
    doc: shareable ? e.ydoc : null,
    awareness: shareable ? e.awareness : null,
    text: shareable ? "" : (e.text || ""),
    language: E.languageForPath(e.relPath),
    dark: useBoard.getState().theme === "dark",
    readOnly: !bridge.canWrite || Boolean(e.truncated),
    onChange: () => onLocalEdit(e),
  }) as {
    view: { dom: HTMLElement; scrollDOM: HTMLElement; state: { doc: { length: number; lines: number }; line: (n: number) => { from: number } }; lineBlockAt: (p: number) => { top: number } };
    getText: () => string;
    setText: (t: string) => void;
    destroy: () => void;
    setDark: (d: boolean) => void;
  };
  e.view = handle.view;
  e.getText = () => handle.getText();
  e.setText = (t) => handle.setText(t);
  e.destroyView = handle.destroy;
  e.setDark = handle.setDark;

  if (!shareable) e.seeded = true;

  void watchFile(e);

  if (e.awareness) {
    const onAware = () => {
      if (ed === e) drawRiders();
    };
    (e.awareness as unknown as { on: (t: string, f: () => void) => void }).on("change", onAware);
    e.unsub.push(() => {
      (e.awareness as unknown as { off: (t: string, f: () => void) => void }).off("change", onAware);
    });
  }
  if (e.view) {
    const sc = e.view.scrollDOM;
    const onScroll = () => drawRiders();
    sc.addEventListener("scroll", onScroll, { passive: true });
    e.unsub.push(() => sc.removeEventListener("scroll", onScroll));
  }
  void refreshAgentLine(e, false);
  if (pendingAgentLine && useBoard.getState().localRoot && e.relPath === pendingAgentLine.target) {
    const rootName = String(useBoard.getState().localRoot).split("\\").join("/").split("/").pop();
    if (pendingAgentLine.repo === rootName) {
      pendingAgentLine = null;
      void refreshAgentLine(e, true);
    }
  }
  drawRiders();
}

function joinRoom(e: EditorSession): void {
  const doc = window.zevetDoc as {
    onMessage: (f: (m: { room?: string; kind?: string; bytes?: Uint8Array }) => void) => () => void;
    onStatus: (f: (st: { room: string; state: string; detail?: string }) => void) => () => void;
    send: (room: string, bytes: Uint8Array, opts?: { snapshot?: boolean }) => void;
    join: (room: string) => Promise<{ ok: boolean; error?: string } | undefined>;
  } | null;
  if (!doc) return;
  const E = zevetEditorBundle();
  if (!E) return;

  e.unsub.push(doc.onMessage((m) => {
    if (!ed || ed !== e || m.room !== e.room) return;
    if (m.kind === "ready") {
      void sendState(e);
      if (e.seedTimer) window.clearTimeout(e.seedTimer);
      e.seedTimer = window.setTimeout(() => seedIfEmpty(e), SEED_GRACE_MS);
    } else if (m.kind === "update" && m.bytes && m.bytes.length) {
      const body = m.bytes.subarray(1);
      if (m.bytes[0] === MSG_AWARENESS) {
        E.awarenessProtocol.applyAwarenessUpdate(e.awareness, body, "remote");
      } else {
        E.Y.applyUpdate(e.ydoc, body, "remote");
      }
    } else if (m.kind === "snapshot-due") {
      void sendState(e, true);
    }
  }));

  e.unsub.push(doc.onStatus((st) => {
    useBoard.getState().setDocStatus(e.room, { state: st.state, detail: st.detail });
    if (ed === e) publishEdView(e);
  }));

  const ydoc = e.ydoc as { on: (t: string, f: (u: unknown, o: unknown) => void) => void; off: (t: string, f: (u: unknown, o: unknown) => void) => void };
  const onUpdate = (_u: unknown, origin: unknown) => {
    if (origin === "remote") return;
    doc.send(e.room, tagged(MSG_DOC, (_u as { v: Uint8Array }).v));
    if (ed === e) scheduleSave(e);
  };
  ydoc.on("update", onUpdate);
  e.unsub.push(() => ydoc.off("update", onUpdate));

  const awareness = e.awareness as { on: (t: string, f: (c: { added: number[]; updated: number[]; removed: number[] }, o: unknown) => void) => void; off: (t: string, f: (c: { added: number[]; updated: number[]; removed: number[] }, o: unknown) => void) => void; clientID: number };
  const onAwareness = (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "remote") return;
    const changed = changes.added.concat(changes.updated, changes.removed);
    if (!changed.length) return;
    const bytes = E.awarenessProtocol.encodeAwarenessUpdate({ clientID: awareness.clientID }, changed);
    doc.send(e.room, tagged(MSG_AWARENESS, bytes));
  };
  awareness.on("update", onAwareness);
  e.unsub.push(() => awareness.off("update", onAwareness));

  void doc.join(e.room).then((r) => {
    if (r && r.ok) return;
    useBoard.getState().setDocStatus(e.room, { state: "error", detail: (r && r.error) || "could not join" });
    if (ed === e) publishEdView(e);
  });
}

async function sendState(e: EditorSession, snapshot?: boolean): Promise<void> {
  if (!e.ydoc) return;
  const E = zevetEditorBundle();
  const doc = window.zevetDoc as { send: (r: string, b: Uint8Array, o?: { snapshot?: boolean }) => void } | null;
  if (!E || !doc) return;
  doc.send(e.room, tagged(MSG_DOC, E.Y.encodeStateAsUpdate(e.ydoc)), snapshot ? { snapshot: true } : undefined);
  if (!snapshot && e.awareness) {
    const a = e.awareness as { clientID: number };
    const mine = E.awarenessProtocol.encodeAwarenessUpdate({ clientID: a.clientID }, [a.clientID]);
    doc.send(e.room, tagged(MSG_AWARENESS, mine));
  }
}

function seedIfEmpty(e: EditorSession): void {
  if (!ed || ed !== e || e.seeded || !e.ydoc) return;
  const E = zevetEditorBundle();
  if (!E) return;
  const ydoc = e.ydoc as { getText: (k: string) => { length: number; insert?: (p: number, t: string) => void } };
  const doc = window.zevetDoc as { send: (r: string, b: Uint8Array) => void } | null;

  if (ydoc.getText(Y_TEXT).length > 0) {
    e.seeded = true;
    scheduleSave(e);
    return;
  }

  const seed = new E.Y.Doc() as { clientID: number; getText: (k: string) => { insert: (p: number, t: string) => void }; destroy: () => void };
  seed.clientID = SEED_CLIENT_ID;
  seed.getText(Y_TEXT).insert(0, e.text || "");
  E.Y.applyUpdate(e.ydoc, E.Y.encodeStateAsUpdate(seed), "remote");
  seed.destroy();
  e.seeded = true;
  if (doc) sendState(e);
}

function onLocalEdit(e: EditorSession): void {
  if (ed !== e) return;
  e.dirty = true;
  scheduleSave(e);
  publishEdView(e);
  drawRiders();
}

function scheduleSave(e: EditorSession): void {
  if (!bridge.canWrite || e.truncated) return;
  if (e.saveTimer) window.clearTimeout(e.saveTimer);
  e.saveTimer = window.setTimeout(() => saveNow(e), SAVE_AFTER_MS);
}

function saveNow(e: EditorSession): void {
  if (ed !== e || !bridge.canWrite || e.truncated) return;
  const text = e.getText ? e.getText() : null;
  if (text == null) return;
  if (text === e.lastWritten) {
    e.dirty = false;
    publishEdView(e);
    return;
  }
  e.saving = true;
  publishEdView(e);
  void bridge.local!.write(e.root, e.relPath, text, { bom: e.bom, eol: e.eol }).then((r) => {
    if (ed !== e) return;
    e.saving = false;
    if (r && r.ok) {
      e.lastWritten = text;
      e.dirty = false;
      e.savedAt = Date.now();
      e.error = null;
    } else {
      e.error = (r && r.error) || "could not save";
    }
    publishEdView(e);
    useBoard.getState().refreshStats(false);
  });
}

/** The watcher is subscribed once at boot and routed to the open editor. */
function watchFile(e: EditorSession): void {
  const br = bridge.local;
  if (!br) return;
  if (typeof br.watch !== "function" || typeof br.onFileChanged !== "function") return;
  void br.watch(e.root, e.relPath, e.lastWritten).then((r) => {
    if (ed === e && r && r.ok) {
      e.watching = true;
      publishEdView(e);
    }
  });
}

/** An agent changed the file on disk: fold the text into the shared document
 *  rather than swapping the buffer, so cursors survive and local edits merge. */
function onDiskChanged(e: EditorSession, payload: { text?: string; bom?: boolean; eol?: string }): void {
  if (ed !== e || payload.text == null) return;
  const current = e.getText ? e.getText() : null;
  if (current === payload.text) return;
  if (payload.text === e.lastWritten) return;
  e.bom = Boolean(payload.bom);
  e.eol = payload.eol || e.eol;
  e.lastWritten = payload.text;
  if (e.setText) e.setText(payload.text);
  useBoard.getState().refreshStats(false);
  void refreshAgentLine(e, true);
}

/** Attach the one file-changed listener the watchers report to. */
function attachFileChanged(): void {
  const br = bridge.local;
  if (br && typeof br.onFileChanged === "function") {
    br.onFileChanged((p) => {
      if (!ed || ed.root !== p.root || ed.relPath !== p.relPath) return;
      onDiskChanged(ed, p);
    });
  }
}

/* ---- the riders ------------------------------------------------------- */

function drawRiders(): void {
  const e = ed;
  if (!e || !e.view) return;
  const layer = document.getElementById("riders");
  if (!layer) return;
  const scrolled = e.view.scrollDOM.scrollTop;

  const wanted: Array<{ key: string; name: string; color: string; tool: string | null | undefined; pos: number }> = [];

  const awareness = e.awareness as { clientID: number; getStates: () => Map<number, { user?: { name?: string; color?: string }; cursor?: { head?: unknown } }> } | null;
  if (awareness) {
    const localId = awareness.clientID;
    const docLen = e.view.state.doc.length;
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === localId) return;
      const user = state && state.user;
      const cursor = state && state.cursor;
      // Awareness cursors are Yjs RELATIVE positions — objects, never numbers.
      if (!user || !cursor || cursor.head == null) return;
      const head = absolutePosition(cursor.head);
      if (head == null) return;
      wanted.push({
        key: "peer-" + clientId,
        name: user.name || "",
        color: user.color || "var(--who-0)",
        tool: toolOf(user.name),
        pos: Math.max(0, Math.min(docLen, head)),
      });
    });
  }

  const a = e.agentLine;
  if (a && typeof a.line === "number" && e.view.state && e.view.state.doc) {
    const n = Math.max(1, Math.min(e.view.state.doc.lines, Math.round(a.line)));
    try {
      wanted.push({ key: "agent", name: a.actor || "", color: hueOf(a.actor), tool: a.tool, pos: e.view.state.line(n).from });
    } catch {
      /* document mid-update: no rider this frame */
    }
  }

  // Keyed reconciliation, not wipe-and-rebuild: nodes are moved by transform.
  const alive = new Map<string, HTMLElement>();
  Array.prototype.forEach.call(layer.childNodes, (node: HTMLElement) => {
    const k = node.dataset ? node.dataset.rkey : "";
    if (k) alive.set(k, node);
  });

  for (const w of wanted) {
    let block;
    try {
      block = e.view.lineBlockAt(w.pos);
    } catch {
      return;
    }
    const y = "translateY(" + Math.round(block.top - scrolled) + "px)";
    const node = alive.get(w.key);
    if (node) {
      alive.delete(w.key);
      if (node.style.transform !== y) node.style.transform = y;
      continue;
    }
    const rider = document.createElement("div");
    rider.className = "rider";
    rider.dataset.rkey = w.key;
    rider.style.color = w.color;
    rider.style.setProperty("--zevet-sprite-eye", "var(--paper)");
    rider.style.transform = y;
    const sprite = window.zevetSprites && window.zevetSprites.spriteFor
      ? window.zevetSprites.spriteFor({ tool: w.tool, width: 35, height: 16 })
      : "";
    rider.innerHTML = sprite;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = w.name;
    rider.appendChild(who);
    layer.appendChild(rider);
  }
  for (const node of alive.values()) {
    if (node.parentNode === layer) layer.removeChild(node);
  }
}

function absolutePosition(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  const E = zevetEditorBundle();
  if (!E || !ed) return null;
  try {
    const rel = E.Y.createRelativePositionFromJSON(raw);
    const abs = E.Y.createAbsolutePositionFromRelativePosition(rel, ed.ydoc);
    return abs ? abs.index : null;
  } catch {
    return null;
  }
}

/** he last tool this actor's agent used, off the board's own event feed. Null
 *  is a fine answer — the figure is then empty-handed. */
function toolOf(actor: string | undefined): string | null | undefined {
  if (!actor) return null;
  const evs = scoped();
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].actor === actor && evs[i].kind === "tool" && evs[i].tool) return evs[i].tool;
  }
  return null;
}

async function refreshAgentLine(e: EditorSession, allowScroll: boolean): Promise<void> {
  e.agentLine = null;
  const g = useBoard.getState();
  const br = bridge.local;
  if (!br || !g.localRoot || !e.relPath) { drawRiders(); return; }
  if (g.followMode === "off") { drawRiders(); return; }
  if (typeof br.diffHunks !== "function") { drawRiders(); return; }
  const rootName = String(g.localRoot).split("\\").join("/").split("/").pop();
  const last = lastToolFor(rootName || "", e.relPath);
  if (!last) { drawRiders(); return; }
  try {
    const r = await br.diffHunks(g.localRoot, e.relPath);
    if (ed !== e) return;
    const h = r && r.ok && newestHunk(r.hunks);
    if (!h) { drawRiders(); return; }
    e.agentLine = { actor: last.actor, tool: last.tool, line: h.start };
    drawRiders();
    if (allowScroll && followAllows(last.actor)) scrollToLine(e, h.start);
  } catch {
    if (ed === e) drawRiders();
  }
}

function followAllows(actor: string): boolean {
  const g = useBoard.getState();
  return rosterFollowAllows(g.followMode, actor, g.myActor);
}

function lastToolFor(repoName: string, relPath: string): HubEvent | null {
  return rosterLastToolFor(useBoard.getState().events, repoName, relPath) as HubEvent | null;
}

/** Scroll the editor so a 1-based line lands near the top. Pure geometry. */
function scrollToLine(e: EditorSession, line: number): void {
  try {
    if (!e.view || !e.view.state || !e.view.state.doc) return;
    const count = e.view.state.doc.lines;
    const n = Math.max(1, Math.min(count, Math.round(line) || 1));
    const block = e.view.lineBlockAt(e.view.state.line(n).from);
    e.view.scrollDOM.scrollTop = Math.max(0, block.top - 120);
  } catch {
    /* a document mid-update: stay where we are */
  }
}

function requestMeasureEditor(): void {
  const e = ed;
  if (e && e.view) {
    window.setTimeout(() => {
      try { (e.view as unknown as { requestMeasure?: () => void }).requestMeasure?.(); } catch { /* torn down */ }
    }, 60);
  }
}

/* ---------------------------------------------------------------------------
 * STRIP POLL + UPDATES
 * ------------------------------------------------------------------------- */

function canInstallUpdate(s: UpdateState | null): boolean {
  return canInstallState(
    s,
    () => Boolean(bridge.local && typeof bridge.local.updateInstall === "function"),
  );
}

export { canInstallUpdate };

function pollStatus(): void {
  const br = bridge.local;
  if (!br || typeof br.status !== "function") return;
  const root = useBoard.getState().localRoot;
  void br.status(root).then((r) => {
    if (!r || !r.ok) return;
    useBoard.getState().setStripMachine(r);
  });
}

/* ---------------------------------------------------------------------------
 * CONNECT (SSE)
 * ------------------------------------------------------------------------- */

export function connect(): void {
  const es = new EventSource("/events");
  es.addEventListener("hello", (m) => {
    useBoard.getState().setConn("live");
    useBoard.getState().applySnapshot(JSON.parse((m as MessageEvent).data));
  });
  es.addEventListener("activity", (m: Event) => {
    useBoard.getState().pushEvent(JSON.parse((m as MessageEvent).data) as HubEvent);
  });
  es.onopen = () => {
    useBoard.getState().setConn("live");
  };
  es.onerror = () => {
    fetch("/api/state", { credentials: "same-origin" })
      .then((r) => {
        if (r.status === 401) {
          es.close();
          useBoard.getState().setConn("down");
          useBoard.getState().setNeedsToken(true);
        } else if (r.status === 429) {
          es.close();
          useBoard.getState().setConn("down");
          useBoard.getState().setNeedsToken(false);
        } else {
          useBoard.getState().setConn("down");
          useBoard.getState().setNeedsToken(false);
        }
      })
      .catch(() => useBoard.getState().setConn("down"));
  };
}

/* ---------------------------------------------------------------------------
 * BOOT
 * ------------------------------------------------------------------------- */

const LAST_ROOT_KEY = "zevet.lastRoot.v1";

/**
 * Put back the repo you had open.
 *
 * ⚠️ EVERY LAUNCH USED TO START AT "Open a folder…". `localRoot` is renderer
 * state initialised to null and nothing ever restored it, so opening zevet —
 * or merely reloading it — dropped the workspace, the tree, and the composer's
 * ability to start anything, and you picked the same repo again. The app
 * already knew: `workspaces.json` has held the list the whole time.
 *
 * The LAST OPENED one, not `workspaces[0]`. That list is ordered by when a
 * folder was ADDED (main.js § local:addWorkspace unshifts on pick), which is
 * not the same thing and is wrong for anyone who added a second repo once and
 * works in the first. Recording it here rather than in main keeps this a
 * renderer change, which reaches every install over the hub instead of waiting
 * for an installer.
 *
 * Still checked against the workspace list, because that list is what
 * `knownRoot` in main will accept — a folder removed since is a path every
 * subsequent IPC would refuse, and the greeting is a better outcome than a
 * tree that will not load.
 */
function restoreLastRoot(): void {
  const g = useBoard.getState();
  if (g.localRoot || !g.localWorkspaces.length) return;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LAST_ROOT_KEY);
  } catch {
    saved = null;
  }
  const pick = (saved && g.localWorkspaces.find((w) => w.dir === saved)) || null;
  if (pick) g.openLocalRoot(pick.dir);
}

export function boot(): void {
  const g = useBoard.getState();

  // Identity from the app's REDACTED config (never the secret itself).
  if (bridge.local && window.zevet && typeof (window.zevet as { config?: () => Promise<ZevetConfigLike | null | undefined> }).config === "function") {
    void (window.zevet as { config: () => Promise<ZevetConfigLike | null | undefined> }).config().then((c) => {
      if (!c) return;
      window.__zevetCfg = c as never;
      window.__zevetHub = c.hub;
      if (c.actor) useBoard.getState().setMyActor(c.actor);
    });
  }

  attachFileChanged();
  if (bridge.local && typeof bridge.local.onPermitRequest === "function") {
    /* An agent has asked to do something and is BLOCKED on the answer. There
       is no "later" here: the ask-server denies on timeout, so an unanswered
       question becomes a refusal rather than a hang. */
    bridge.local.onPermitRequest((req) => {
      if (!req || typeof req.id !== "string") return;
      useBoard.setState((g) => ({ permits: [...g.permits, req] }));
    });
  }
  if (bridge.local && typeof bridge.local.onAgentEvent === "function") {
    bridge.local.onAgentEvent(ingressAgentEvent);
  }
  void g.refreshLocalWorkspaces().then(restoreLastRoot);
  void g.refreshLocalAgents();

  // The updater: one state machine drives the rail and Settings, subscribes
  // to pushes from the app, and reads the initial status guarded so that an
  // app push that lands mid-read is not overwritten. See board-updates tests.
  updateCtl().startUpdates();

  if (bridge.local && typeof bridge.local.onIndexEvent === "function") {
    bridge.local.onIndexEvent((p) => {
      if (!p) return;
      const g2 = useBoard.getState();
      if (p.kind === "model" && p.total) {
        g2.setIndex({ barPct: Math.round((p.loaded || 0) / p.total * 100), progressText: `downloading the model \u2014 ${Math.round((p.loaded || 0) / p.total * 100)}%` });
      } else if (p.kind === "index") {
        g2.setIndex({ progressText: `indexing \u2014 ${p.indexed || 0} files`, barPct: 0 });
      } else if (p.kind === "done") {
        g2.setIndex({ barPct: 100 });
      }
    });
  }

  g.refreshWhoami();

  connect();

  if (bridge.local && typeof bridge.local.status === "function") {
    pollStatus();
    window.setInterval(pollStatus, STATUS_EVERY_MS);
  }

  // Cheap each second: refresh the relative "ago" labels that opt in.
  window.setInterval(() => useBoard.getState().bumpTick(), 1000);
}

interface ZevetConfigLike {
  hub?: string;
  actor?: string;
}

/* ---------------------------------------------------------------------------
 * THEME + PANES APPLICATION (pure DOM, run from App)
 * ------------------------------------------------------------------------- */

let lastPositions: { rail: number; tree: number } | null = null;

export function applyTheme(): ColorThemeSent {
  const g = useBoard.getState();
  document.documentElement.setAttribute("data-theme", g.theme);
  if (bridge.local && typeof bridge.local.chrome === "function") {
    const css = getComputedStyle(document.documentElement);
    const spec: ColorThemeSent = {
      theme: g.theme,
      paper: (css.getPropertyValue("--paper") || "").trim(),
      ink: (css.getPropertyValue("--ink") || "").trim(),
      cerulean: (css.getPropertyValue("--cerulean") || "").trim(),
      line: (css.getPropertyValue("--line") || "").trim(),
    };
    bridge.local.chrome(spec);
    return spec;
  }
  return { theme: g.theme, paper: "", ink: "", cerulean: "", line: "" };
}

type ColorThemeSent = { theme: Theme; paper: string; ink: string; cerulean: string; line: string };

/**
 * Read the repo's commits, if this build can.
 *
 * `commits` is optional on the bridge: an older desktop app does not have it,
 * and the board is served to whatever version is installed. An absent method
 * means no checkpoint list, not an error — the same rule every other optional
 * bridge capability follows here.
 */
export async function refreshCommits(): Promise<void> {
  const br = bridge.local;
  const root = useBoard.getState().localRoot;
  if (!br || !root || typeof br.commits !== "function") return;
  try {
    // Deep enough for the activity graph to cover weeks. The checkpoint list
    // takes the first few off the same read.
    const r = await br.commits(root, 200);
    if (r && r.ok && Array.isArray(r.commits)) useBoard.setState({ repoCommits: r.commits });
  } catch {
    // A folder that is not a repo, or a git that is not installed. Neither is
    // worth a message: the list simply does not appear.
  }
}

/**
 * Read this repo's standing instructions, if this build has them.
 *
 * Optional in the same way `commits` is. A build without it shows no settings
 * panel at all, rather than an empty one that appears to save and does not.
 */
export async function refreshAgentSettings(): Promise<void> {
  const br = bridge.local;
  const root = useBoard.getState().localRoot;
  if (!br || !root || typeof br.agentSettings !== "function") return;
  try {
    const r = await br.agentSettings(root);
    if (r && r.ok && r.settings) useBoard.setState({ agentSettings: r.settings });
  } catch {
    // No store yet. No settings, no message.
  }
}

/** Save one or more of them. The desktop app's answer replaces ours rather
 *  than the board guessing what the new state is — the same rule the schedule
 *  toggle follows. */
export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<void> {
  const br = bridge.local;
  const root = useBoard.getState().localRoot;
  if (!br || !root || typeof br.saveAgentSettings !== "function") return;
  try {
    const r = await br.saveAgentSettings(root, patch);
    if (r && r.ok && r.settings) useBoard.setState({ agentSettings: r.settings });
  } catch {
    // Left as it was; the next refresh corrects it.
  }
}

/**
 * Answer one of them.
 *
 * The desktop app is the one holding the agent's call open, so the answer goes
 * there and the request leaves the list either way — a question that has been
 * answered is not still being asked, whichever way it went.
 */
export async function answerPermit(id: string, allow: boolean, reason?: string): Promise<void> {
  const br = bridge.local;
  useBoard.setState((g) => ({ permits: g.permits.filter((p) => p.id !== id) }));
  if (!br || typeof br.permitAnswer !== "function") return;
  try {
    await br.permitAnswer(id, allow, reason);
  } catch {
    // The agent's own timeout denies it. Failing to deliver a "yes" costs an
    // action; failing to deliver a "no" costs nothing, because no is default.
  }
}

/**
 * Ask a finished run something else, without disturbing it.
 *
 * Starts a NEW console forked from this one's session — see `ForkLaunch`. The
 * new console carries the same model and posture, so the only thing that
 * differs between the two answers is the prompt. Does nothing for an agent
 * that never announced a session id (opencode), which is why every caller
 * checks `sessionId` before offering the button.
 */
export function forkConsole(key: number, prompt: string): void {
  const g = useBoard.getState();
  const c = g.myConsoles.find((x) => x.key === key);
  if (!c || !c.sessionId || !prompt.trim()) return;
  g.startAgent(c.agent, { forkFrom: c.sessionId, prompt, model: c.model, mode: c.mode, fromKey: c.key });
}

/**
 * Read the agent's memories for the open repo, if this build can.
 *
 * Optional in the same way `commits` is, and empty for an agent that writes
 * none — which is most of them. Read only: there is no counterpart that
 * deletes one, and the panel offers no forget button because of it.
 */
export async function refreshMemories(): Promise<void> {
  const br = bridge.local;
  const root = useBoard.getState().localRoot;
  if (!br || !root || typeof br.memories !== "function") return;
  try {
    const r = await br.memories(root);
    if (r && r.ok && Array.isArray(r.memories)) useBoard.setState({ memories: r.memories });
  } catch {
    // No memory directory, or no permission to read one. Nothing to show.
  }
}

/** Read the schedules the desktop app holds, if this build has them. */
export async function refreshSchedules(): Promise<void> {
  const br = bridge.local;
  if (!br || typeof br.schedules !== "function") return;
  try {
    const r = await br.schedules();
    if (r && r.ok && Array.isArray(r.schedules)) useBoard.setState({ schedules: r.schedules });
  } catch {
    // An older desktop build, or no store yet. No schedules, no message.
  }
}

/** Flip one on or off. The desktop app owns the list, so its answer replaces
 *  ours rather than the board guessing what the new state is. */
export async function toggleSchedule(id: string): Promise<void> {
  const br = bridge.local;
  if (!br || typeof br.scheduleToggle !== "function") return;
  try {
    const r = await br.scheduleToggle(id);
    if (r && r.ok && Array.isArray(r.schedules)) useBoard.setState({ schedules: r.schedules });
  } catch {
    // Left as it was; the next refresh corrects it.
  }
}

export function applyView(): void {
  const g = useBoard.getState();
  document.body.setAttribute("data-view", g.viewMode);
  document.body.dataset.picked = String(Boolean(g.selectedPath));
  requestMeasureEditor();
}

export function applyPanes(): void {
  const root = document.documentElement;
  const p = useBoard.getState().panes;
  root.style.setProperty("--rail", p.rail + "px");
  root.style.setProperty("--tree", p.tree + "px");
}

export function positionSplits(): void {
  let el = document.querySelector(".shell > .rail");
  const panel = el as HTMLElement | null;
  const shell = document.querySelector(".shell") as HTMLElement | null;
  if (!shell) return;
  const box = shell.getBoundingClientRect();
  const railW = panel ? panel.getBoundingClientRect().width : useBoard.getState().panes.rail;
  const treeEl = document.querySelector(".middle > .treecol") as HTMLElement | null;
  const treeW = treeEl ? treeEl.getBoundingClientRect().width : useBoard.getState().panes.tree;
  lastPositions = { rail: box.left + railW, tree: box.left + railW + treeW };
  document.querySelectorAll<HTMLElement>(".split").forEach((d) => {
    d.style.left = Math.round((lastPositions ? lastPositions[d.dataset.pane as "rail" | "tree"] : 0) || 0) + "px";
    d.style.display = box.width ? "" : "none";
  });
}

export function paneEdgeWidth(pane: "rail" | "tree", clientX: number): number {
  const shell = document.querySelector(".shell") as HTMLElement | null;
  const box = shell ? shell.getBoundingClientRect() : { left: 0, right: window.innerWidth };
  let left = box.left;
  if (pane === "tree" && lastPositions) left += lastPositions.rail - box.left;
  return clientX - left;
}

export function buildSplits(): Array<HTMLElement> {
  const seen = document.querySelectorAll<HTMLElement>(".split");
  if (seen.length) return Array.from(seen);
  const out: HTMLElement[] = [];
  (["rail", "tree"] as const).forEach((pane) => {
    const d = document.createElement("div");
    d.className = "split";
    d.dataset.pane = pane;
    d.setAttribute("aria-hidden", "true");
    document.body.appendChild(d);
    d.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      d.dataset.on = "true";
      const move = (me: PointerEvent) => {
        const lim = PANE_LIMITS[pane];
        const w = clampPaneWidth(paneEdgeWidth(pane, me.clientX), lim[0], lim[1]);
        useBoard.getState().setPanes({ ...useBoard.getState().panes, [pane]: w });
        applyPanes();
        positionSplits();
      };
      const up = () => {
        d.dataset.on = "";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    out.push(d);
  });
  positionSplits();
  return out;
}

/* ===========================================================================
 * SELECTOR SHORTCUTS FOR COMPONENTS
 * =========================================================================== */

export const selectCollapsed = (s: BoardState) => s.collapsed;
export const selectEvents = (s: BoardState) => s.events;
export const selectStats = (s: BoardState) => s.stats;
export const selectRoster = (s: BoardState) => s.roster;
export const selectCollisions = (s: BoardState) => s.collisions;
export const selectMyConsoles = (s: BoardState) => s.myConsoles;
export const selectActiveConsole = (s: BoardState) =>
  s.launching
    ? undefined
    : (s.myConsoles.find((c) => c.key === s.activeConsole) ?? s.myConsoles[s.myConsoles.length - 1]);
export const selectLaunching = (s: BoardState) => s.launching;
export const selectPanes = (s: BoardState) => s.panes;
export const selectStrip = (s: BoardState) => s.strip;
export const selectTheme = (s: BoardState) => s.theme;
export const selectViewMode = (s: BoardState) => s.viewMode;
export const selectEdView = (s: BoardState) => s.edView;
export const selectUpdates = (s: BoardState) => s.updates;
