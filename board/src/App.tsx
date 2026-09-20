import { useEffect } from "react";
import { PeoplePane } from "./components/people";
import { WorkspacesPane } from "./components/workspaces";
import { Strip } from "./components/strip";
import { ConnBanner } from "./components/conn";
import { UpdateRow } from "./components/updaterow";
import { Consoles } from "./components/consoles";
import { Conversation } from "./components/conversation";
import { ConsoleRuntimeProvider } from "./lib/runtime";
import { TreeFill } from "./components/tree";
import { DetailPane } from "./components/detail";
import { SettingsSheet } from "./components/settings";
import {
  applyPanes,
  applyTheme,
  applyView,
  boot,
  buildSplits,
  positionSplits,
  selectRoster,
  selectTheme,
  selectViewMode,
  useBoard,
} from "./lib/board";
import { bridge } from "./lib/bridge";

function RailFoot() {
  const theme = useBoard(selectTheme);
  const setTheme = useBoard((s) => s.setTheme);
  const openSettings = useBoard((s) => s.openSettings);
  const isDark = theme === "dark";
  return (
    <>
      <button
        type="button"
        className="themer"
        id="themer"
        aria-label={isDark ? "Light theme" : "Dark theme"}
        aria-pressed={isDark}
        title="Light or dark"
        onClick={() => setTheme(isDark ? "light" : "dark")}
      >
        <span className="sky" aria-hidden="true">
          <span className="sky-circle" />
        </span>
        <span className="lbl" id="themeLabel">
          {isDark ? "Dark" : "Light"}
        </span>
      </button>
      <button type="button" className="settings-link" id="settingsLink" onClick={openSettings}>
        Settings
      </button>
    </>
  );
}

function App() {
  const viewMode = useBoard(selectViewMode);
  const theme = useBoard(selectTheme);
  const sheetOpen = useBoard((s) => s.sheetOpen);
  const closeSettings = useBoard((s) => s.closeSettings);
  const selectedPath = useBoard((s) => s.selectedPath);
  const localRoot = useBoard((s) => s.localRoot);

  const roster = useBoard(selectRoster);
  const local = Boolean(bridge.local);
  const blanked = !roster.length && !(local && localRoot);

  useEffect(() => {
    boot();
  }, []);

  useEffect(() => {
    applyTheme();
  }, [theme]);

  useEffect(() => {
    applyView();
  }, [viewMode, selectedPath]);

  useEffect(() => {
    applyPanes();
  }, [useBoard((s) => s.panes)]);

  useEffect(() => {
    buildSplits();
    positionSplits();
    const onRs = () => positionSplits();
    window.addEventListener("resize", onRs);
    return () => window.removeEventListener("resize", onRs);
  }, []);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen, closeSettings]);

  return (
    <ConsoleRuntimeProvider>
      <div className="shell" inert={sheetOpen ? true : undefined}>
        <aside className="pane rail">
          <div className="pane-title">People</div>
          <div className="pane-body" id="people">
            <PeoplePane />
          </div>
          <div id="consolesSlot">
            {viewMode === "ide" ? (
              <>
                <div className="pane-title">You</div>
                <div className="pane-body" id="consoles">
                  <Consoles />
                </div>
              </>
            ) : null}
          </div>
          <ConnBanner />
          <Strip />
          <UpdateRow />
          <div className="railfoot">
            <RailFoot />
          </div>
          <div className="pane-title" style={{ borderTop: "1px solid var(--line)" }}>
            Repos
          </div>
          <div className="ws" id="workspaces">
            <WorkspacesPane />
          </div>
        </aside>

        <div className="middle">
          <TreeFill blanked={blanked} />
          <div className="chatcol">
            <div className="pane-title">Conversation</div>
            <div className="pane-body" id="chat">
              <Conversation />
            </div>
          </div>
          <main className="detail">
            <DetailPane blanked={blanked} />
          </main>
        </div>
      </div>
      <SettingsSheet />
    </ConsoleRuntimeProvider>
  );
}

export default App;