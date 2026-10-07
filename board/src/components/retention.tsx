/**
 * How long the hub keeps prompt and command text. The owner picks; everyone
 * else reads. The hub enforces it (compaction) and refuses anyone but the
 * owner; this only shows and asks. Rendered inside Settings by settings.tsx.
 * Same idiom as steerpolicy.tsx.
 */
"use client";

import { useState } from "react";
import { setRetention, usePolicy, type RetentionPolicy } from "../lib/policy";

const OPTIONS: Array<{ value: RetentionPolicy; label: string }> = [
  { value: "forever", label: "Forever" },
  { value: "90d", label: "90 days" },
  { value: "30d", label: "30 days" },
  { value: "7d", label: "7 days" },
  { value: "1d", label: "1 day" },
];
const NOTE = "Older text is blanked on the board and in the log. Who, what and where stay.";

export function RetentionControl() {
  const policy = usePolicy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = OPTIONS.find((o) => o.value === policy.retention) || OPTIONS[0];

  if (!policy.admin) {
    return (
      <div data-slot="retention" data-readonly="true">
        <div className="srow">
          <span className="k">Keep text for</span>
          <span className="v">{current.label}</span>
        </div>
        <div className="snote">
          {NOTE}
          {policy.owner ? ` Only @${policy.owner} can change this.` : ""}
        </div>
      </div>
    );
  }

  return (
    <div data-slot="retention">
      <div role="radiogroup" aria-label="How long to keep prompts and commands" className="sbtn-row">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="sbtn"
            aria-checked={policy.retention === o.value}
            aria-pressed={policy.retention === o.value}
            disabled={busy || policy.retention === o.value}
            onClick={async () => {
              setBusy(true);
              setError("");
              const r = await setRetention(o.value);
              setBusy(false);
              if (!r.ok) setError(r.error || "could not save");
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="snote">{error ? `Not saved: ${error}` : NOTE}</div>
    </div>
  );
}
