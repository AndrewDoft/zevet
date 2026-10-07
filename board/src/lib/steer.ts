/**
 * Steering a teammate's agent from this composer (D-058).
 *
 * `target` retargets the composer: while it is set, Send goes to that
 * person's agent through the desktop (which seals the text) and the hub
 * (which enforces the team policy), not to an agent of mine. Every steer I
 * send stays listed with its status until I dismiss it — queued, delivered,
 * accepted, declined, refused-by-policy, offline, unknown-agent — so nothing
 * is ever silently dropped. `asks` are the approval cards for steers aimed
 * at MY agents, when the team policy is "ask first".
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

export interface SentSteer {
  id: string;
  to: string;
  text: string;
  status: string;
  reason: string;
  at: number;
}

export interface SteerAsk {
  id: string;
  from: string;
  text: string;
  agent: string;
  repo: string;
}

export interface SteerState {
  target: SteerTarget | null;
  sent: SentSteer[];
  asks: SteerAsk[];
}

let state: SteerState = { target: null, sent: [], asks: [] };
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
  "refused-by-policy": "refused — steering is off for this team",
  offline: "not delivered — their app is offline",
  "unknown-agent": "not delivered — that agent is not on the board",
  failed: "not sent",
};

/** Final: nothing more will happen to it. */
export function steerSettled(status: string): boolean {
  return status !== "sending" && status !== "queued" && status !== "delivered";
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

export function steerAgent(t: SteerTarget) {
  update((s) => ({ ...s, target: t }));
}

export function clearSteerTarget() {
  update((s) => ({ ...s, target: null }));
}

export function dismissSent(id: string) {
  update((s) => ({ ...s, sent: s.sent.filter((x) => x.id !== id) }));
}

function patchSent(id: string, patch: Partial<SentSteer>) {
  update((s) => ({ ...s, sent: s.sent.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
}

/** Send `text` to the current target. The composer clears either way; the
 *  outcome is the row this adds. */
export async function sendSteer(text: string): Promise<void> {
  const t = state.target;
  const local = bridge.local;
  if (!t) return;
  const temp = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  update((s) => ({ ...s, sent: [{ id: temp, to: t.actor, text, status: "sending", reason: "", at: Date.now() }, ...s.sent].slice(0, SENT_KEEP) }));
  if (!local?.steerSend) {
    patchSent(temp, { status: "failed", reason: "this app cannot steer — update Zevet" });
    return;
  }
  try {
    const r = await local.steerSend(t.actor, t.session, t.repo, text);
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

export async function answerSteer(id: string, approve: boolean): Promise<void> {
  // Removed first: answering twice must not be possible from the UI.
  update((s) => ({ ...s, asks: s.asks.filter((a) => a.id !== id) }));
  await bridge.local?.steerAnswer?.(id, approve);
}

/** Desktop pushes: approval cards for my agents, statuses of my steers. */
function onEvent(e: { kind: string; id: string; [k: string]: unknown }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (!e || typeof e.id !== "string") return;
  if (e.kind === "ask") {
    const ask: SteerAsk = { id: e.id, from: str(e.from), text: str(e.text), agent: str(e.agent), repo: str(e.repo) };
    update((s) => (s.asks.some((a) => a.id === ask.id) ? s : { ...s, asks: [...s.asks, ask] }));
  } else if (e.kind === "done") {
    update((s) => ({ ...s, asks: s.asks.filter((a) => a.id !== e.id) }));
  } else if (e.kind === "status") {
    const known = state.sent.some((x) => x.id === e.id);
    if (known) patchSent(e.id, { status: str(e.status), reason: str(e.reason) });
    else
      update((s) => ({
        ...s,
        sent: [{ id: e.id, to: str(e.to), text: "", status: str(e.status), reason: str(e.reason), at: Date.now() }, ...s.sent].slice(0, SENT_KEEP),
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
