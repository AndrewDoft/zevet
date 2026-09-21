import type { SessionsResult, SessionResult, SessionAgentsResult } from "./sessions.d.mts";
import type { LocalWorkspace, LocalEntry, UsableAgent, ColorThemeSpec } from "./types";

export interface ReadResult {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  bytes?: number;
  bom?: boolean;
  eol?: string;
  error?: string;
}

export interface StartAgentResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface StatsResult {
  ok: boolean;
  lines?: Record<string, number | undefined>;
  diff?: Record<string, { status: string } | undefined>;
  error?: string;
}

export interface ScheduleRunRecord {
  id: string;
  at: number;
  ok: boolean;
}

export interface AgentSchedule {
  id: string;
  name: string;
  prompt: string;
  agent: string;
  model: string;
  /** Never "dangerous": schedule.js downgrades it. Unattended and unprompted
   *  at the same time is the combination that is refused. */
  mode: string;
  root: string;
  cadence: string;
  enabled: boolean;
  /** ms since epoch. */
  nextAt: number;
  history: ScheduleRunRecord[];
}

export interface SchedulesResult {
  ok: boolean;
  schedules?: AgentSchedule[];
  error?: string;
}

export interface RepoCommit {
  sha: string;
  subject: string;
  /** ms since epoch. */
  at: number;
  files: number;
}

export interface CommitsResult {
  ok: boolean;
  commits?: RepoCommit[];
}

export interface IndexHit {
  path: string;
  startLine: number;
  endLine: number;
  /** Cosine similarity, [-1, 1]. Measured, not a rank. */
  score: number;
  text?: string;
}

export interface IndexSearchResult {
  ok: boolean;
  error?: string;
  hits?: IndexHit[];
}

export interface MemoryNote {
  id: string;
  /** The memory's own one-line description, as it was written. */
  text: string;
  /** ms since epoch. */
  at: number;
  /** Whether the file is newer than it is old — a memory written during this
   *  run of the app, versus one that was already there. */
  fresh: boolean;
}

export interface MemoriesResult {
  ok: boolean;
  dir?: string;
  memories?: MemoryNote[];
}

/** One thing an agent has asked to do, which has not been answered yet. */
export interface PermitRequest {
  id: string;
  /** The MCP tool it wants to call: "click", "type_text", "screenshot"… */
  tool?: string;
  /** Its arguments, as the agent sent them. Untrusted — it is model output.
   *
   *  ⚠️ THE WIRE NAME IS `arguments`. zevet-mcp.js posts `{ tool, arguments }`,
   *  ask-server.js hands that body through unchanged and main.js spreads it
   *  onto the event — so `args` was never once populated and the card that
   *  asks you to hand an agent the mouse showed an empty list of what it would
   *  do. Both are declared because the board ships over the hub and runs
   *  against whatever desktop build is installed. */
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
  /** claude's own description of what it wants, when it sends one. */
  detail?: string;
}

export interface AgentSettings {
  /** Appended to the agent's system prompt. claude only — `--append-system-prompt`
   *  is its flag and the other two CLIs have no equivalent. */
  systemPrompt: string;
  /** Whether an agent started in this repo is handed zevet's own MCP server,
   *  which gives it the screen and the mouse. Off unless explicitly turned on. */
  computerUse: boolean;
}

export interface AgentSettingsResult {
  ok: boolean;
  settings?: AgentSettings | null;
}

export interface StatusResult {
  ok: boolean;
  repo?: { branch?: string; sha?: string; ahead?: number | null; behind?: number | null };
  cindex?: unknown;
  [key: string]: unknown;
}

