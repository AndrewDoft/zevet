/**
 * The team's app-wide policies (D-058), as the hub serves them: `GET
 * /api/policy` for anyone signed in, `PUT /api/policy` for the owner only.
 * The hub validates and enforces; this only reads and asks.
 *
 * `steer` — may a teammate steer somebody else's agent: `on` always, `ask`
 * the agent's owner approves each one (the default), `off` never.
 *
 * `retention` — how long the hub keeps prompt and command text: forever (the
 * default), or 90, 30, 7 or 1 days. Structure is never trimmed.
 * `approve` — may a teammate answer somebody else's agent's permission prompt
 * (D-086): same three values, default `off`.
 */
import { useEffect, useSyncExternalStore } from "react";

export type SteerPolicy = "on" | "ask" | "off";
export const STEER_POLICIES: readonly SteerPolicy[] = ["on", "ask", "off"];

export type RetentionPolicy = "forever" | "90d" | "30d" | "7d" | "1d";
export const RETENTION_POLICIES: readonly RetentionPolicy[] = ["forever", "90d", "30d", "7d", "1d"];

export interface PolicyState {
  steer: SteerPolicy;
  retention: RetentionPolicy;
  approve: SteerPolicy;
  /** May this person change it (the team owner). */
  admin: boolean;
  owner: string | null;
  loaded: boolean;
  error: string;
}

let state: PolicyState = { steer: "ask", approve: "off", retention: "forever", admin: false, owner: null, loaded: false, error: "" };
const subs = new Set<() => void>();

function update(next: Partial<PolicyState>) {
  state = { ...state, ...next };
  for (const fn of subs) fn();
}

const isRetention = (v: unknown): v is RetentionPolicy => typeof v === "string" && (RETENTION_POLICIES as readonly string[]).includes(v);
const isSteer = (v: unknown): v is SteerPolicy => typeof v === "string" && (STEER_POLICIES as readonly string[]).includes(v);

let inflight: Promise<PolicyState> | null = null;

/** Fetch the current policy (deduplicated while a fetch is in flight). */
export function getPolicy(): Promise<PolicyState> {
  if (inflight) return inflight;
  inflight = fetch("/api/policy", { credentials: "same-origin" })
    .then(async (r) => {
      const body = (await r.json().catch(() => ({}))) as { policy?: { steer?: unknown; approve?: unknown; retention?: unknown }; admin?: unknown; owner?: unknown; error?: string };
      if (!r.ok) {
        update({ loaded: true, error: body.error || `the team server answered ${r.status}` });
        return state;
      }
      update({
        steer: isSteer(body.policy?.steer) ? body.policy.steer : "ask",
        retention: isRetention(body.policy?.retention) ? body.policy.retention : "forever",
        approve: isSteer(body.policy?.approve) ? body.policy.approve : "off",
        admin: body.admin === true,
        owner: typeof body.owner === "string" ? body.owner : null,
        loaded: true,
        error: "",
      });
      return state;
    })
    .catch((err: unknown) => {
      update({ loaded: true, error: err instanceof Error ? err.message : "could not reach your team" });
      return state;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Owner only — the hub refuses anyone else, and says so. */
export async function setPolicy(v: SteerPolicy, key: "steer" | "approve" = "steer"): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/policy", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: v }),
    });
    const body = (await r.json().catch(() => ({}))) as { policy?: { steer?: unknown; approve?: unknown }; error?: string };
    if (!r.ok) return { ok: false, error: body.error || `the team server answered ${r.status}` };
    update({
      steer: isSteer(body.policy?.steer) ? body.policy.steer : key === "steer" ? v : state.steer,
      approve: isSteer(body.policy?.approve) ? body.policy.approve : key === "approve" ? v : state.approve,
      error: "",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not reach your team" };
  }
}

/** Owner only, like `setPolicy`. The hub compacts the log as it saves. */
export async function setRetention(v: RetentionPolicy): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/policy", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retention: v }),
    });
    const body = (await r.json().catch(() => ({}))) as { policy?: { retention?: unknown }; error?: string };
    if (!r.ok) return { ok: false, error: body.error || `the team server answered ${r.status}` };
    update({ retention: isRetention(body.policy?.retention) ? body.policy.retention : v, error: "" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not reach your team" };
  }
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** The policy, fetched on first use and live after every `setPolicy`. */
export function usePolicy(): PolicyState {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!state.loaded) void getPolicy();
  }, []);
  return s;
}
