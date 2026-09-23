import { AgentSettings } from "./agentsettings";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { connectPhaseLabel, connectValue, disconnectValue } from "../lib/connect.mjs";
import {
  selectUpdates,
  selectViewMode,
  useBoard,
} from "../lib/board";
import { updateCommand, updatePercent, updateStatusText } from "../lib/update.mjs";
import { MODES, MODE_LABEL } from "../lib/constants";
import { Twist } from "./twist";

function SRow({ k, v, mono }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="srow">
      <span className="k">{k}</span>
      <span className={mono ? "v mono" : "v"}>{v}</span>
    </div>
  );
}

/**
 * One collapsed row per setting, opened by the file tree's chevron.
 *
 * ⚠️ THE SUMMARY IS THE POINT, not the chevron. Andrew: "settings is ugly and
 * has too many words." Every section printed its title, its rows AND a
 * paragraph explaining each button, so the one fact a person opens Settings
 * for — what is this set to right now — was buried in prose about what the
 * setting means. A closed row carries the current value, so the common case is
 * read without opening anything, and the explanations are DELETED rather than
 * hidden: a note that only appears after a click is a note nobody reads.
 */
function SSection({
  title,
  id,
  summary,
  children,
}: {
  title: string;
  id?: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sset" id={id}>
      <button className="sset-head" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Twist open={open} />
        <span className="sset-title">{title}</span>
        {summary ? <span className="sset-sum">{summary}</span> : null}
      </button>
      {open ? <div className="sset-body">{children}</div> : null}
    </div>
  );
}

function SNote({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <p className="snote" style={style}>
      {children}
    </p>
  );
}

const MAKE_BTN = "sbtn";

/**
 * The posture every agent this user starts gets, unless the composer changes
 * it for one run.
 *
 * ⚠️ PER USER, AND ON DISK. It is written beside the zoom in
 * ~/.zevet/config.json rather than into localStorage, because localStorage is
 * scoped to the hub origin — cleared with site data, lost when the hub moves,
 * separate in every window — and a default that decides whether an agent asks
 * before it edits must not be able to quietly revert. Andrew: "add a tab to
 * settings that saves each user's default permissions."
 *
 * ⚠️ AND IT SHOWS WHAT WAS SAVED, NOT WHAT WAS ASKED FOR. The main process
 * answers with what is now stored, so a write that did not land reads as a
 * setting that did not move — which matters more on this row than on any
 * other one in this sheet.
 */
