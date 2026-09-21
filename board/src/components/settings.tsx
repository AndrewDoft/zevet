import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
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
    | { phase: "waiting" }
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
      setState({ phase: "waiting" });
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
      <span className="v">{value}</span>
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
            setWhoErr(r.body.error || ("The hub answered " + r.status + "."));
          }
        },
        () => {
          setBusy(false);
          setWhoErr("Could not reach the hub.");
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

  if (shared) {
    if (!login && !localSession) {
      if (canConnect) out.push(<GithubConnectBox key="connect-github" onDone={() => refreshWhoami()} />);
      if (canConnectGoogle) out.push(<GoogleConnectBox key="connect-google" onDone={() => refreshWhoami()} />);
      if (!canConnect && !canConnectGoogle) out.push(<SNote key="note">Sign in from the desktop app.</SNote>);
    } else {
      if (local && window.zevet && typeof window.zevet.githubLogout === "function") {
        out.push(<GithubDisconnectRow key="disc-github" onDone={() => refreshWhoami()} />);
      }
      if (local && window.zevet && typeof window.zevet.googleLogout === "function") {
        out.push(<GoogleDisconnectRow key="disc-google" onDone={() => refreshWhoami()} />);
      }
    }
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

function IndexSection() {
  const stripMachine = useBoard((s) => s.strip.machine);
  const indexStatus = useBoard((s) => s.indexStatus);
  const refreshIndexStatus = useBoard((s) => s.refreshIndexStatus);
  const setIndex = useBoard((s) => s.setIndex);
  const index = useBoard((s) => s.index);
  const localRoot = useBoard((s) => s.localRoot);

  /* ⚠️ THE DEPS WERE EMPTY, and two things this reads arrive after mount.
     `localRoot` is the one that mattered: the index status is a fact about a
     FOLDER, and opening a different one never re-asked, so the Code index
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
      <SSection title="Code index" summary="external">
        <SNote>
          External index on port {String(m.cindexPort || 8080)}. Stop it to use zevet's built-in index.
        </SNote>
      </SSection>
    );
  }
  if (!bridge.local || typeof bridge.local.indexStatus !== "function") {
    return (
      <SSection title="Code index" summary="unavailable">
        <SNote>Not available in this build.</SNote>
      </SSection>
    );
  }
  const st = (indexStatus || null) as IndexStatusView | null;
  if (!st) {
    return (
      <SSection title="Code index" summary="checking…">
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
      <SSection title="Code index" summary="off">{node}</SSection>
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
    <SRow key="index" k="Index" v={stats ? stats.files + " files \u00b7 " + stats.chunks + " chunks" : "not built for this folder"} />,
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
    <SSection title="Code index" summary={stats ? stats.files + " files" : "not built"}>{node}</SSection>
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

function credentialLabel() {
  const c = bridge.cfg;
  if (!c) return "unknown";
  if (c.legacy) return "legacy token \u00b7 run setup for shared editing";
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
        <SSection title="View" summary={viewMode === "ide" ? "IDE" : "Agent"}>
          <div className="sbtn-row">
            {(
              [
                ["ide", "IDE"],
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
                  <span className="k">{w.name + (w.repo ? "" : "  (not a git repo)")}</span>
                  <span className="v mono">{w.dir}</span>
                </div>
              ))}
              <button className={MAKE_BTN} type="button" style={{ marginTop: "10px" }} onClick={() => useBoard.getState().addWorkspace()}>
                Add a folder…
              </button>
            </>
          )}
        </SSection>

        <AccountSection />
        <IndexSection />

        <SSection title="Connection" summary={credentialLabel()}>
          <SRow k="Hub" v={bridge.hub} mono />
          <SRow k="You" v={myActor || "unknown"} />
        </SSection>

        <VersionSection />
      </div>
    </>
  );
}