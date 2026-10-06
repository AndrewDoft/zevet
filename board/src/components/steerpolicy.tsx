/**
 * The team's steer policy (D-058): a three-way control for the team owner,
 * a plain sentence for everyone else. The hub is what enforces it and what
 * refuses a change from anyone but the owner; this only shows and asks.
 * Rendered inside Settings by settings.tsx.
 */
"use client";

import { useState } from "react";
import { setPolicy, usePolicy, type SteerPolicy } from "../lib/policy";

const OPTIONS: Array<{ value: SteerPolicy; label: string; note: string }> = [
  { value: "on", label: "Always on", note: "A teammate's steer goes straight into the agent." },
  { value: "ask", label: "Ask first", note: "The agent's owner approves each steer before it is sent." },
  { value: "off", label: "Always off", note: "Nobody can steer anyone else's agent." },
];

export function SteerPolicyControl() {
  const policy = usePolicy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = OPTIONS.find((o) => o.value === policy.steer) || OPTIONS[1];

  if (!policy.admin) {
    return (
      <div data-slot="steer-policy" data-readonly="true">
        <div className="srow">
          <span className="k">Steering</span>
          <span className="v">{current.label}</span>
        </div>
        <div className="snote">
          {current.note}
          {policy.owner ? ` Only @${policy.owner} can change this.` : ""}
          {policy.error ? ` (${policy.error})` : ""}
        </div>
      </div>
    );
  }

  /* Settings' own segmented idiom (`.sbtn-row`/`.sbtn`, as View uses): the
     current choice is pressed and disabled, the other two are buttons. */
  return (
    <div data-slot="steer-policy">
      <div role="radiogroup" aria-label="Steering teammates' agents" className="sbtn-row">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="sbtn"
            aria-checked={policy.steer === o.value}
            aria-pressed={policy.steer === o.value}
            disabled={busy || policy.steer === o.value}
            onClick={async () => {
              setBusy(true);
              setError("");
              const r = await setPolicy(o.value);
              setBusy(false);
              if (!r.ok) setError(r.error || "could not save");
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="snote">{error ? `Not saved: ${error}` : current.note}</div>
    </div>
  );
}
