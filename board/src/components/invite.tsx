import { useEffect, useRef, useState } from "react";
import { useBoard } from "../lib/board";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const MAKE_BTN = "sbtn";

function copyText(t: string) {
  navigator.clipboard?.writeText(t).catch(() => {});
}

/** hub/server.mjs's `person()` timestamps, one line each, absolute — the
 *  tooltip on a row's name, never text on the row itself (Zevet's copy
 *  style: one compact word on the row, the "why" only on hover). */
function inviteTooltip(p: {
  invitedAt?: string | null;
  emailSentAt?: string | null;
  emailError?: string | null;
  acceptedAt?: string | null;
  lastSeen?: number | null;
}): string {
  const lines: string[] = [];
  if (p.invitedAt) lines.push(`Invited ${new Date(p.invitedAt).toLocaleString()}`);
  if (p.emailSentAt) {
    lines.push(p.emailError ? `Email failed ${new Date(p.emailSentAt).toLocaleString()}` : `Emailed ${new Date(p.emailSentAt).toLocaleString()}`);
  }
  if (p.acceptedAt) lines.push(`Accepted ${new Date(p.acceptedAt).toLocaleString()}`);
  if (p.lastSeen) lines.push(`Last seen ${new Date(p.lastSeen).toLocaleString()}`);
  return lines.join("\n");
}

/** One pending invite's row. Resend and Copy are the SAME hub call
 *  (/auth/allow — see server.mjs's own comment on why: it rotates the key
 *  every time, so a stale key from an earlier email is never the one
 *  copied) — Resend also tries to email it, Copy just needs the text back.
 *  Andrew, verbatim: "the copy invite is different from what is actually
 *  emailed, since the copy invite doesnt contain the key" — inviteText is
 *  the hub's own mailer.mjs output, so this can never drift from it again.
 *
 *  `lifecycle` is hub/server.mjs's `person()` one-word state (invited, sent,
 *  failed, accepted, installed) — shown on the row, next to the name, with
 *  every timestamp behind it in a tooltip (`inviteTooltip`). Named
 *  `lifecycle`, not `state`, because this component already has its own
 *  local network-call `state` below. */
