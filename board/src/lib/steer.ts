/**
 * Steering a teammate's agent from this composer (D-058), and starting a new
 * agent on a teammate's machine (D-060) — the same machinery.
 *
 * `target` retargets the composer: while it is set, Send goes to that
 * person's agent through the desktop (which seals the text) and the hub
 * (which enforces the team policy), not to an agent of mine. `spawn` does the
 * same for a NEW agent: Send becomes its first prompt, and it runs on the
 * teammate's machine, in their repo, under their account. Every steer and
 * spawn I send stays listed with its status until I dismiss it — so nothing
 * is ever silently dropped. `asks` are the approval cards for steers and
 * spawns aimed at ME, when the team policy is "ask first".
 */
import { useSyncExternalStore } from "react";
import { bridge } from "./bridge";
import { agentName } from "./mentions.mjs";

export interface SteerTarget {
  actor: string;
  session: string;
  agent: string;
  repo: string;
}

/** A new agent to start on `actor`'s machine. `repo` is a folder NAME. */
export interface SpawnTarget {
  actor: string;
  repo: string;
  agent: "claude" | "codex" | "opencode";
  model: string;
}

export interface SentSteer {
  id: string;
  kind: "steer" | "spawn";
  to: string;
  text: string;
  status: string;
  reason: string;
  /** A started spawn's new session id. */
  session: string;
  at: number;
}

export interface SteerAsk {
  id: string;
  kind: "steer" | "spawn";
  from: string;
  text: string;
  agent: string;
  repo: string;
  /** spawn: the folder on this machine it would run in, and the model. */
  dir: string;
  model: string;
}

export interface SteerState {
  target: SteerTarget | null;
  spawn: SpawnTarget | null;
  sent: SentSteer[];
  asks: SteerAsk[];
}

let state: SteerState = { target: null, spawn: null, sent: [], asks: [] };
const subs = new Set<() => void>();

function update(fn: (s: SteerState) => SteerState) {
  state = fn(state);
  for (const f of subs) f();
}

const SENT_KEEP = 8;

/** What each status means, in the words the sender sees. */
export const STEER_STATUS: Record<string, string> = {
  sending: "sending…",
  queued: "sent — waiting for their app",
  delivered: "delivered — waiting on them",
  accepted: "accepted — their agent has it",
  declined: "declined",
  "refused-by-policy": "refused — steering and starting agents are off for this team",
  offline: "not delivered — their app is offline",
  "unknown-agent": "not delivered — that agent is not on the board",
  started: "started on their machine",
  "no-such-repo": "not started — no such repo on their machine",
  "start-failed": "started, but it failed",
  failed: "not sent",
};

/** For a spawn, "accepted" means "approved, starting". */
export function statusText(s: Pick<SentSteer, "kind" | "status"> & Partial<Pick<SentSteer, "to" | "reason">>): string {
  if (s.status === "start-failed") return `started, but it failed: ${s.reason || "it stopped"} on ${s.to || "their"}${s.to ? "’s" : ""} machine`;
  if (s.kind === "spawn" && s.status === "accepted") return "approved — starting…";
  return STEER_STATUS[s.status] || s.status;
}

/** Final: nothing more will happen to it. A spawn ends at `started`. */
export function steerSettled(status: string, kind: "steer" | "spawn" = "steer"): boolean {
  if (status === "sending" || status === "queued" || status === "delivered") return false;
  return !(kind === "spawn" && status === "accepted");
}

export function agentLabel(agent: string): string {
  const a = String(agent || "").toLowerCase();
  if (a === "claude-code" || a === "claude") return agentName(a);
  if (a === "codex") return "Codex";
  if (a === "opencode") return "OpenCode";
  return agent || "agent";
}

/** The desktop can steer (an older build, or a plain browser, cannot). */
export function canSteer(): boolean {
  return typeof bridge.local?.steerSend === "function";
}

/** The desktop can start an agent on a teammate's machine. */
export function canSpawn(): boolean {
  return typeof bridge.local?.spawnSend === "function";
}

/** The same folder-name rule the hub and their app apply. */
export function validRepoName(r: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(r) && !r.includes("..");
}

/** Repos a teammate has been seen working in, newest first — what the hub's
 *  events say about them. Not proof they still have it open; their app's
 *  `no-such-repo` answer is the authority. */
