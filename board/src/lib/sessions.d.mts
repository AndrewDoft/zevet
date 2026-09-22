import type { TranscriptEvent, TranscriptState } from "./transcript.d.mts";

/** One session as a list row. Produced by desktop/agent-sessions.js. */
export interface SessionSummary {
  /** Which CLI wrote it. */
  source: "claude" | "codex";
  /** The file's own name, without `.jsonl`. Half of the read handle. */
  id: string;
  /** The other half: claude's project directory, or codex's `YYYY/MM/DD`. */
  slug: string;
  /** codex only: the id inside `session_meta`, which is what its own index
   *  keys titles by. Equal to `id` for a file nobody renamed. */
  sessionId?: string;
  /** The directory the session ran in, when the file says so. */
  cwd: string;
  /** The git branch at the time, when the CLI recorded one. claude does. */
  branch: string;
  /** The CLI's version string. */
  version: string;
  /** The provenance string EXACTLY as the file recorded it: claude's
   *  `entrypoint` ("cli", "sdk-cli"), codex's `originator` ("codex_exec",
   *  "Codex Desktop", "codex_work_desktop"). */
  origin: string;
  /** That string bucketed: "cli" | "desktop" | "ide" | "sdk", or the raw
   *  value lowercased when it is one nobody has seen. Empty when the file
   *  said nothing. */
  surface: string;
  /** The CLI's own title, else the first prompt, else the id. */
  title: string;
  /** The first prompt, on one line. Empty for a session that never got one. */
  prompt: string;
  /** ms since epoch. */
  started: number;
  updated: number;
  bytes: number;
  /** How many subagent transcripts this session has. claude only: codex keeps
   *  its subagent activity inline in the parent rollout. */
  children: number;
}

/** One record as the desktop side hands it over. */
export type SessionRecord =
  | {
      source: "claude";
      type: "user" | "assistant";
      uuid: string;
      timestamp: string;
      message: { role?: string; content?: unknown };
    }
  | { source: "codex"; timestamp: string; item: Record<string, unknown> };

/** One subagent a session spawned. `id` is the read handle; `parent` is the
 *  session that spawned it. */
export interface SessionAgent {
  source: "claude";
  id: string;
  slug: string;
  parent: string;
  /** The agent type the parent asked for: "general-purpose", "Explore"... */
  kind: string;
  /** The model it was given, when the parent named one. */
  model: string;
  /** The parent's own description of the task, else the id. */
  title: string;
  /** The Agent tool call in the parent that spawned it. */
  toolUseId: string;
  depth: number;
  updated: number;
  bytes: number;
}

export interface SessionAgentsResult {
  ok: boolean;
  dir?: string;
  children?: SessionAgent[];
  error?: string;
}

export interface SessionsResult {
  ok: boolean;
  dirs?: { claude: string; codex: string };
  sessions?: SessionSummary[];
  total?: number;
}

export interface SessionResult {
  ok: boolean;
  file?: string;
  source?: "claude" | "codex";
  truncated?: boolean;
  total?: number;
  records?: SessionRecord[];
  error?: string;
}

export function codexItem(item: unknown): TranscriptEvent | null;
export function sessionEvents(records: readonly SessionRecord[] | null | undefined): TranscriptEvent[];
export function sessionTranscript(
  records: readonly SessionRecord[] | null | undefined,
  opts?: { cwd?: string | null; source?: string },
): TranscriptState;
export function unwrapEnvelope(prompt: string): string;
export function sessionBlurb(session: { title?: string; prompt?: string; id?: string; source?: string }): string;
export function sessionLabel(session: { title?: string; prompt?: string; id?: string; source?: string }): string;
export function sessionWhere(session: { surface?: string; origin?: string }): string;
export function sessionProject(session: { cwd?: string; slug?: string }): string;
export function sessionMatches(session: Record<string, unknown>, query: string): boolean;
