/** The update controls for the board — status text, the one action command
 *  shared by the rail and Settings so they cannot drift, and the update state
 *  machine the store delegates to. Pure JavaScript on purpose: the gate tests
 *  execute this exact file. */

export function updatePercent(state) {
  return Math.max(0, Math.min(100, Math.floor(Number(state && state.percent) || 0)));
}

export function updateStatusText(state, { checking, installing }) {
  if (installing) return state && state.manual ? "Opening installer\u2026" : "Restarting\u2026";
  if (state && state.phase === "downloading") return "Downloading " + state.version + " \u00b7 " + updatePercent(state) + "%";
  if (state && state.phase === "ready") return state.version + " ready to install";
  if (state && state.phase === "error") return state.error || "Update failed. Try again.";
  if (checking || (state && state.phase === "checking")) return "Checking\u2026";
  if (state && state.phase === "current") return "Up to date";
  return "Not checked yet";
}

export function updateCommand(state, up, { hasCheck, hasInstall }) {
  const busy = up.installing || up.checking;
  if (!state) return null;
  if (state.phase === "downloading") return null;
  if (state.phase === "ready" && state.canInstall === true && hasInstall) {
    return {
      kind: up.installing ? "busy" : state.manual ? "install" : "restart",
      disabled: busy,
      label: up.installing
        ? state.manual ? "Opening\u2026" : "Restarting\u2026"
        : state.manual ? "Open installer" : "Restart to install",
    };
  }
  if (state.phase === "error" && hasCheck) {
    return {
      kind: "check",
      disabled: busy,
      label: up.checking || state.phase === "checking" ? "Checking\u2026" : state.authRequired ? "Sign in for updates" : "Check now",
    };
  }
  return null;
}

export function canInstallState(state, hasInstall) {
  return Boolean(state && state.phase === "ready" && state.canInstall === true && hasInstall());
}

export const INSTALLER_OPENED = "Installer opened. Quit zevet, replace it in Applications, then reopen.";
export const NOT_ACCEPTED = "No update status received. Try again.";
export const CHECK_FAILED = "Update check failed. Try again.";
export const INSTALL_FAILED = "Installer could not open. Try again.";

/** The update state machine. `bridge` is a getter, because the local bridge
 *  only exists inside the desktop shell and only when it is available. */
export function createUpdateControl(bridge, onChange) {
  let s = { state: null, revision: 0, checking: false, installing: false, installError: "", notice: "" };
  const push = (next) => { s = next; onChange(s); };

  function freshOf(next) {
    const cur = s.state;
    return !cur || next.version !== cur.version || next.phase === "checking";
  }

  const ctl = {
    get updates() { return s; },

    setBusy(patch) { push({ ...s, ...patch }); },

    receiveUpdate(next) {
      const fresh = freshOf(next);
      push({
        ...s,
        installError: fresh ? "" : s.installError,
        notice: fresh ? "" : s.notice,
        state: next,
        revision: s.revision + 1,
      });
    },

    check() {
      const br = bridge();
      if (!br || typeof br.updateCheck !== "function") return;
      push({ ...s, checking: true, installError: "", notice: "" });
      Promise.resolve()
        .then(() => br.updateCheck())
        .then((r) => {
          if (!r || typeof r.phase !== "string") throw new Error(NOT_ACCEPTED);
          ctl.receiveUpdate(r);
        })
        .catch((err) => {
          ctl.receiveUpdate({
            ...(ctl.updates.state || {}),
            phase: "error",
            canInstall: false,
            error: (err && err.message) || CHECK_FAILED,
          });
        })
        .finally(() => push({ ...ctl.updates, checking: false }));
    },

    install() {
      const br = bridge();
      if (!br || typeof br.updateInstall !== "function" || !canInstallState(ctl.updates.state, () => Boolean(br.updateInstall))) return;
      push({ ...ctl.updates, installing: true, installError: "", notice: "" });
      Promise.resolve()
        .then(() => br.updateInstall())
        .then((r) => {
          if (!r || !r.ok) {
            push({
              ...ctl.updates,
              installing: false,
              installError: (r && r.error) || INSTALL_FAILED,
            });
            return;
          }
          const next = { ...ctl.updates, installing: false };
          if (r.manual) next.notice = INSTALLER_OPENED;
          push(next);
        })
        .catch((err) =>
          push({
            ...ctl.updates,
            installing: false,
            installError: (err && err.message) || INSTALL_FAILED,
          }),
        );
    },

    /** Subscribe to pushes from the app and read the initial status, guarded so
     *  that an app push that lands during the read is not overwritten. */
    startUpdates() {
      const br = bridge();
      if (!br) return;
      if (typeof br.onUpdate === "function") br.onUpdate((next) => ctl.receiveUpdate(next));
      if (typeof br.updateStatus !== "function") return;
      const revision = ctl.updates.revision;
      Promise.resolve()
        .then(() => br.updateStatus())
        .then((s2) => {
          if (revision === ctl.updates.revision && s2 && typeof s2.phase === "string") {
            ctl.receiveUpdate(s2);
          }
        });
    },
  };
  return ctl;
}
