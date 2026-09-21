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
  /** The flat view: what classifyAgentPayloadLine produced, still rendered by
   *  the raw terminal block. A transcript nobody can read as plain text would
   *  be a regression for debugging an agent that has gone wrong. */
  lines: ConsoleLine[];
  /** The structured view: the same stream as assistant-ui messages. */
  transcript: TranscriptState;
  running: boolean;
  error: string | null;
  mode: LaunchMode;
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