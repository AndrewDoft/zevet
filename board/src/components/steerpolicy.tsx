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
  { value: "on", label: "Always on", note: "A teammate's steer, or an agent they start on your machine, goes straight in." },
  { value: "ask", label: "Ask first", note: "The owner approves each steer, and each agent started on their machine, first." },
  { value: "off", label: "Always off", note: "Nobody can steer anyone else's agent or start one on their machine." },
];

export function SteerPolicyControl() {
  return <PolicyControl field="steer" options={OPTIONS} label="Steering and starting teammates' agents" row="Steering and starting agents" slot="steer-policy" />;
}

const APPROVE_OPTIONS: Array<{ value: SteerPolicy; label: string; note: string }> = [
  { value: "on", label: "Always on", note: "An Editor's answer to a teammate's agent prompt is applied." },
  { value: "ask", label: "Ask first", note: "An Editor's answer is shown to the agent's owner, who still clicks." },
  { value: "off", label: "Always off", note: "Only the person at the machine answers their agent's prompts." },
];

/** Default off: answering lets a remote person authorise a tool on another machine. */
export function ApprovePolicyControl() {
  return <PolicyControl field="approve" options={APPROVE_OPTIONS} label="Answering teammates' agent prompts" row="Answering prompts" slot="approve-policy" />;
}

function PolicyControl({ field, options: OPTS, label, row, slot }: { field: "steer" | "approve"; options: typeof OPTIONS; label: string; row: string; slot: string }) {
  const policy = usePolicy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const value = policy[field];
  const current = OPTS.find((o) => o.value === value) || OPTS[field === "steer" ? 1 : 2];

  if (!policy.admin) {
    return (
      <div data-slot={slot} data-readonly="true">
        <div className="srow">
          <span className="k">{row}</span>
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
    <div data-slot={slot}>
      <div role="radiogroup" aria-label={label} className="sbtn-row">
        {OPTS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="sbtn"
            aria-checked={value === o.value}
            aria-pressed={value === o.value}
            disabled={busy || value === o.value}
            onClick={async () => {
              setBusy(true);
              setError("");
              const r = await setPolicy(o.value, field);
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
