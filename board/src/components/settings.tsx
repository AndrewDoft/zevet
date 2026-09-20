import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { bridge } from "../lib/bridge";
import { connectPhaseLabel, connectValue, disconnectValue } from "../lib/connect.mjs";
import {
  selectUpdates,
  selectViewMode,
  useBoard,
} from "../lib/board";
import { updateCommand, updatePercent, updateStatusText } from "../lib/update.mjs";

function SRow({ k, v, mono }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="srow">
      <span className="k">{k}</span>
      <span className={mono ? "v mono" : "v"}>{v}</span>
    </div>
  );
}

function SSection({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  return (
    <div className="sset" id={id}>
      <h3>{title}</h3>
      {children}
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

  const label = connectPhaseLabel(state.phase);

  const value = connectValue(state.phase, state);

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
        {state === "busy" ? "Disconnecting\u2026" : state === "fail" ? "Retry" : "Disconnect GitHub"}
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
      <SSection title="Account">
        <SNote>Loading account…</SNote>
      </SSection>
    );
  }

  const login = typeof whoState.login === "string" ? whoState.login : "";
  const shared = Boolean(whoState.shared);
  const owner = Boolean(whoState.owner);
  const people = Array.isArray(whoState.people) ? (whoState.people as Array<{ login: string; owner?: boolean; pending?: boolean }>) : [];
  const githubSignIn = Boolean(whoState.githubSignIn);
  const local = Boolean(bridge.local);
  const canConnect = githubSignIn && local && Boolean(window.zevet && typeof window.zevet.githubStart === "function");
  const localSession = Boolean(bridge.cfg && bridge.cfg.session);

  const out: ReactNode[] = [<SRow key="as" k="Signed in as" v={login ? "@" + login : "not signed in"} />];

  if (shared) {
    let note = "Connected with a team key.";
    if (githubSignIn) {
      if (!canConnect && !localSession) note += " Open the desktop app to sign in with GitHub.";
    } else {
      note += " GitHub sign-in is unavailable on this hub.";
    }
    out.push(<SNote key="note">{note}</SNote>);
    if (!login && !localSession) {
      if (canConnect) out.push(<GithubConnectBox key="connect" onDone={() => refreshWhoami()} />);
    } else {
      if (login) out.push(<SRow key="as2" k="Signed in as" v={"@" + login} />);
      if (localSession && !login) out.push(<SNote key="mh">GitHub connected on this machine.</SNote>);
      if (local && window.zevet && typeof window.zevet.githubLogout === "function") {
        out.push(<GithubDisconnectRow key="disc" onDone={() => refreshWhoami()} />);
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
        className="row"
        style={{ marginTop: "10px" }}
        onSubmit={(ev) => {
          ev.preventDefault();
          const v = (invite.current && invite.current.value.trim()) || "";
          if (v) changePeople("/auth/allow", v);
        }}
      >
        <input className="mono" id="settingsInvite" type="text" ref={invite} aria-label="GitHub username" placeholder="GitHub username" autoComplete="off" spellCheck={false} />
        <button className={MAKE_BTN} type="submit" disabled={busy}>
          Invite
        </button>
      </form>,
      <SNote key="howto">Send them this hub’s address. They can sign in with GitHub after installing zevet.</SNote>,
    );
  }

  if (whoErr) out.push(<SNote key="err">{whoErr}</SNote>);

  return (
    <SSection title="Account">
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

  useEffect(() => {
    if (stripMachine && stripMachine.cindex === true) return;
    if (bridge.local && typeof bridge.local.indexStatus === "function") refreshIndexStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const m = stripMachine as (StatusResultView & { cindex?: boolean; cindexPort?: number }) | null;
  if (m && m.cindex === true) {
    return (
      <SSection title="Code index">
        <SRow k="Status" v="external index running" />
        <SNote>
          External index on port {String(m.cindexPort || 8080)}. Stop it to use zevet’s built-in index.
        </SNote>
      </SSection>
    );
  }
  if (!bridge.local || typeof bridge.local.indexStatus !== "function") {
    return (
      <SSection title="Code index">
        <SNote>Not available in this build.</SNote>
      </SSection>
    );
  }
  const st = (indexStatus || null) as IndexStatusView | null;
  if (!st) {
    return (
      <SSection title="Code index">
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
        ? Math.round(measured.totalMemMB / 1024) + " GB RAM \u00b7 " + measured.cores + " cores \u00b7 " +
          Math.round((measured.freeDiskMB || 0) / 1024) + " GB free"
        : "could not be measured"}
    />,
  );

  if (!st.capable) {
    node.push(<SRow key="status" k="Status" v="not enabled on this machine" />);
    node.push(<SNote key="why">{st.reasons.join("  \u00b7  ")}</SNote>);
    node.push(<SNote key="fine">Other features remain available.</SNote>);
    return (
      <SSection title="Code index">{node}</SSection>
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
        setIndex({ progressText: "starting\u2026", barPct: 0 });
        bridge.local && typeof bridge.local.indexEnable === "function" &&
          bridge.local.indexEnable(localRoot).then((r) => {
            setIndex({
              progressText: r && r.ok ? "done \u2014 " + r.indexed + " indexed, " + r.skipped + " skipped" : "failed: " + ((r && r.error) || "unknown"),
            });
            refreshIndexStatus();
          });
      }}
    >
      {st.building ? "Building\u2026" : stats ? "Refresh the index" : "Build the index"}
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
  node.push(<SNote key="cost">The index is built and stored on this machine.</SNote>);

  return (
    <SSection title="Code index">{node}</SSection>
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
      <SSection title="Version">
        <SNote>Get the latest version at usemasora.com/zevet.</SNote>
      </SSection>
    );
  }
  const up = { checking, installing };
  const out: ReactNode[] = [<SRow key="inst" k="Installed" v={s && s.current ? s.current : "unknown"} />];
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
        {checking || (s && s.phase === "checking") ? "Checking\u2026" : "Check now"}
      </button>,
    );
  }
  out.push(<SRow key="updates" k="Updates" v={<div className="update-actions">{actions}</div>} />);
  return (
    <SSection title="Version">{out}</SSection>
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
  const theme = useBoard((s) => s.theme);
  const viewMode = useBoard(selectViewMode);
  const setTheme = useBoard((s) => s.setTheme);
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

        <SSection title="Appearance">
          <SRow
            k="Theme"
            v={
              <button className={MAKE_BTN} id="settingsTheme" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                {theme === "dark" ? "Switch to light" : "Switch to dark"}
              </button>
            }
          />
        </SSection>

        <SSection title="View">
          {(
            [
              ["ide", "IDE", "Files, editor and shared cursors."],
              ["agent", "Agent", "Agent conversations with a compact editor."],
            ] as const
          ).map(([id, label, note]) => (
            <div className="srow" key={id}>
              <button
                className={MAKE_BTN}
                id={"settingsView-" + id}
                type="button"
                style={{ marginRight: "8px" }}
                disabled={viewMode === id}
                onClick={() => setView(id)}
              >
                {label + (viewMode === id ? " \u00b7 on" : "")}
              </button>
              <span className="v" style={{ color: "var(--ink-muted)", fontSize: "11.5px" }}>
                {note}
              </span>
            </div>
          ))}
        </SSection>

        <SSection title="Folders">
          {!local ? (
            <SNote>Use the desktop app to open local folders.</SNote>
          ) : (
            <>
              {!localWorkspaces.length ? <SNote>Add a folder to give zevet access.</SNote> : null}
              {(localWorkspaces || []).map((w) => (
                <div className="srow" key={w.dir}>
                  <span className="k">{w.name + (w.repo ? "" : "  (not a git repo)")}</span>
                  <span className="v mono">{w.dir}</span>
                </div>
              ))}
              <button className={MAKE_BTN} type="button" style={{ marginTop: "10px" }} onClick={() => useBoard.getState().addWorkspace()}>
                Add a folder…
              </button>
              <SNote>Identifies your account. Folder access stays limited to the list above.</SNote>
            </>
          )}
        </SSection>

        <AccountSection />
        <IndexSection />

        <SSection title="Connection">
          <SRow k="Hub" v={bridge.hub} mono />
          <SRow k="You" v={myActor || "unknown"} />
          <SRow k="Credential" v={credentialLabel()} />
        </SSection>

        <VersionSection />
      </div>
    </>
  );
}