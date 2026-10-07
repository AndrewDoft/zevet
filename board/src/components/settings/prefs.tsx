/** Settings rows for native notifications and keyboard shortcuts. */
import { useEffect, useState } from "react";
import { bridge, zStorage } from "../../lib/bridge";
import { PageSection } from "./parts";
import { NOTIFY_DEFAULTS, readNotifyPrefs, writeNotifyPrefs } from "../../lib/notify.mjs";
import { BINDINGS, eventToAccel, resetAll, resetBinding, resolveBindings, setBinding, showAccel } from "../../lib/keybindings.mjs";

const MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

const NOTIFY_ROWS = [
  { id: "attention" as const, label: "Needs attention" },
  { id: "finished" as const, label: "Finished" },
];

export function NotifySection() {
  const [prefs, setPrefs] = useState(() => readNotifyPrefs(zStorage));
  if (!bridge.local) return null;
  const on = NOTIFY_ROWS.filter((r) => prefs[r.id]).map((r) => r.label);
  return (
    <PageSection title="Notifications" id="settingsNotify" summary={on.length ? on.join(", ") : "off"}>
      {NOTIFY_ROWS.map((r) => (
        <div className="srow" key={r.id}>
          <span className="k">{r.label}</span>
          <span className="v">
            <button
              className="sbtn"
              type="button"
              id={"settingsNotify-" + r.id}
              aria-pressed={prefs[r.id]}
              onClick={() => {
                const next = { ...prefs, [r.id]: !prefs[r.id] };
                writeNotifyPrefs(zStorage, next);
                setPrefs(next);
              }}
            >
              {prefs[r.id] ? "On" : "Off"}
              {prefs[r.id] === NOTIFY_DEFAULTS[r.id] ? "" : " *"}
            </button>
          </span>
        </div>
      ))}
    </PageSection>
  );
}

export function KeysSection() {
  const [bindings, setBindings] = useState(() => resolveBindings(zStorage));
  const [capturing, setCapturing] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!capturing) return;
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === "Escape") {
        setCapturing(null);
        return;
      }
      const accel = eventToAccel(ev);
      if (!accel) return;
      const r = setBinding(zStorage, capturing, accel);
      if (r.ok) {
        setErr("");
        setBindings(resolveBindings(zStorage));
        setCapturing(null);
      } else setErr(r.error || "Not allowed");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [capturing]);

  return (
    <PageSection title="Shortcuts" id="settingsKeys" summary={BINDINGS.length + " keys"}>
      {BINDINGS.map((b) => (
        <div className="srow" key={b.id}>
          <span className="k">{b.label}</span>
          <span className="v mono">
            <button className="sbtn" type="button" id={"settingsKey-" + b.id} aria-pressed={capturing === b.id} onClick={() => { setErr(""); setCapturing(capturing === b.id ? null : b.id); }}>
              {capturing === b.id ? "Press keys" : showAccel(bindings[b.id], MAC)}
            </button>
            {bindings[b.id] !== b.def ? (
              <button className="sbtn" type="button" onClick={() => { resetBinding(zStorage, b.id); setBindings(resolveBindings(zStorage)); setErr(""); }}>
                Reset
              </button>
            ) : null}
          </span>
        </div>
      ))}
      {err ? <p className="snote" style={{ color: "var(--bad)" }}>{err}</p> : null}
      <div className="sbtn-row">
        <button className="sbtn" type="button" onClick={() => { resetAll(zStorage); setBindings(resolveBindings(zStorage)); setErr(""); setCapturing(null); }}>
          Reset all
        </button>
      </div>
    </PageSection>
  );
}