function PendingRow({
  login,
  isOwnerRow,
  pending,
  canManage,
  onRemoved,
  revokeKey,
  lifecycle,
  invitedAt,
  emailSentAt,
  emailError,
  acceptedAt,
  lastSeen,
}: {
  login: string;
  /** The person's stable login — what `/auth/revoke` takes. `login` is their
   *  display name, which they may have changed. */
  revokeKey?: string;
  isOwnerRow: boolean;
  pending: boolean;
  canManage: boolean;
  onRemoved: () => void;
  lifecycle: string;
  invitedAt: string | null;
  emailSentAt: string | null;
  emailError: string | null;
  acceptedAt: string | null;
  lastSeen: number | null;
}) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "busy" }
    | { phase: "sent" }
    | { phase: "failed"; message: string }
    | { phase: "needs-email" }
    | { phase: "have-text"; text: string }
  >({ phase: "idle" });
  const [email, setEmail] = useState("");

  function invite(loginOrPair: string) {
    setState({ phase: "busy" });
    fetch("/auth/allow", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: loginOrPair }),
    })
      .then((r) =>
        r.json().then((b) => ({
          status: r.status,
          body: b as {
            error?: string;
            email_sent?: boolean;
            email_error?: string;
            recipient_needed?: boolean;
            inviteText?: string;
          },
        })),
      )
      .then(
        (r) => {
          if (r.status !== 200) {
            setState({ phase: "failed", message: r.body.error || "Could not resend." });
          } else if (r.body.recipient_needed) {
            setState({ phase: "needs-email" });
          } else if (r.body.email_sent) {
            setState({ phase: "sent" });
          } else if (r.body.inviteText) {
            // Sent failed but the text (and key) still minted — never claim
            // "sent" for this; show the honest reason and let Copy stand in.
            setState({ phase: "have-text", text: r.body.inviteText });
          } else {
            setState({ phase: "failed", message: r.body.email_error || "Could not send." });
          }
        },
        () => setState({ phase: "failed", message: "Could not connect." }),
      );
  }

  function remove() {
    setState({ phase: "busy" });
    fetch("/auth/revoke", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: revokeKey || login }),
    }).then(
      () => onRemoved(),
      () => setState({ phase: "failed", message: "Could not connect." }),
    );
  }

  const busy = state.phase === "busy";

  return (
    <div className="srow" key={login}>
      <span className="k" title={isOwnerRow ? undefined : inviteTooltip({ invitedAt, emailSentAt, emailError, acceptedAt, lastSeen })}>
        {handle(login) + (isOwnerRow ? "  · owner" : "  · " + lifecycle)}
      </span>
      <span className="v">
        {state.phase === "sent" ? <span className="hint">Sent</span> : null}
        {state.phase === "failed" ? <span style={{ color: "var(--bad)" }}>{state.message}</span> : null}
        {state.phase === "have-text" ? (
          <>
            <span style={{ color: "var(--bad)" }}>Not sent</span>
            <button className={MAKE_BTN} type="button" onClick={() => copyText(state.text)}>
              Copy invite
            </button>
          </>
        ) : null}
        {state.phase === "needs-email" ? (
          <form
            className="sinvite"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) invite(`${login} ${email.trim()}`);
            }}
          >
            <input
              className="mono"
              type="email"
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label={`Email for ${login}`}
            />
            <button className={MAKE_BTN} type="submit">
              Send
            </button>
          </form>
        ) : null}
        {canManage && pending && (state.phase === "idle" || state.phase === "busy") ? (
          <button className={MAKE_BTN} type="button" disabled={busy} onClick={() => invite(login)}>
            Resend
          </button>
        ) : null}
        {canManage ? (
          <button className={MAKE_BTN} type="button" disabled={busy} onClick={remove}>
            Remove
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** "@octocat" for a GitHub login; a Google login is already an address. */
export function handle(login: string) {
  return login.includes("@") ? login : "@" + login;
}

/** The team roster and its invite form: Settings' "Account & Team" and the
 *  rail's "+" popup both render this, so there is one invite flow. */
export function TeamInvite() {
  const whoState = useBoard((s) => s.who.state) as unknown as Record<string, unknown> | null;
  const refreshWhoami = useBoard((s) => s.refreshWhoami);
  const invite = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [whoErr, setWhoErr] = useState("");
  const [inviteResult, setInviteResult] = useState<{
    login: string;
    already: boolean;
    emailSent: boolean;
    emailError?: string;
    recipientNeeded?: boolean;
    inviteText?: string;
  } | null>(null);

  // The roster changes on someone else's machine (an invite, a resend, a
  // sign-in, a removal) — board.ts's "people" SSE event (server.mjs's
  // notifyPeopleChanged) is the primary path now, pushed the moment it
  // happens rather than waited for. Focus and a slow poll stay as a safety
  // net for a connection that dropped without the board noticing.
  useEffect(() => {
    const t = setInterval(() => refreshWhoami(), 30000);
    window.addEventListener("focus", refreshWhoami);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refreshWhoami);
    };
  }, [refreshWhoami]);

  function changePeople(route: string, login: string) {
    setBusy(true);
    setWhoErr("");
    if (route === "/auth/allow") setInviteResult(null);
    fetch(route, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login }),
    })
      .then((r) =>
        r.json().then((b) => ({
          status: r.status,
          body: b as {
            people?: Array<Record<string, unknown>>;
            error?: string;
            email_sent?: boolean;
            email_error?: string;
            recipient_needed?: boolean;
            inviteText?: string;
            login?: string;
            already?: boolean;
          },
        })),
      )
      .then(
        (r) => {
          setBusy(false);
          if (r.status === 200 && r.body.people) {
            useBoard.setState({ who: { state: { ...(whoState || {}), people: r.body.people } as never, busy: false } });
            // The invited login is whatever was typed, including a paired
            // email ("octocat andrew@x.com") — the roster's own row is keyed
            // on the GitHub login or the email alone, not this compound
            // string, so this result is shown standalone rather than matched
            // back to a row. `r.body.login`, when present, is the CANONICAL
            // row this invite actually landed on — not always what was typed:
            // dedupe-by-email (hub/accounts.mjs's `allow`) can resend an
            // existing row keyed on a different identifier than this one.
            if (route === "/auth/allow") {
              setInviteResult({
                login: r.body.login || login,
                already: Boolean(r.body.already),
                emailSent: Boolean(r.body.email_sent),
                emailError: r.body.email_error,
                recipientNeeded: r.body.recipient_needed,
                inviteText: r.body.inviteText,
              });
            }
          } else {
            setWhoErr(r.body.error || ("Could not sign in."));
          }
        },
        () => {
          setBusy(false);
          setWhoErr("Could not connect.");
        },
      );
  }

  /** The owner's "Anyone at <domain>" toggle — /auth/domain, not /auth/allow:
   *  its response is {domain}, not {people}, so this refetches whoami rather
   *  than patching state by hand the way changePeople does. */
  function changeDomain(domain: string) {
    setBusy(true);
    setWhoErr("");
    fetch("/auth/domain", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain }),
    })
      .then((r) => r.json().then((b) => ({ status: r.status, body: b as { error?: string } })))
      .then(
        (r) => {
          setBusy(false);
          if (r.status === 200) refreshWhoami();
          else setWhoErr(r.body.error || "Could not change this.");
        },
        () => {
          setBusy(false);
          setWhoErr("Could not connect.");
        },
      );
  }

  if (!whoState || whoState.ok === false) return null;
  const owner = Boolean(whoState.owner);
  const googleDomain = typeof whoState.googleDomain === "string" ? whoState.googleDomain : "";
  const availableDomain = typeof whoState.availableDomain === "string" ? whoState.availableDomain : "";
  const people = Array.isArray(whoState.people)
    ? (whoState.people as Array<{
        login: string;
        key?: string;
        owner?: boolean;
        pending?: boolean;
        state?: string;
        invitedAt?: string | null;
        emailSentAt?: string | null;
        emailError?: string | null;
        acceptedAt?: string | null;
        lastSeen?: number | null;
      }>)
    : [];

  return (
    <>
      {people.length ? (
        <div style={{ marginTop: "8px" }}>
          {people.map((p) => (
            <PendingRow
              key={p.key || p.login}
              login={p.login}
              revokeKey={p.key}
              isOwnerRow={Boolean(p.owner)}
              pending={Boolean(p.pending)}
              canManage={owner && !p.owner}
              onRemoved={() => refreshWhoami()}
              lifecycle={p.state || (p.pending ? "invited" : "accepted")}
              invitedAt={p.invitedAt ?? null}
              emailSentAt={p.emailSentAt ?? null}
              emailError={p.emailError ?? null}
              acceptedAt={p.acceptedAt ?? null}
              lastSeen={p.lastSeen ?? null}
            />
          ))}
        </div>
      ) : null}
      {owner && availableDomain ? (
        <div className="srow">
          <span className="k">Anyone at {availableDomain}</span>
          <span className="v">
            <label>
              <input
                type="checkbox"
                checked={googleDomain === availableDomain}
                disabled={busy}
                onChange={(ev) => changeDomain(ev.target.checked ? availableDomain : "")}
              />
            </label>
          </span>
        </div>
      ) : null}
      {owner ? (
        <form
          className="sinvite"
          onSubmit={(ev) => {
            ev.preventDefault();
            const v = (invite.current && invite.current.value.trim()) || "";
            if (v) changePeople("/auth/allow", v);
          }}
        >
          <input className="mono" id="settingsInvite" type="text" ref={invite} aria-label="GitHub username or email" placeholder="GitHub username or email" autoComplete="off" spellCheck={false} />
          <button className={MAKE_BTN} type="submit" disabled={busy}>
            Invite
          </button>
        </form>
      ) : null}
      {owner && inviteResult ? (
        <div className="srow">
          <span className="k">{handle(inviteResult.login.split(/\s+/)[0])}</span>
          <span className="v">
            {inviteResult.emailSent ? (
              "Sent"
            ) : inviteResult.recipientNeeded ? (
              "No email — add one below"
            ) : inviteResult.inviteText ? (
              <>
                {inviteResult.emailError ? <span style={{ color: "var(--bad)" }}>Not sent · </span> : null}
                <button className={MAKE_BTN} type="button" onClick={() => copyText(inviteResult.inviteText as string)}>
                  Copy invite
                </button>
              </>
            ) : (
              inviteResult.already ? "Resent" : "Invited"
            )}
          </span>
        </div>
      ) : null}
      {whoErr ? <p className="snote">{whoErr}</p> : null}
    </>
  );
}

/** The rail's "+": the invite UI in a dialog. Only the owner can invite. */
export function InvitePlus() {
  const owner = useBoard((s) => Boolean((s.who.state as { owner?: boolean } | null)?.owner));
  const [open, setOpen] = useState(false);
  if (!owner) return null;
  return (
    <>
      <button
        type="button"
        className="rail-new"
        id="teamInvite"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Invite"
        title="Invite"
        onClick={() => setOpen(true)}
      >
        +
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md" id="inviteDialog">
          <DialogHeader>
            <DialogTitle>Team</DialogTitle>
          </DialogHeader>
          <TeamInvite />
        </DialogContent>
      </Dialog>
    </>
  );
}