export interface LocalBridge {
  available: boolean;
  read: (root: string, relPath: string) => Promise<ReadResult>;
  write: (root: string, relPath: string, text: string, opts: { bom?: boolean; eol?: string }) => Promise<{ ok: boolean; error?: string }>;
  agents: () => Promise<UsableAgent[]>;
  startAgent: (name: string, root: string, opts: { model: string; mode: string; forkFrom?: string }) => Promise<StartAgentResult>;
  /** A follow-up to a console whose process has exited. All three CLIs can
   *  resume a session by id (measured 2026-09-21); codex and opencode need a
   *  new process to do it, which is what this is. Optional: an older desktop
   *  build has no resume, and the composer falls back to refusing. */
  resumeAgent?: (
    name: string,
    root: string,
    resumeFrom: string,
    opts: { model: string; mode: string },
  ) => Promise<StartAgentResult>;
  sendToAgent: (id: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  stopAgent: (id: string) => Promise<unknown>;
  watch: (root: string, relPath: string, lastWritten: string | null) => Promise<{ ok: boolean }>;
  unwatch: (root: string, relPath: string) => Promise<unknown>;
  diffHunks?: (root: string, rel: string) => Promise<{ ok: boolean; hunks?: Array<{ start?: number }> }>;
  onFileChanged: (cb: (p: { root: string; relPath: string; text?: string; bom?: boolean; eol?: string }) => void) => () => void;
  onAgentEvent: (cb: (evt: { id?: string; type: string; code?: number | null; signal?: string | null; text?: string; payload?: unknown }) => void) => () => void;
  /** An agent is asking permission and is waiting on the answer. Optional: a
   *  build without computer use never sends one. */
  onPermitRequest?: (cb: (req: PermitRequest) => void) => () => void;
  permitAnswer?: (id: string, allow: boolean, reason?: string) => Promise<{ ok: boolean; error?: string }>;
  stats: (root: string, paths: string[]) => Promise<StatsResult>;
  /** The last few commits, newest first. Read only — there is no restore. */
  commits?: (root: string, limit?: number) => Promise<CommitsResult>;
  /** Agent runs on a timer. Optional: an older desktop build does not have
   *  them, and the hub serves this board to whatever version is installed. */
  schedules?: () => Promise<SchedulesResult>;
  scheduleSave?: (s: Partial<AgentSchedule>) => Promise<SchedulesResult>;
  scheduleRemove?: (id: string) => Promise<SchedulesResult>;
  scheduleToggle?: (id: string) => Promise<SchedulesResult>;
  status: (root: string | null) => Promise<StatusResult>;
  chrome: (spec: ColorThemeSpec) => void;
  addWorkspace: () => Promise<LocalWorkspace | null>;
  indexStatus: (root: string | null) => Promise<{ ok: boolean } & Record<string, unknown>>;
  /* Save this user default permission posture. Returns what is now stored —
     never assume the write landed, which is the whole reason it answers. */
  defaultMode: (mode: string) => Promise<{ ok?: boolean; error?: string; mode?: string }>;
  /** Semantic search over the workspace index. The scores are real cosines —
   *  `code-index.js` clamps them to [-1, 1] — which is why a retrieval panel
   *  can print one. Optional: a build without the index capability has none. */
  /** `filter` narrows by PATH and is matched as a literal, case-insensitively
   *  — it is not a pattern. See main.js § pathFilter: a regex from here runs
   *  against every chunk on the main process, where one that backtracks takes
   *  the whole app with it. */
  indexSearch?: (root: string | null, query: string, opts?: { k?: number; filter?: string }) => Promise<IndexSearchResult>;
  /** What the agent has written down about this repo, if it writes memories
   *  at all. Read only: there is no bridge call that deletes one. */
  memories?: (root: string) => Promise<MemoriesResult>;
  /** Every agent session on this machine — claude and codex, terminal, desktop
   *  app and IDE alike. Read only: there is no bridge call that writes or
   *  deletes one, and a session the CLI still has open is being appended to.
   *  Optional: an older desktop build has neither, and the pane that lists
   *  them renders nothing without them. */
  sessions?: (opts?: { cwd?: string | null; limit?: number }) => Promise<SessionsResult>;
  session?: (source: string, slug: string, id: string, child?: string) => Promise<SessionResult>;
  /** The subagents a claude session spawned. Open one by passing its id as
   *  `session`'s fourth argument. */
  sessionAgents?: (slug: string, id: string) => Promise<SessionAgentsResult>;
  /** Standing instructions for this repo, and which optional capabilities an
   *  agent started here is given. Optional: an older desktop build has none,
   *  and the panel that edits them renders nothing without it. */
  agentSettings?: (root: string) => Promise<AgentSettingsResult>;
  saveAgentSettings?: (root: string, patch: Partial<AgentSettings>) => Promise<AgentSettingsResult>;
  indexEnable?: (root: string | null) => Promise<{ ok?: boolean; indexed?: number; skipped?: number; error?: string } | null | undefined>;
  updateCheck: () => Promise<unknown>;
  updateStatus: () => Promise<unknown>;
  updateInstall: () => Promise<{ ok?: boolean; manual?: boolean; error?: string }>;
  onUpdate: (cb: (s: unknown) => void) => void;
  onIndexEvent: (cb: (p: { kind?: string; total?: number; loaded?: number; indexed?: number }) => void) => void;
  workspaces: () => Promise<LocalWorkspace[]>;
  tree: (dir: string) => Promise<{ ok: boolean; entries?: LocalEntry[]; truncated?: boolean; error?: string }>;
}

export interface ZevetConfig {
  hub?: string;
  actor?: string;
  /* The GitHub login this machine signed in as. `main.js` has always sent it
     (desktop/main.js § zevet:config); only the type did not say so. */
  login?: string;
  /* The default permission posture for this user, or "" when they have not
     chosen one. An id from agent-console.js MODES. */
  mode?: string;
  session?: boolean;
  hasSecret?: boolean;
  legacy?: boolean;
}

export interface ZevetBridge {
  config: () => Promise<ZevetConfig | null | undefined>;
  githubStart: (hub?: string) => Promise<{ ok?: boolean; error?: string; userCode?: string }>;
  githubWait: () => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; login?: string }>;
  githubCancel: () => void;
  githubLogout?: () => Promise<{ ok?: boolean; error?: string } | null | undefined>;
}

declare global {
  interface Window {
    zevetLocal?: Partial<LocalBridge>;
    zevetDoc?: { available?: boolean } & Record<string, unknown>;
    zevetEditor?: Record<string, unknown>;
    zevetHighlight?: { highlight?: (t: string, l: string) => string; languageFor?: (p: string) => string };
    zevetSprites?: { spriteFor?: (o: { tool?: string | null; width: number; height: number }) => string };
    zevet?: Partial<ZevetBridge>;
    __zevetCfg?: ZevetConfig;
    __zevetHub?: string;
  }
}

export const bridge = {
  get local(): LocalBridge | undefined {
    const l = window.zevetLocal;
    return l && l.available ? (l as LocalBridge) : undefined;
  },
  get zevet(): ZevetBridge | undefined {
    return window.zevet as ZevetBridge | undefined;
  },
  get canWrite(): boolean {
    return Boolean(window.zevetLocal && typeof window.zevetLocal.write === "function");
  },
  get canShare(): boolean {
    return Boolean(
      window.zevetDoc && window.zevetDoc.available &&
      window.zevetEditor,
    );
  },
  get cfg(): ZevetConfig | undefined {
    return window.__zevetCfg;
  },
  get hub(): string {
    return window.__zevetHub || location.origin;
  },
};