/**
 * The team's app-wide policies (D-058), as the hub serves them: `GET
 * /api/policy` for anyone signed in, `PUT /api/policy` for the owner only.
 * The hub validates and enforces; this only reads and asks.
 *
 * `steer` — may a teammate steer somebody else's agent: `on` always, `ask`
 * the agent's owner approves each one (the default), `off` never.
 */
import { useEffect, useSyncExternalStore } from "react";

export type SteerPolicy = "on" | "ask" | "off";
export const STEER_POLICIES: readonly SteerPolicy[] = ["on", "ask", "off"];

export interface PolicyState {
  steer: SteerPolicy;
  /** May this person change it (the team owner). */
  admin: boolean;
  owner: string | null;
  loaded: boolean;
  error: string;
}

let state: PolicyState = { steer: "ask", admin: false, owner: null, loaded: false, error: "" };
const subs = new Set<() => void>();

function update(next: Partial<PolicyState>) {
  state = { ...state, ...next };
  for (const fn of subs) fn();
}

const isSteer = (v: unknown): v is SteerPolicy => typeof v === "string" && (STEER_POLICIES as readonly string[]).includes(v);

let inflight: Promise<PolicyState> | null = null;

/** Fetch the current policy (deduplicated while a fetch is in flight). */
export function getPolicy(): Promise<PolicyState> {
  if (inflight) return inflight;
  inflight = fetch("/api/policy", { credentials: "same-origin" })
    .then(async (r) => {
      const body = (await r.json().catch(() => ({}))) as { policy?: { steer?: unknown }; admin?: unknown; owner?: unknown; error?: string };
      if (!r.ok) {
        update({ loaded: true, error: body.error || `the hub answered ${r.status}` });
        return state;
      }
      update({
        steer: isSteer(body.policy?.steer) ? body.policy.steer : "ask",
        admin: body.admin === true,
        owner: typeof body.owner === "string" ? body.owner : null,
        loaded: true,
        error: "",
      });
      return state;
    })
    .catch((err: unknown) => {
      update({ loaded: true, error: err instanceof Error ? err.message : "could not reach the hub" });
      return state;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Owner only — the hub refuses anyone else, and says so. */
export async function setPolicy(v: SteerPolicy): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch("/api/policy", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steer: v }),
    });
    const body = (await r.json().catch(() => ({}))) as { policy?: { steer?: unknown }; error?: string };
    if (!r.ok) return { ok: false, error: body.error || `the hub answered ${r.status}` };
    update({ steer: isSteer(body.policy?.steer) ? body.policy.steer : v, error: "" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "could not reach the hub" };
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