export function reposOf(actor: string, events: ReadonlyArray<{ actor?: string; repo?: string; ts?: number }>, agents: ReadonlyArray<{ actor?: string; repo?: string; lastTs?: number }> = []): string[] {
  const want = actor.toLowerCase();
  const seen = new Map<string, number>();
  for (const e of [...events.map((x) => ({ repo: x.repo, at: x.ts || 0, actor: x.actor })), ...agents.map((a) => ({ repo: a.repo, at: a.lastTs || 0, actor: a.actor }))]) {
    if (!e.repo || String(e.actor || "").toLowerCase() !== want || !validRepoName(e.repo)) continue;
    seen.set(e.repo, Math.max(seen.get(e.repo) || 0, e.at));
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
}

export function steerAgent(t: SteerTarget) {
  update((s) => ({ ...s, target: t, spawn: null }));
}

export function clearSteerTarget() {
  update((s) => ({ ...s, target: null }));
}

/** "Run as": null is me (the ordinary composer). */
export function setSpawnTarget(t: SpawnTarget | null) {
  update((s) => ({ ...s, spawn: t, target: t ? null : s.target }));
}

export function dismissSent(id: string) {
  update((s) => ({ ...s, sent: s.sent.filter((x) => x.id !== id) }));
}

function patchSent(id: string, patch: Partial<SentSteer>) {
  update((s) => ({ ...s, sent: s.sent.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

/** Put a row up, run the send, and settle the row with what came back. */
async function track(kind: "steer" | "spawn", to: string, text: string, send: () => Promise<{ ok: boolean; id?: string; status?: string; error?: string }>) {
  const temp = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  update((s) => ({ ...s, sent: [{ id: temp, kind, to, text, status: "sending", reason: "", session: "", at: Date.now() }, ...s.sent].slice(0, SENT_KEEP) }));
  try {
    const r = await send();
    const status = r.status || (r.ok ? "queued" : "failed");
    // A status update may already have arrived under the real id; keep the newest.
    update((s) => {
      const known = r.id ? s.sent.find((x) => x.id === r.id) : undefined;
      const sent = s.sent
        .filter((x) => !(known && x.id === temp))
        .map((x) => (x.id === temp ? { ...x, id: r.id || temp, status, reason: r.ok ? "" : r.error || "" } : x));
      return { ...s, sent };
    });
  } catch (err) {
    patchSent(temp, { status: "failed", reason: err instanceof Error ? err.message : "could not send" });
  }
}

/** Send `text` to the current target. The composer clears either way; the
 *  outcome is the row this adds. */
export async function sendSteer(text: string): Promise<void> {
  const t = state.target;
  const local = bridge.local;
  if (!t) return;
  await track("steer", t.actor, text, async () =>
    local?.steerSend ? local.steerSend(t.actor, t.session, t.repo, text) : { ok: false, error: "this app cannot steer — update Zevet" },
  );
}

/** Start the chosen agent on the chosen teammate's machine, `text` its first prompt. */
export async function sendSpawn(text: string): Promise<void> {
  const t = state.spawn;
  const local = bridge.local;
  if (!t) return;
  await track("spawn", t.actor, text, async () => {
    if (!local?.spawnSend) return { ok: false, error: "this app cannot start agents for teammates — update Zevet" };
    if (!validRepoName(t.repo)) return { ok: false, error: "pick one of their repos, or type its folder name" };
    return local.spawnSend(t.actor, t.repo, t.agent, t.model, text);
  });
}

export async function answerSteer(id: string, approve: boolean): Promise<void> {
  // Removed first: answering twice must not be possible from the UI.
  update((s) => ({ ...s, asks: s.asks.filter((a) => a.id !== id) }));
  await bridge.local?.steerAnswer?.(id, approve);
}

/** Desktop pushes: approval cards for me, statuses of what I sent. */
function onEvent(e: { kind: string; id: string; [k: string]: unknown }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (!e || typeof e.id !== "string") return;
  if (e.kind === "ask" || e.kind === "spawn-ask") {
    const ask: SteerAsk = {
      id: e.id,
      kind: e.kind === "spawn-ask" ? "spawn" : "steer",
      from: str(e.from),
      text: str(e.text),
      agent: str(e.agent),
      repo: str(e.repo),
      dir: str(e.dir),
      model: str(e.model),
    };
    update((s) => (s.asks.some((a) => a.id === ask.id) ? s : { ...s, asks: [...s.asks, ask] }));
  } else if (e.kind === "done") {
    update((s) => ({ ...s, asks: s.asks.filter((a) => a.id !== e.id) }));
  } else if (e.kind === "status") {
    const patch = { status: str(e.status), reason: str(e.reason), ...(str(e.session) ? { session: str(e.session) } : {}) };
    const known = state.sent.some((x) => x.id === e.id);
    if (known) patchSent(e.id, patch);
    else
      update((s) => ({
        ...s,
        sent: [{ id: e.id, kind: e.of === "spawn" ? ("spawn" as const) : ("steer" as const), to: str(e.to), text: "", session: "", at: Date.now(), ...patch }, ...s.sent].slice(0, SENT_KEEP),
      }));
  }
}

let wired = false;
function wire() {
  if (wired) return;
  const l = bridge.local;
  if (l && typeof l.onSteerEvent === "function") {
    wired = true;
    l.onSteerEvent(onEvent);
  }
}

// At load, not on first render: an approval card must reach the store even
// while no steer component is on screen, or the asker waits out the timeout.
wire();

function subscribe(fn: () => void) {
  wire();
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function useSteer<T>(select: (s: SteerState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