function PermissionSection() {
  const defaultMode = useBoard((s) => s.defaultMode);
  const setDefaultMode = useBoard((s) => s.setDefaultMode);
  const [err, setErr] = useState("");
  if (!bridge.local) return null;

  return (
    <SSection title="Permissions" id="settingsPermissions" summary={MODE_LABEL[defaultMode || ""] || "Auto"}>
      <div className="sbtn-row">
        {MODES.map((m) => (
          <button
            className={MAKE_BTN}
            key={m.id}
            id={"settingsMode-" + m.id}
            type="button"
            aria-pressed={defaultMode === m.id}
            disabled={defaultMode === m.id}
            onClick={() => {
              setErr("");
              void setDefaultMode(m.id).then((r) => {
                if (!r.ok) setErr(r.error || "could not save that");
              });
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      {err ? <SNote style={{ color: "var(--bad)" }}>{err}</SNote> : null}
    </SSection>
  );
}

function GithubConnectBox({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "starting" }
    | { phase: "waiting"; code: string }
    | { phase: "done"; login: string }
    | { phase: "fail"; message: string }
  >({ phase: "idle" });

  function click() {
    if (state.phase === "waiting") {
      window.zevet?.githubCancel?.();
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "starting" });
    const hub = (bridge.cfg && bridge.cfg.hub) || undefined;
    window.zevet?.githubStart?.(hub).then((r) => {
      if (!r || !r.ok) {
        setState({ phase: "fail", message: (r && r.error) || "Could not start sign-in." });
        return;
      }
      setState({ phase: "waiting", code: r.userCode || "" });
      window.zevet?.githubWait?.().then(
        (done) => {
          if (!done || !done.ok) {
            if (done && done.cancelled) setState({ phase: "idle" });
            else setState({ phase: "fail", message: (done && done.error) || "Sign-in failed." });
            return;
          }
          setState({ phase: "done", login: done.login || "" });
          onDone();
        },
        (err) => setState({ phase: "fail", message: (err && err.message) || "Sign-in failed." }),
      );
    }, (err) => setState({ phase: "fail", message: (err && err.message) || "Could not start sign-in." }));
  }

  const label = connectPhaseLabel(state.phase, "GitHub");

  const value = connectValue(state.phase, state, "GitHub");

  return (
    <div className="srow">
      <button className={MAKE_BTN} type="button" disabled={state.phase === "starting"} onClick={click}>
        {label}
      </button>
      <span className="v">{value}</span>
    </div>
  );
}

function GithubDisconnectRow({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState("idle");

  function click() {
    setState("busy");
    window.zevet?.githubLogout?.().then(
      (r) => {
        if (!r || !r.ok) setState("fail");
        else {
          setState("done");
          onDone();
        }
      },
      () => setState("fail"),
    );
  }

  return (
    <div className="srow">
      <button className={MAKE_BTN} type="button" disabled={state === "busy"} onClick={click}>
        {state === "busy" ? "Disconnecting…" : state === "fail" ? "Retry" : "Disconnect GitHub"}
      </button>
      <span className="v">{disconnectValue(state)}</span>
    </div>
  );
}

function GoogleConnectBox({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "starting" }
    | { phase: "waiting"; url?: string }
    | { phase: "done"; login: string }
    | { phase: "fail"; message: string }
  >({ phase: "idle" });

  function click() {
    if (state.phase === "waiting") {
      window.zevet?.googleCancel?.();
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "starting" });
    const hub = (bridge.cfg && bridge.cfg.hub) || undefined;
    window.zevet?.googleStart?.(hub).then((r) => {
      if (!r || !r.ok) {
        setState({ phase: "fail", message: (r && r.error) || "Could not start sign-in." });
        return;
      }
      setState({ phase: "waiting", url: r.url });
      window.zevet?.googleWait?.().then(
        (done) => {
          if (!done || !done.ok) {
            if (done && done.cancelled) setState({ phase: "idle" });
            else setState({ phase: "fail", message: (done && done.error) || "Sign-in failed." });
            return;
          }
          setState({ phase: "done", login: done.login || "" });
          onDone();
        },
        (err) => setState({ phase: "fail", message: (err && err.message) || "Sign-in failed." }),
      );
    }, (err) => setState({ phase: "fail", message: (err && err.message) || "Could not start sign-in." }));
  }

  const label = connectPhaseLabel(state.phase, "Google");

  const value = connectValue(state.phase, state, "Google");

  return (
    <div className="srow">
      <button className={MAKE_BTN} type="button" disabled={state.phase === "starting"} onClick={click}>
        {label}
      </button>
      <span className="v">
        {value}
        {state.phase === "waiting" && state.url ? (
          <>
            {" "}
            <button
              className={MAKE_BTN}
              type="button"
              onClick={() => window.open(state.url, "_blank", "noopener,noreferrer")}
            >
              Open link
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

function GoogleDisconnectRow({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState("idle");

  function click() {
    setState("busy");
    window.zevet?.googleLogout?.().then(
      (r) => {
        if (!r || !r.ok) setState("fail");
        else {
          setState("done");
          onDone();
        }
      },
      () => setState("fail"),
    );
  }

  return (
    <div className="srow">
      <button className={MAKE_BTN} type="button" disabled={state === "busy"} onClick={click}>
        {state === "busy" ? "Disconnecting…" : state === "fail" ? "Retry" : "Disconnect Google"}
      </button>
      <span className="v">{disconnectValue(state)}</span>
    </div>
  );
}

function AccountSection() {
  const whoState = useBoard((s) => s.who.state) as unknown as Record<string, unknown> | null;
  const who = useBoard((s) => s.who);
  const refreshWhoami = useBoard((s) => s.refreshWhoami);
  const invite = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [whoErr, setWhoErr] = useState("");

  useEffect(() => {
    if (!who.state) refreshWhoami();
  }, [who.state, refreshWhoami]);

  function changePeople(route: string, login: string) {
    setBusy(true);
    setWhoErr("");
    fetch(route, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login }),
    })
      .then((r) =>
        r.json().then((b) => ({ status: r.status, body: b as { people?: Array<Record<string, unknown>>; error?: string } })),
      )
      .then(
        (r) => {
          setBusy(false);
          if (r.status === 200 && r.body.people) {
            useBoard.setState({ who: { state: { ...(whoState || {}), people: r.body.people } as never, busy: false } });
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

  if (!whoState) {
    return (
      <SSection title="Account" summary="loading…">
        <SNote>Loading account…</SNote>
      </SSection>
    );
  }

  if (whoState.ok === false) {
    return (
      <SSection title="Account" summary="error">
        <SNote>Could not load account.</SNote>
        <button className={MAKE_BTN} type="button" onClick={() => refreshWhoami()}>
          Retry
        </button>
      </SSection>
    );
  }

  const login = typeof whoState.login === "string" ? whoState.login : "";
  const shared = Boolean(whoState.shared);
  const owner = Boolean(whoState.owner);
  const people = Array.isArray(whoState.people) ? (whoState.people as Array<{ login: string; owner?: boolean; pending?: boolean }>) : [];
  const githubSignIn = Boolean(whoState.githubSignIn);
  const googleSignIn = Boolean(whoState.googleSignIn);
  const local = Boolean(bridge.local);
  const canConnect = githubSignIn && local && Boolean(window.zevet && typeof window.zevet.githubStart === "function");
  const canConnectGoogle = googleSignIn && local && Boolean(window.zevet && typeof window.zevet.googleStart === "function");
  const localSession = Boolean(bridge.cfg && bridge.cfg.session);

  /* ⚠️ NO "Signed in as" ROW. The closed section header already prints the
     login, and printing it again one line below was the sheet's oldest piece
     of noise. The three-sentence paragraph that used to sit here — team key,
     open the desktop app, this provider is unavailable — is gone for the same
     reason: a button that is not there IS the message. */
  const out: ReactNode[] = [];

  /* `shared` means "on the anonymous team token, no personal session" (hub's
     `shared: !sess`) -- a real personal session (`login` set) always has
     `shared: false`. Gating this whole block on `shared` alone meant a person
     genuinely signed in never saw a Disconnect row at all: `login` first, so
     that case and the shared-but-locally-linked one both offer it. */
  if (login || localSession) {
    if (local && window.zevet && typeof window.zevet.githubLogout === "function") {
      out.push(<GithubDisconnectRow key="disc-github" onDone={() => refreshWhoami()} />);
    }
    if (local && window.zevet && typeof window.zevet.googleLogout === "function") {
      out.push(<GoogleDisconnectRow key="disc-google" onDone={() => refreshWhoami()} />);
    }
  } else if (shared) {
    if (canConnect) out.push(<GithubConnectBox key="connect-github" onDone={() => refreshWhoami()} />);
    if (canConnectGoogle) out.push(<GoogleConnectBox key="connect-google" onDone={() => refreshWhoami()} />);
    if (!canConnect && !canConnectGoogle) out.push(<SNote key="note">Sign in from the desktop app.</SNote>);
  }

  const list: ReactNode[] = [];
  if (people.length) {
    people.forEach((p) => {
      list.push(
        <div className="srow" key={p.login}>
          <span className="k">
            {"@" + p.login + (p.owner ? "  \u00b7 owner" : p.pending ? "  \u00b7 invited" : "")}
          </span>
          <span className="v">
            {owner && !p.owner ? (
              <button className={MAKE_BTN} type="button" disabled={busy} onClick={() => changePeople("/auth/revoke", p.login)}>
                Remove
              </button>
            ) : null}
          </span>
        </div>,
      );
    });
  }
  if (list.length) {
    out.push(
      <div key="people" style={{ marginTop: "8px" }}>
        {list}
      </div>,
    );
  }

  if (owner) {
    out.push(
      <form
        key="invite"
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
      </form>,
    );
  }

  if (whoErr) out.push(<SNote key="err">{whoErr}</SNote>);

  return (
    <SSection title="Account" summary={login ? "@" + login : "not signed in"}>
      {out}
    </SSection>
  );
}

// ---------------------------------------------------------------------------
// Model credentials (D-0NN)
// ---------------------------------------------------------------------------

type CredentialMeta = {
  id: string;
  scope: "team" | "personal";
  label: string;
  provider: string;
  kind: string;
  last4: string;
  addedBy?: string;
};

type CredentialDefault = { scope: "team" | "personal" | "auto"; id?: string } | null;

type LadderStep = { credentialId: string; untilPct: number };

/** provider+kind combinations Settings offers when adding one — the same
 *  pairs hub/server.mjs's CREDENTIAL_ENV table knows an env var for. A
 *  subscription token is personal-scope only; the hub itself refuses one at
 *  team scope regardless of what this form lets someone pick, but the form
 *  does not even offer the combination when "Team" is selected. */
const CREDENTIAL_KINDS: Array<{ provider: string; kind: string; label: string; teamOk: boolean }> = [
  { provider: "anthropic", kind: "api_key", label: "Anthropic — API key", teamOk: true },
  { provider: "anthropic", kind: "subscription_token", label: "Anthropic — subscription token", teamOk: false },
  { provider: "openai", kind: "api_key", label: "OpenAI — API key", teamOk: true },
];

function credentialLine(c: CredentialMeta): string {
  const scope = c.scope === "team" ? "team" : "personal";
  const who = c.scope === "team" && c.addedBy ? `, added by @${c.addedBy}` : "";
  return `${scope} · ${c.provider}/${c.kind} · …${c.last4}${who}`;
}

function CredentialAddForm({ onAdded }: { onAdded: () => void }) {
  const [scope, setScope] = useState<"team" | "personal">("personal");
  const [kindIdx, setKindIdx] = useState(0);
  const label = useRef<HTMLInputElement>(null);
  const key = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const kinds = CREDENTIAL_KINDS.filter((k) => scope === "personal" || k.teamOk);
  const chosen = kinds[Math.min(kindIdx, kinds.length - 1)];

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const k = (key.current && key.current.value.trim()) || "";
    if (!k || !window.zevet?.addCredential) return;
    setBusy(true);
    setErr("");
    window.zevet
      .addCredential({
        scope,
        label: (label.current && label.current.value.trim()) || "",
        provider: chosen.provider,
        kind: chosen.kind,
        key: k,
      })
      .then(
        (r) => {
          setBusy(false);
          if (r && r.ok) {
            if (key.current) key.current.value = "";
            if (label.current) label.current.value = "";
            onAdded();
          } else {
            setErr((r && r.error) || "Could not add that credential.");
          }
        },
        () => {
          setBusy(false);
          setErr("Could not connect.");
        },
      );
  }

  return (
    <form className="sinvite" style={{ flexWrap: "wrap", gap: "6px" }} onSubmit={submit}>
      <Select
        value={scope}
        onValueChange={(v: string | null) => {
          if (!v) return;
          setScope(v as "team" | "personal");
          setKindIdx(0);
        }}
      >
        <SelectTrigger size="sm" className="h-7 shrink-0 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs" aria-label="Scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="personal">Personal (this machine only)</SelectItem>
          <SelectItem value="team">Team (shared with everyone)</SelectItem>
        </SelectContent>
      </Select>
      <Select value={String(kindIdx)} onValueChange={(v: string | null) => setKindIdx(Number(v ?? 0))}>
        <SelectTrigger size="sm" className="h-7 shrink-0 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs" aria-label="Provider and kind">
          <SelectValue>{() => chosen.label}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {kinds.map((k, i) => (
            <SelectItem key={`${k.provider}:${k.kind}`} value={String(i)}>
              {k.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input className="mono" type="text" ref={label} placeholder="Label (optional)" autoComplete="off" spellCheck={false} style={{ minWidth: "120px" }} />
      <input className="mono" type="password" ref={key} placeholder="Paste the key" autoComplete="off" spellCheck={false} style={{ minWidth: "220px" }} />
      <button className={MAKE_BTN} type="submit" disabled={busy}>
        Add
      </button>
      {err ? <SNote>{err}</SNote> : null}
    </form>
  );
}

/** The Auto ladder editor. Only shown once "Auto" is the chosen default — a
 *  ladder nobody has selected is dead weight to look at. */
function LadderEditor({ credentials, ladder, onSaved }: { credentials: CredentialMeta[]; ladder: LadderStep[]; onSaved: () => void }) {
  const [rows, setRows] = useState<LadderStep[]>(ladder);
  const [busy, setBusy] = useState(false);

  function save(next: LadderStep[]) {
    setRows(next);
    setBusy(true);
    window.zevet?.setCredentialLadder?.(next).then(
      () => {
        setBusy(false);
        onSaved();
      },
      () => setBusy(false),
    );
  }

  return (
    <div style={{ marginTop: "6px" }}>
      <SNote>Rotates in order: each launch uses the first step whose credential is below its own usage ceiling.</SNote>
      {rows.map((r, i) => (
        <div className="srow" key={i}>
          <Select
            value={r.credentialId}
            onValueChange={(v: string | null) => save(rows.map((row, j) => (j === i ? { ...row, credentialId: v || "" } : row)))}
          >
            <SelectTrigger size="sm" className="h-7 shrink-0 rounded-full border-transparent bg-foreground/[0.04] px-2 text-xs" aria-label="Credential">
              <SelectValue placeholder="(choose a credential)" />
            </SelectTrigger>
            <SelectContent align="start">
              {credentials.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label} (…{c.last4})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="v">
            until{" "}
            <input
              className="mono"
              type="number"
              min={0}
              max={100}
              value={r.untilPct}
              style={{ width: "56px" }}
              onChange={(ev) => save(rows.map((row, j) => (j === i ? { ...row, untilPct: Number(ev.target.value) } : row)))}
            />
            %
            <button className={MAKE_BTN} type="button" disabled={busy} onClick={() => save(rows.filter((_, j) => j !== i))}>
              Remove
            </button>
          </span>
        </div>
      ))}
      <button
        className={MAKE_BTN}
        type="button"
        disabled={busy}
        onClick={() => save([...rows, { credentialId: credentials[0]?.id || "", untilPct: 100 }])}
      >
        Add a step
      </button>
    </div>
  );
}

function CredentialsSection() {
  const available = Boolean(window.zevet && typeof window.zevet.listCredentials === "function");
  const [list, setList] = useState<CredentialMeta[] | null>(null);
  const [def, setDef] = useState<CredentialDefault>(null);
  const [ladder, setLadder] = useState<LadderStep[]>([]);
  const [err, setErr] = useState("");

  function refresh() {
    if (!available || !window.zevet?.listCredentials) return;
    window.zevet.listCredentials().then(
      (r) => {
        if (r && r.ok) {
          setList((r.credentials as CredentialMeta[]) || []);
          setDef((r.default as CredentialDefault) || null);
        } else {
          setErr((r && r.error) || "Could not load credentials.");
        }
      },
      () => setErr("Could not connect."),
    );
    window.zevet?.credentialLadder?.().then((l) => setLadder(l || []));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  if (!available) {
    return (
      <SSection title="Model credentials" summary="desktop app only">
        <SNote>Manage credentials from the Zevet desktop app.</SNote>
      </SSection>
    );
  }

  function isDefault(c: CredentialMeta) {
    return Boolean(def && def.scope === c.scope && def.id === c.id);
  }

  function chooseDefault(c: CredentialMeta | null) {
    window.zevet?.setDefaultCredential?.(c ? { scope: c.scope, id: c.id } : null).then(() => refresh());
  }

  function chooseAuto() {
    window.zevet?.setDefaultCredential?.({ scope: "auto" }).then(() => refresh());
  }

  function remove(c: CredentialMeta) {
    window.zevet?.removeCredential?.({ scope: c.scope, id: c.id }).then(() => refresh());
  }

  const rows = list || [];
  const summary = def
    ? def.scope === "auto"
      ? "auto-rotating"
      : rows.find((c) => isDefault(c))?.label || "set"
    : "not set";

  return (
    <SSection title="Model credentials" summary={summary}>
      {rows.map((c) => (
        <div className="srow" key={`${c.scope}:${c.id}`}>
          <span className="k mono">{c.label || credentialLine(c)}</span>
          <span className="v">
            {c.label ? <span className="mono">{credentialLine(c)}</span> : null}
            <label style={{ marginLeft: "8px" }}>
              <input type="radio" name="credentialDefault" checked={isDefault(c)} onChange={() => chooseDefault(c)} /> use
            </label>
            <button className={MAKE_BTN} type="button" onClick={() => remove(c)}>
              Remove
            </button>
          </span>
        </div>
      ))}
      <div className="srow">
        <span className="k">Auto-rotate</span>
        <span className="v">
          <label>
            <input type="radio" name="credentialDefault" checked={Boolean(def && def.scope === "auto")} onChange={chooseAuto} /> use the ladder below
          </label>
        </span>
      </div>
      {def && def.scope === "auto" ? <LadderEditor credentials={rows} ladder={ladder} onSaved={refresh} /> : null}
      <CredentialAddForm onAdded={refresh} />
      {err ? <SNote>{err}</SNote> : null}
    </SSection>
  );
}

function IndexSection() {
  const stripMachine = useBoard((s) => s.strip.machine);
  const indexStatus = useBoard((s) => s.indexStatus);
  const refreshIndexStatus = useBoard((s) => s.refreshIndexStatus);
  const setIndex = useBoard((s) => s.setIndex);
  const index = useBoard((s) => s.index);
  const localRoot = useBoard((s) => s.localRoot);

  /* ⚠️ THE DEPS WERE EMPTY, and two things this reads arrive after mount.
     `localRoot` is the one that mattered: the index status is a fact about a
     FOLDER, and opening a different one never re-asked, so the Code search
     section went on describing the repo you had left. `stripMachine` is
     fetched too, so the guard above it was always evaluated against null on
     the one run this effect ever had. */
  useEffect(() => {
    if (stripMachine && stripMachine.cindex === true) return;
    if (bridge.local && typeof bridge.local.indexStatus === "function") refreshIndexStatus();
  }, [localRoot, stripMachine, refreshIndexStatus]);

  const m = stripMachine as (StatusResultView & { cindex?: boolean; cindexPort?: number }) | null;
  if (m && m.cindex === true) {
    return (
      <SSection title="Code search" summary="external">
        <SNote>
          Managed externally.
        </SNote>
      </SSection>
    );
  }
  if (!bridge.local || typeof bridge.local.indexStatus !== "function") {
    return (
      <SSection title="Code search" summary="unavailable">
        <SNote>Not available in this build.</SNote>
      </SSection>
    );
  }
  const st = (indexStatus || null) as IndexStatusView | null;
  if (!st) {
    return (
      <SSection title="Code search" summary="checking…">
        <SNote>Checking this machine…</SNote>
      </SSection>
    );
  }

  const measured = st.measured || {};
  const node: ReactNode[] = [];
  node.push(
    <SRow
      key="machine"
      k="This machine"
      v={measured.totalMemMB
        ? Math.round(measured.totalMemMB / 1024) + " GB RAM \u00b7 " + measured.cores + " cores \u00b7 " + Math.round((measured.freeDiskMB || 0) / 1024) + " GB free"
        : "could not be measured"}
    />,
  );

  if (!st.capable) {
    node.push(<SRow key="status" k="Status" v="not enabled on this machine" />);
    node.push(<SNote key="why">{st.reasons.join("  \u00b7  ")}</SNote>);
    return (
      <SSection title="Code search" summary="off">{node}</SSection>
    );
  }

  const stats = st.stats || null;
  node.push(
    <SRow
      key="model"
      k="Model"
      v={st.model.present ? "downloaded (" + Math.round(st.model.bytes / 1048576) + " MB)" : "not downloaded yet (about 86 MB)"}
    />,
  );
  node.push(
    <SRow key="index" k="Index" v={stats ? stats.files + " files" : "not built for this folder"} />,
  );
  node.push(
    <button
      key="btn"
      className={MAKE_BTN}
      type="button"
      style={{ marginTop: "10px" }}
      disabled={!localRoot || st.building}
      onClick={() => {
        setIndex({ progressText: "starting…", barPct: 0 });
        bridge.local && typeof bridge.local.indexEnable === "function" &&
          bridge.local.indexEnable(localRoot).then((r) => {
            setIndex({
              progressText: r && r.ok ? "done \u2014 " + r.indexed + " indexed, " + r.skipped + " skipped" : "failed: " + ((r && r.error) || "unknown"),
            });
            refreshIndexStatus();
          }).catch((err: unknown) => {
            setIndex({ progressText: "failed: " + (err instanceof Error ? err.message : "unknown") });
            refreshIndexStatus();
          });
      }}
    >
      {st.building ? "Building…" : stats ? "Refresh the index" : "Build the index"}
    </button>,
  );

  if (!localRoot) node.push(<SNote key="pick">Open a folder to build its index.</SNote>);
  if (index.progressText !== "ready") node.push(<SNote key="prog">{index.progressText}</SNote>);
  if (index.barPct > 0 && index.barPct < 100) {
    node.push(
      <div className="sbar" key="bar">
        <span style={{ width: index.barPct + "%" }} />
      </div>,
    );
  }
  return (
    <SSection title="Code search" summary={stats ? stats.files + " files" : "not built"}>{node}</SSection>
  );
}

type StatusResultView = { repo?: { branch?: string; sha?: string } } & Record<string, unknown>;
type IndexStatusView = {
  ok?: boolean;
  measured?: { totalMemMB?: number; freeDiskMB?: number; cores?: number };
  capable?: boolean;
  reasons: string[];
  model: { present: boolean; bytes: number };
  stats?: { files: number; chunks: number };
  building?: boolean;
};

function VersionSection() {
  const { state: s, checking, installing } = useBoard(selectUpdates);
  const updateCheck = useBoard((s) => s.updateCheck);
  const updateInstall = useBoard((s) => s.updateInstall);
  if (!bridge.local || typeof bridge.local.updateStatus !== "function") {
    return (
      <SSection title="Version" summary="web">
        <SNote>Get the latest version at usemasora.com/zevet.</SNote>
      </SSection>
    );
  }
  const up = { checking, installing };
  const out: ReactNode[] = [];
  const status = updateStatusText(s, up);
  out.push(
    <div className="srow" aria-live="polite" key="status">
      <span className="k">Status</span>
      <span className="v">{status}</span>
    </div>,
  );
  if (s && s.phase === "downloading") {
    const pct = updatePercent(s);
    out.push(
      <div className="sbar" role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} key="bar">
        <span style={{ width: pct + "%" }} />
      </div>,
    );
  }
  const hasCheck = Boolean(bridge.local && typeof bridge.local.updateCheck === "function");
  const hasInstall = Boolean(bridge.local && typeof bridge.local.updateInstall === "function");
  const cmd = updateCommand(s, up, { hasCheck, hasInstall });
  const actions: ReactNode[] = [];
  if (cmd && cmd.kind !== "check") {
    actions.push(
      <button
        className={MAKE_BTN}
        type="button"
        key="install"
        disabled={cmd.disabled}
        onClick={() => updateInstall()}
      >
        {cmd.label}
      </button>,
    );
  }
  if (hasCheck) {
    actions.push(
      <button
        className={MAKE_BTN}
        type="button"
        key="check"
        disabled={checking || installing || (s && s.phase === "checking") || (s && s.phase === "downloading") || false}
        onClick={() => updateCheck()}
      >
        {checking || (s && s.phase === "checking") ? "Checking…" : "Check now"}
      </button>,
    );
  }
  out.push(<SRow key="updates" k="Updates" v={<div className="update-actions">{actions}</div>} />);
  return (
    <SSection title="Version" summary={s && s.current ? s.current : "unknown"}>{out}</SSection>
  );
}

/**
 * Pairing with Masora (T5, docs/contracts/cross_app_context.md). Settings
 * row idiom per commit 27d7004: the closed row already says what this is set
 * to -- "not paired", or the paired host -- so nothing needs opening to read
 * the one fact this section exists for.
 */
function MasoraSection() {
  const localWorkspaces = useBoard((s) => s.localWorkspaces);
  const [cfg, setCfg] = useState<{ url: string; paired: boolean; repos: Record<string, boolean>; chat?: boolean } | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [pair, setPair] = useState<
    | { phase: "idle" }
    | { phase: "starting" }
    | { phase: "waiting"; code: string }
    | { phase: "fail"; message: string }
  >({ phase: "idle" });

  function refresh() {
    window.zevet?.masoraConfig?.().then((c) => {
      if (c) {
        setCfg(c);
        setUrlDraft(c.url);
      }
    });
  }
  useEffect(() => {
    if (!cfg) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!bridge.local) return null;

  function pairClick() {
    if (pair.phase === "waiting") {
      window.zevet?.masoraPairCancel?.();
      setPair({ phase: "idle" });
      return;
    }
    setPair({ phase: "starting" });
    window.zevet?.masoraPairStart?.().then((r) => {
      if (!r || !r.ok) {
        setPair({ phase: "fail", message: (r && r.error) || "Could not start pairing." });
        return;
      }
      setPair({ phase: "waiting", code: r.userCode || "" });
      window.zevet?.masoraPairWait?.().then(
        (done) => {
          if (!done || !done.ok) {
            if (done && done.cancelled) setPair({ phase: "idle" });
            else setPair({ phase: "fail", message: (done && done.error) || "Pairing failed." });
            return;
          }
          setPair({ phase: "idle" });
          refresh();
        },
        (err) => setPair({ phase: "fail", message: (err && err.message) || "Pairing failed." }),
      );
    }, (err) => setPair({ phase: "fail", message: (err && err.message) || "Could not start pairing." }));
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url; // the URL field can't be hand-edited once paired, but a
      // malformed saved value must still render a row rather than crash one.
    }
  }
  const summary = !cfg ? "loading…" : cfg.paired ? hostOf(cfg.url) : "not paired";

  return (
    <SSection title="Masora" summary={summary}>
      <div className="srow">
        <span className="k">URL</span>
        <input
          className="mono"
          type="text"
          value={urlDraft}
          onChange={(ev) => setUrlDraft(ev.target.value)}
          onBlur={() => {
            if (cfg && urlDraft.trim() && urlDraft.trim() !== cfg.url) {
              window.zevet?.masoraSaveUrl?.(urlDraft.trim()).then((c) => c && setCfg(c));
            }
          }}
          disabled={Boolean(cfg && cfg.paired)}
          spellCheck={false}
        />
      </div>
      {cfg && cfg.paired ? (
        <div className="srow">
          <button
            className={MAKE_BTN}
            type="button"
            onClick={() => window.zevet?.masoraUnpair?.().then(() => refresh())}
          >
            Unpair
          </button>
        </div>
      ) : (
        <div className="srow">
          <button className={MAKE_BTN} type="button" disabled={pair.phase === "starting"} onClick={pairClick}>
            {pair.phase === "waiting" ? "Cancel" : pair.phase === "starting" ? "Starting…" : "Pair with Masora"}
          </button>
          {pair.phase === "waiting" ? <span className="v mono">{pair.code}</span> : null}
        </div>
      )}
      {pair.phase === "fail" ? <SNote style={{ color: "var(--bad)" }}>{pair.message}</SNote> : null}
      {cfg && cfg.paired ? (
        <>
          {window.zevet?.masoraChatPush ? (
            <div className="srow" id="settingsChatPush">
              <span className="k">Chat</span>
              <span className="v">
                <button
                  className={MAKE_BTN}
                  type="button"
                  aria-pressed={Boolean(cfg.chat)}
                  onClick={() => window.zevet?.masoraChatPush?.(!cfg.chat).then((c) => c && setCfg(c))}
                >
                  {cfg.chat ? "Syncing" : "Off"}
                </button>
              </span>
            </div>
          ) : null}
          <SNote>Off by default, per folder.</SNote>
          {(localWorkspaces || []).map((w) => (
            <div className="srow" key={w.dir}>
              <span className="k">{w.name}</span>
              <span className="v">
                <button
                  className={MAKE_BTN}
                  type="button"
                  aria-pressed={Boolean(cfg.repos[w.dir])}
                  onClick={() =>
                    window.zevetLocal
                      ?.masoraRepoToggle?.(w.dir, !cfg.repos[w.dir])
                      .then((r) => r && r.repos && setCfg({ ...cfg, repos: r.repos }))
                  }
                >
                  {cfg.repos[w.dir] ? "Syncing" : "Off"}
                </button>
              </span>
            </div>
          ))}
        </>
      ) : null}
    </SSection>
  );
}

/**
 * Connections to external services via Masora (Linear, GitHub, Slack, Google
 * Drive, Gmail, Google Calendar, Notion, Zoom). Each provider's OAuth flow is
 * initiated by Masora's /api/oauth/{provider}/install, opened in the system
 * browser. Status is fetched from Masora's /api/sources. Zevet holds no secrets.
 */
function ConnectionsSection() {
  const [sources, setSources] = useState<Record<string, string> | null>(null);
  const [cfg, setCfg] = useState<{ paired: boolean } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  const PROVIDERS = [
    { id: "linear", label: "Linear" },
    { id: "github", label: "GitHub" },
    { id: "slack", label: "Slack" },
    { id: "gdrive", label: "Google Drive" },
    { id: "gmail", label: "Gmail" },
    { id: "gcal", label: "Google Calendar" },
    { id: "notion", label: "Notion" },
    { id: "zoom", label: "Zoom" },
  ];

  function refresh() {
    window.zevet?.masoraConfig?.().then((c) => {
      if (c) setCfg(c);
    });
    if (cfg?.paired) {
      window.zevet?.masoraSources?.().then((r) => {
        if (r && r.sources) {
          const map: Record<string, string> = {};
          for (const s of r.sources) {
            map[s.kind] = s.status === "connected" ? "connected" : "reconnect";
          }
          setSources(map);
        } else if (r && r.error === "token") {
          // Token auth failed; show "—" status
          setSources({});
        }
      });
    }
  }

  useEffect(() => {
    if (!cfg) {
      window.zevet?.masoraConfig?.().then((c) => {
        if (c) setCfg(c);
      });
    }
  }, []);

  useEffect(() => {
    refresh();
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.paired]);

  if (!cfg) return null;
  if (!cfg.paired) return null;

  if (!bridge.local) return null;

  function statusLabel(provider: string): string {
    if (!sources) return "loading…";
    if (sources[provider] === "connected") return "connected";
    if (sources[provider] === "reconnect") return "reconnect";
    return "—";
  }

  function buttonLabel(provider: string): string {
    const status = statusLabel(provider);
    return status === "connected" ? "Connected" : "Connect";
  }

  function connect(provider: string) {
    setConnecting(provider);
    window.zevet?.masoraConnect?.({ provider }).finally(() => {
      setConnecting(null);
      setTimeout(() => refresh(), 1000);
    });
  }

  return (
    <SSection title="Connections" summary={sources ? "configured" : "loading…"}>
      {PROVIDERS.map((p) => (
        <div className="srow" key={p.id}>
          <span className="k">{p.label}</span>
          <span className="v">
            <button
              className={MAKE_BTN}
              type="button"
              disabled={connecting === p.id}
              onClick={() => connect(p.id)}
            >
              {connecting === p.id ? "Opening…" : buttonLabel(p.id)}
            </button>
          </span>
        </div>
      ))}
    </SSection>
  );
}

function credentialLabel() {
  const c = bridge.cfg;
  if (!c) return "unknown";
  if (c.legacy) return "Set up shared editing";
  if (c.session) return "GitHub sign-in" + (c.hasSecret ? " + team key" : " \u00b7 team key missing");
  return c.hasSecret ? "team key" : "none configured";
}

export function SettingsSheet() {
  const sheetOpen = useBoard((s) => s.sheetOpen);
  const closeSettings = useBoard((s) => s.closeSettings);
  const viewMode = useBoard(selectViewMode);
  const setView = useBoard((s) => s.setView);
  const localWorkspaces = useBoard((s) => s.localWorkspaces);
  const myActor = useBoard((s) => s.myActor);

  const sheetRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (sheetOpen) {
      wasOpen.current = true;
      document.getElementById("settingsClose")?.focus();
      const sheetEl = sheetRef.current;
      if (!sheetEl) return;
      // Tab is trapped inside the sheet in both directions; Shift+Tab from the
      // first control and Tab from the last both wrap.
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Tab") return;
        const list = Array.from(
          sheetEl.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]"),
        ).filter((el) => el.tabIndex >= 0 && el.offsetParent !== null && (!("disabled" in el) || !el.disabled));
        if (!list.length) {
          ev.preventDefault();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement;
        if (ev.shiftKey && (active === first || !sheetEl.contains(active))) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && (active === last || !sheetEl.contains(active))) {
          ev.preventDefault();
          first.focus();
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      document.getElementById("settingsLink")?.focus();
    }
  }, [sheetOpen]);

  if (!sheetOpen) return null;
  const local = Boolean(bridge.local);

  return (
    <>
      <div className="sheet-back" id="sheetBack" onClick={() => closeSettings()} />
      <div className="sheet" id="sheet" role="dialog" aria-label="Settings" aria-modal="true" tabIndex={-1} ref={sheetRef}>
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="sheet-close" id="settingsClose" type="button" onClick={() => closeSettings()}>
            Close
          </button>
        </div>

        {/* ⚠️ NO APPEARANCE SECTION. The light/dark toggle lives in the strip,
            where it is one click away instead of three, and Andrew asked for
            the duplicate here to go: "that's already represented outside of
            settings." Two controls for one piece of state is also two places
            for it to look wrong. */}
        <SSection title="View" summary={viewMode === "ide" ? "Files" : "Agent"}>
          <div className="sbtn-row">
            {(
              [
                ["ide", "Files"],
                ["agent", "Agent"],
              ] as const
            ).map(([id, label]) => (
              <button
                className={MAKE_BTN}
                id={"settingsView-" + id}
                key={id}
                type="button"
                aria-pressed={viewMode === id}
                disabled={viewMode === id}
                onClick={() => setView(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </SSection>

        <PermissionSection />
        <AgentSettings />

        <SSection
          title="Folders"
          summary={!local ? "desktop only" : localWorkspaces.length ? String(localWorkspaces.length) : "none"}
        >
          {!local ? (
            <SNote>Use the desktop app to open local folders.</SNote>
          ) : (
            <>
              {(localWorkspaces || []).map((w) => (
                <div className="srow" key={w.dir}>
                  <span className="k">{w.name + (w.repo ? "" : "  (folder)")}</span>
                </div>
              ))}
              <button className={MAKE_BTN} type="button" style={{ marginTop: "10px" }} onClick={() => useBoard.getState().addWorkspace()}>
                Add a folder…
              </button>
            </>
          )}
        </SSection>

        <AccountSection />
        <CredentialsSection />
        <IndexSection />
        <MasoraSection />
        <ConnectionsSection />

        <SSection title="Connection" summary={credentialLabel()}>
          <SRow k="Team address" v={bridge.hub} mono />
          <SRow k="You" v={myActor || "unknown"} />
        </SSection>

        <VersionSection />
      </div>
    </>
  );
}