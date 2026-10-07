/** Invite into this session / Join a session (D-090). */
"use client";

import { useState } from "react";
import { canShare, inviteIntoSession, joinSession, SHARE_MODES, type ShareMode } from "../lib/sessionshare";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const chip = "text-foreground/60 hover:bg-foreground/[0.06] hover:text-foreground/90 aria-pressed:bg-foreground/[0.1] aria-pressed:text-foreground h-7 rounded-full px-3 text-xs font-medium";
const go = "bg-foreground text-background h-8 rounded-full px-4 text-xs font-medium disabled:opacity-40";

function Modes({ mode, onMode }: { mode: ShareMode; onMode: (m: ShareMode) => void }) {
  return (
    <div className="flex gap-1">
      {SHARE_MODES.map((m) => (
        <button key={m.mode} type="button" className={chip} aria-pressed={mode === m.mode} onClick={() => onMode(m.mode)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** On a session or agent row. */
export function InviteIntoSession({ session }: { session?: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ShareMode>("watch");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  if (!session || !canShare()) return null;
  const make = async () => {
    setBusy(true);
    setError("");
    const r = await inviteIntoSession(session, mode);
    setBusy(false);
    if (r.ok && r.id) setCode(r.id);
    else setError(r.error || "Could not invite");
  };
  return (
    <>
      <button
        type="button"
        data-invite-session={session}
        className="agent-row-steer text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground/90 mr-1 shrink-0 self-center rounded-full px-2 py-0.5 text-[11px] font-medium"
        title="Invite into this session"
        onClick={(ev) => {
          ev.stopPropagation();
          setCode("");
          setError("");
          setOpen(true);
        }}
      >
        Invite
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite into this session</DialogTitle>
          </DialogHeader>
          <Modes mode={mode} onMode={(m) => { setMode(m); setCode(""); }} />
          {code ? (
            <div className="flex items-center gap-2">
              <code data-invite-code className="min-w-0 flex-1 truncate text-xs">{code}</code>
              <button type="button" className={go} onClick={() => navigator.clipboard?.writeText(code).catch(() => {})}>
                Copy
              </button>
            </div>
          ) : (
            <button type="button" className={go} disabled={busy} onClick={() => void make()}>
              {busy ? "…" : "Create invite"}
            </button>
          )}
          {error ? <p role="alert" data-invite-error className="text-xs">{error}</p> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Paste an invite, pick what to do, join. */
export function JoinSession() {
  const [id, setId] = useState("");
  const [mode, setMode] = useState<ShareMode>("watch");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!canShare()) return null;
  const join = async () => {
    setBusy(true);
    const r = await joinSession(id, mode);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: r.readOnly ? `Watching ${r.actor}'s ${r.repo || "session"}` : `In ${r.actor}'s ${r.repo || "session"}` } : { ok: false, text: r.error || "Could not join" });
  };
  return (
    <div data-slot="join-session" className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <input className="bg-foreground/[0.05] h-8 min-w-0 flex-1 rounded-full px-3 text-xs" placeholder="Join a session" value={id} onChange={(e) => setId(e.target.value)} />
        <button type="button" className={go} disabled={busy || !id.trim()} onClick={() => void join()}>
          Join
        </button>
      </div>
      <Modes mode={mode} onMode={setMode} />
      {msg ? <p role={msg.ok ? "status" : "alert"} data-join-result={msg.ok ? "ok" : "error"} className="text-xs">{msg.text}</p> : null}
    </div>
  );
}
