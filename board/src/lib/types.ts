import type { TranscriptState } from "./transcript.d.mts";

export type Conn = "init" | "live" | "down";
export type ViewMode = "ide" | "agent";
export type Theme = "light" | "dark";
export type LaunchMode = "plan" | "ask" | "auto" | "dangerous";

export type EventKind = "prompt" | "tool" | "turn_end";

export interface HubEvent {
  id?: string;
  ts: number;
  actor: string;
  repo?: string;
  branch?: string;
  kind: EventKind | string;
  tool?: string;
  target?: string | null;
  detail?: string;
  agent?: string;
  machine?: string;
}

export interface RosterEntry {
  actor: string;
  hue: number;
  lastTs: number;
  lastEvent: HubEvent | null;
  turns: number;
  tools: number;
  idle: boolean;
  agoMs: number;
}

export interface CollisionActor {
  actor: string;
  machine?: string;
  ts: number;
  label?: string;
}

export interface Collision {
  target: string;
  repo?: string;
  actors: CollisionActor[];
  lastTs: number;
}

export interface Snapshot {
  now: number;
  roster: RosterEntry[];
  collisions: Collision[];
  events: HubEvent[];
  windowMs: number;
  idleAfterMs: number;
}

export interface ConsoleLine {
  kind: "you" | "out" | "tool" | "err" | "meta";
  text: string;
}

export interface ConsoleEntry {
  key: number;
  id: string | null;
  agent: string;
  /** The flat view: what classifyAgentPayloadLine produced, plus the process's
   *  own stderr.
   *
   *  ⚠️ THE COMMENT HERE USED TO SAY "still rendered by the raw terminal
   *  block", and that block had been gone for several releases — the console
   *  view became the registry Thread. So this was recorded and shown nowhere,
   *  and stderr reached the screen only by being appended to the assistant's
   *  message, in its voice. components/rawoutput.tsx renders it now. */
  lines: ConsoleLine[];
  /** The structured view: the same stream as assistant-ui messages. */
  transcript: TranscriptState;
  running: boolean;
  error: string | null;
  mode: LaunchMode;
  /** The posture the NEXT turn should run under, when it differs from `mode`.
   *
   *  ⚠️ THIS IS NOT `mode` — `mode` is what the CURRENT process was actually
   *  started with, which cannot change without killing it. Picking a new
   *  posture on a running console cannot apply mid-turn (there is no way to
   *  hand a live process new argv), so it is parked here instead and only
   *  swapped into `mode` by `sendPrompt`, right before it resumes with a new
   *  process — the first moment a new process is free. Null (the normal
   *  case) means the next turn runs with the same posture as this one. */
  nextMode?: LaunchMode | null;
  model: string;
  root: string;
  hue: number;
  /** What this console has spent, as IT reported it.
   *
   *  `strip.live` carries the same numbers for the rail, but there is only one
   *  of it: with three consoles running, whichever spoke last owns the strip
   *  and the meters under a different thread read as that thread's. These are
   *  attributed by the event's console id, so a panel can say whose they are.
   *  `startedAt` is when the process was launched, `exitCode` how it ended. */
  usage: ConsoleUsage;
  startedAt: number;
  exitCode: number | null;
  /** The provider's own rate-limit windows, when the agent reports them.
   *  Empty for an agent that does not — see `limitsOf` in lib/board.ts. */
  limits: RateWindow[];
  /** The agent's session id, when it announces one. It is what `--resume`
   *  takes, so it is the difference between being able to ask again from here
   *  and not. */
  sessionId: string | null;
  /** Slash commands the agent CLI announced in its init line (claude does;
   *  the others do not, and stay empty). Drives the composer's `/` menu. */
  slashCommands: string[];
  /** The console this one was forked from, by `key`.
   *
   *  ⚠️ IT HAS TO BE RECORDED HERE, because it cannot be recovered. Both CLIs
   *  mint a BRAND-NEW session id for a fork, so two branches of one question
   *  share nothing the agent reports — grouping them by session id finds
   *  nothing, always. Null for a console that was started rather than
   *  branched. */
  forkedFrom: number | null;
}

/** One rate-limit window, exactly as the agent reported it. */
export interface RateWindow {
  /** The agent's own name for it: "five_hour", "seven_day". */
  key: string;
  /** 0..1. Reported, never estimated. */
  utilization: number;
  /** ms since epoch, or 0 when the agent gave no reset time. */
  resetsAt: number;
}

export interface ConsoleUsage {
  context: number | null;
  cacheHit: number | null;
  cost: number | null;
  model: string | null;
  /** The parts, as the agent reported them. A panel that prints "cached"
   *  should print the number that was given rather than a share recovered
   *  from a rounded percentage. `cachedInput` is the READ cache only. */
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  /** The model's REAL context window, when the agent says what it is.
   *
   *  Everything drawing a "% of the window" bar used a 200k constant, chosen
   *  as the smallest common window because the agents were believed not to
   *  report theirs. claude's result payload carries
   *  `modelUsage[<model>].contextWindow`, and on opus-5[1m] that is 1,000,000
   *  — so the bar was reading five times fuller than the truth. Null until the
   *  agent says, and the 200k floor is the fallback rather than the answer. */
  window: number | null;
  /** Context after each usage payload, oldest first. A run's context only
   *  grows, and watching it approach the window is the thing that explains a
   *  session going wrong. Capped, because a long run reports hundreds. */
  series: number[];
}

export interface UsableAgent {
  name: string;
  ok: boolean;
  signedIn: boolean;
  detail: string;
}

export interface LocalAgent extends UsableAgent {}

export interface LocalWorkspace {
  name: string;
  dir: string;
  repo?: string;
}

export interface LocalEntry {
  path: string;
  kind: "dir" | "file";
  depth: number;
}

export interface LocalFileData {
  path: string;
  text?: string;
  truncated?: boolean;
  bytes?: number;
  error?: string;
}

export interface UpdateState {
  phase: "checking" | "current" | "downloading" | "ready" | "error";
  version?: string;
  current?: string;
  percent?: number;
  canInstall?: boolean;
  manual?: boolean;
  error?: string;
  notes?: string;
}

export interface ColorThemeSpec {
  theme: Theme;
  paper: string;
  ink: string;
  cerulean: string;
  line: string;
}