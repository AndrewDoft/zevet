/** The agents a person is running, folded out of hub events. Plain JavaScript
 *  for the same reason roster.mjs is: the hub imports this exact file to put
 *  `agents` in its snapshot, the board imports it to keep them live, and the
 *  gate tests execute it — one copy, so the two sides cannot disagree.
 *
 *  An agent is one (person, machine, session). Events from a hook older than
 *  the `session` field carry none, so they fall back to (agent, repo, branch):
 *  coarser, never wrong about who or where. */

const HIDE_AFTER_MS = 12 * 3600 * 1000;

export function agentKey(e) {
  const which = e.session || `${e.agent || ""}\u0001${e.repo || ""}\u0001${e.branch || ""}`;
  return `${e.actor}\u0000${e.machine || ""}\u0000${which}`;
}

/** Fold one event into `map` (Map key -> agent). Mutates and returns the agent. */
export function foldAgent(map, e) {
  if (!e || !e.actor || typeof e.ts !== "number") return null;
  const key = agentKey(e);
  let a = map.get(key);
  if (!a) {
    a = { key, actor: e.actor, machine: e.machine || "", agent: e.agent || "claude-code", repo: e.repo || "", branch: e.branch || "", session: e.session || "", firstTs: e.ts, lastTs: 0, mission: "", current: "", ended: false };
    map.set(key, a);
  }
  if (e.ts < a.lastTs) {
    // A late arrival (a hook's outbox flushing after the hub came back) never rewinds the agent, but may supply what it lacks.
    if (e.kind === "prompt" && !a.mission) a.mission = String(e.detail || "").slice(0, 120);
    return a;
  }
  a.lastTs = e.ts;
  a.repo = e.repo || a.repo;
  a.branch = e.branch || a.branch;
  if (e.kind === "prompt") {
    a.mission = String(e.detail || "").slice(0, 120) || a.mission;
    a.current = "";
    a.ended = false;
  } else if (e.kind === "turn_end") {
    a.ended = true;
  } else {
    a.current = (e.tool || "tool") + (e.target || e.detail ? "  " + (e.target || e.detail) : "");
    a.ended = false;
  }
  return a;
}

/** Newest first. `state` is working | idle (silent past idleAfterMs) | finished. */
export function agentsOf(events, now, idleAfterMs = 90000) {
  const map = new Map();
  for (const e of events || []) foldAgent(map, e);
  return withState([...map.values()], now, idleAfterMs);
}

export function withState(list, now, idleAfterMs = 90000) {
  return list
    .filter((a) => now - a.lastTs < HIDE_AFTER_MS)
    .map((a) => ({ ...a, state: a.ended ? "finished" : now - a.lastTs > idleAfterMs ? "idle" : "working" }))
    .sort((x, y) => y.lastTs - x.lastTs);
}
