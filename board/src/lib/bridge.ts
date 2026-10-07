import { mirroredStorage } from "./prefs-mirror.mjs";
import type { LocalBridge, ZevetBridge } from "./bridge.generated";

// The two bridge shapes are GENERATED from desktop/ipc-table.js (npm run ipc:gen), the same table that
// generates desktop/preload.js and registers main.js's handlers, so a call cannot exist in one and not the others.
export type { LocalBridge, ZevetBridge };

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
  /** Which Claude account this actually ran on, only when the launch named
   *  an engine (desktop/agent-engine.js) -- absent otherwise. */
  engine?: string;
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
  /** "claude" when this is Claude's own tool (Bash, Edit…) asking through
   *  --permission-prompt-tool; absent for zevet's computer-use tools. */
  via?: string;
  /** Whether "always allow this" would be remembered for the request (a
   *  command too long to match exactly is not). */
  canAlways?: boolean;
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

/**
 * A multiple-choice question an agent is BLOCKED on.
 *
 * Bounded before it ever reaches here — desktop/zevet-mcp.js § cleanQuestion
 * is where the agent's own text stops being arbitrary, so the board is never
 * handed a shape it has to defend against.
 */
export interface AskRequest {
  id: string;
  question: string;
  header: string;
  multi: boolean;
  options: Array<{ label: string; description: string }>;
}

/** One console event. `seq` orders it against a `consoles()` snapshot;
 *  `prompt` and `gap` only ever arrive in one. */
export interface AgentEvent {
  id?: string;
  seq?: number;
  type: string;
  code?: number | null;
  signal?: string | null;
  stopped?: boolean;
  text?: string;
  payload?: unknown;
  dropped?: number;
  title?: string;
}

/** Where a subagent run's work went (desktop/agent-integration.js). */
export interface AgentIntegration {
  status: "integrated" | "waiting" | "failed" | "no checks" | "discarded";
  why?: string;
  files?: string[];
}

export interface HeldConsole {
  id: string;
  agent: string;
  root: string;
  model: string;
  mode: string;
  startedAt: number;
  title?: string;
  running: boolean;
  events: AgentEvent[];
  /** Which Claude account this ran on, only set when a caller named one
   *  (desktop/agent-engine.js). Absent for a console started before engine
   *  selection existed, or one that never named an engine. */
  engine?: string;
  /** Set only for a console the local control API spawned (desktop/
   *  agent-api.js), never for one the board's own UI started. */
  label?: string;
  integration?: AgentIntegration;
}

export interface ChatSummary {
  id: string;
  title: string;
  owner?: string;
  created: number;
  updated: number;
  /** The working folder: present makes the thread a work thread. */
  folder?: string;
}

/** desktop/chat.js's record: the whole transcript, and nothing machine-local. */
export interface StoredChat extends ChatSummary {
  owner?: string;
  participants?: string[];
  model?: string;
  messages: Array<{ role: "user" | "assistant"; author?: string; text: string; at?: number }>;
}

export interface ZevetConfig {
  hub?: string;
  actor?: string;
  machine?: string;
  /* The GitHub login this machine signed in as. `main.js` has always sent it
     (desktop/main.js § zevet:config); only the type did not say so. */
  login?: string;
  /* The default permission posture for this user, or "" when they have not
     chosen one. An id from agent-console.js MODES. */
  mode?: string;
  session?: boolean;
  hasSecret?: boolean;
  legacy?: boolean;
  /* electron-builder's own version string — not a credential, just what
     board/src/lib/sentry.ts tags a renderer report with. Absent from a plain
     browser visit to the hub (no desktop bridge, nothing to report). */
  version?: string;
}

declare global {
  interface Window {
    zevetLocal?: Partial<LocalBridge>;
    zevetDoc?: { available?: boolean } & Record<string, unknown>;
    zevetEditor?: Record<string, unknown>;
    zevetHighlight?: { highlight?: (t: string, l: string) => string; languageFor?: (p: string) => string };
    zevetSprites?: { spriteFor?: (o: { tool?: string | null; kind?: string | null; width: number; height: number }) => string };
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

/** `window.localStorage`, mirrored to the desktop app's own storage so a
 *  "zevet.*" preference follows the person across a reload, an app update, or
 *  a change of hub rather than resetting with the origin. In a plain browser
 *  (no desktop bridge) this is exactly `window.localStorage`. See
 *  lib/prefs-mirror.mjs and main.tsx's `hydratePrefsMirror` call, which fills
 *  it in before anything reads from it. */
export const zStorage = mirroredStorage(window.localStorage, () => bridge.local);
