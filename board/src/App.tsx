import { SettingsIcon } from "lucide-react";
import { useEffect } from "react";
import { PeoplePane } from "./components/people";
import { WorkspacesPane } from "./components/workspaces";
import { Strip } from "./components/strip";
import { ConnBanner } from "./components/conn";
import { BackgroundInbox } from "./components/inbox";
import { Palette } from "./components/palette";
import { UpdateRow } from "./components/updaterow";
import { Consoles } from "./components/consoles";
import { Conversation } from "./components/conversation";
import { ConsoleRuntimeProvider } from "./lib/runtime";
import { TreeFill } from "./components/tree";
import { DetailPane } from "./components/detail";
import { SettingsSheet } from "./components/settings";
import { UpdateDialog } from "./components/updatedialog";
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
      {/* A gear, not the word. Andrew: "get a gear thing instead of the word
          settings". The label moves to the tooltip and the accessible name,
          so nothing is lost for a screen reader or a hover. */}
      <button
        type="button"
        className="settings-link"
        id="settingsLink"
        aria-label="Settings"
        title="Settings"
        onClick={openSettings}
      >
        <SettingsIcon className="size-4" aria-hidden="true" />
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
          {/* ⚠️ THIS USED TO BE GATED ON `viewMode === "ide"`, and in agent
              view — the mode built for talking to agents — it left the rail
              with no thread list at all. Found by using it: start one console
              in agent view and there is no way to switch away from it, no way
              to start a second, and no way back to the launcher, because the
              conversation column only offers the launcher when NO console is
              active and nothing in that view can make that true again.

              The contract this gate was standing in for is a different one,
              and it still holds: exactly one composer, and never in the rail.
              test/board.test.mjs asserts that directly against consoles.tsx —
              no textarea, no sendPrompt — which is the rule that actually
              matters. The list is navigation in both views. */}
          <div id="consolesSlot">
            <div className="pane-title">You</div>
            <div className="pane-body" id="consoles">
              <Consoles />
            </div>
          </div>
          <BackgroundInbox />
          <ConnBanner />
          <Strip />
          <UpdateRow />
          {/* ⚠️ NO "Repos" HEADER. It was a full pane-title row — 24px of
              padding and a word — sitting above a dropdown that already says
              what it is. Andrew: "get rid of the repo header and have the
              dropdown just start with open a repo". The rail's bottom corner
              is now three short rows (status, theme + gear, folder) instead
              of five, and the People list takes back what they were using. */}
          <div className="railfoot">
            <RailFoot />
          </div>
          {/* No wrapper: WorkspacesPane renders its own `.ws #workspaces`, and
              this one duplicated both the class and the id. */}
          <WorkspacesPane />
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
      <Palette />
      <UpdateDialog />
    </ConsoleRuntimeProvider>
  );
}

export default App;