import { SettingsIcon } from "lucide-react";
import { useEffect } from "react";
import { PeoplePane } from "./components/people";
import { WorkspacesPane } from "./components/workspaces";
import { Strip } from "./components/strip";
import { ConnBanner } from "./components/conn";
import { Palette } from "./components/palette";
import { UpdateRow } from "./components/updaterow";
import { Conversation } from "./components/conversation";
import { ConsoleRuntimeProvider } from "./lib/runtime";
import { FollowControl, TreeFill } from "./components/tree";
import { DetailPane } from "./components/detail";
import { SettingsSheet } from "./components/settings";
import { UpdateDialog } from "./components/updatedialog";
import { VoiceDialog } from "./components/voicedialog";
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
  const viewMode = useBoard(selectViewMode);
  const setView = useBoard((s) => s.setView);
  const openSettings = useBoard((s) => s.openSettings);
  const isDark = theme === "dark";
  const isAgent = viewMode === "agent";
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
      {/* Same idiom as the theme switch beside it - one pill, two states -
          rather than a settings row, now that both live here instead of in
          the sheet. See settings.tsx for why the View section left. */}
      <button
        type="button"
        className="themer"
        id="viewToggle"
        aria-label={isAgent ? "IDE view" : "Agent view"}
        aria-pressed={isAgent}
        title="IDE or agent view"
        onClick={() => setView(isAgent ? "ide" : "agent")}
      >
        <span className="sky" aria-hidden="true">
          <span className="sky-circle" />
        </span>
        <span className="lbl">{isAgent ? "Agent" : "IDE"}</span>
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
  const conversationOpen = useBoard((s) => s.conversationOpen);
  const localRoot = useBoard((s) => s.localRoot);

  const roster = useBoard(selectRoster);
  const launching = useBoard((s) => s.launching);
  const openLauncher = useBoard((s) => s.openLauncher);
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
  }, [viewMode, selectedPath, conversationOpen]);

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
          {/* The follow control sits here now, not in the Files column's own
              header - which let that header go, and the tree start at the top
              of its column. It is a People control by meaning as well as by
              position: mine/all/off says whose work to watch. */}
          <div className="pane-title row">
            {/* ⚠️ THE LABEL IS "Agents"; THE ID IS STILL `#people`. What this
                pane lists is a person and the agents running under them, and
                Andrew asked for it to say so. The id stays because it is the
                hook a dozen CSS rules and two tests reach for, and renaming a
                selector to match a word is churn with a chance of a miss. */}
            <span>Agents</span>
            {/* ⚠️ THE PLUS IS THE LAUNCHER. It used to be a full text row at
                the bottom of the You list reading "Start an agent…", which is
                a whole line of a 250px rail spent on a verb. Andrew: "there is
                also no need for like the new agent thing, you can put a plus
                sign somewhere else." Here it costs nothing: the title row was
                already this tall for the follow control beside it.
                Gated on an open folder for the same reason the row was — with
                no repo there is nothing to start an agent IN, and a launcher
                that opens onto that is a dead end. */}
            {bridge.local && localRoot ? (
              <button
                type="button"
                className="rail-new"
                aria-expanded={launching}
                aria-haspopup="dialog"
                aria-label="Start an agent"
                title="Start an agent"
                onClick={openLauncher}
              >
                +
              </button>
            ) : null}
            <FollowControl blanked={blanked} />
          </div>
          <div className="pane-body" id="people">
            <PeoplePane />
          </div>
          {/* ⚠️ THE "You" SECTION IS GONE. It used to be a second rail list —
              its own heading, its own `#consolesSlot` host, its own
              Consoles component — sitting below People and showing only the
              agents zevet itself had launched. Andrew: "this terminal conv is
              tracked in the right place (people), but the claude session in
              zevet is at the bottom of the people window, somewhere else."
              A console now normalises into the same `AgentRow` a terminal
              session renders as, in its repo group, in people.tsx — so there
              is one tree instead of two, and the contract "exactly one
              composer, never in the rail" (still real: the Thread in #chat is
              the only composer) is now asserted against people.tsx rather
              than the deleted consoles.tsx. See components/people.tsx and
              test/board.test.mjs. */}
          {/* ⚠️ THE SESSIONS LIST IS NOT A RAIL SECTION ANY MORE. What has run
              on this machine is MY work — every file it reads comes out of
              this machine's own ~/.claude and ~/.codex — so it now hangs under
              my own row in People, in my hue, instead of sitting in a third
              list with claude's orange mark and no owner. Andrew: "all of
              these claude and codex sessions you ran are showing up in a
              different view. they should be blue under me."
              It also gives the People pane back the height this section was
              using; see components/people.tsx. */}
          <ConnBanner />
          <Strip />
          <UpdateRow />
          {/* ⚠️ NO "Repos" HEADER. It was a full pane-title row — 24px of
              padding and a word — sitting above a dropdown that already says
              what it is. Andrew: "get rid of the repo header and have the
              dropdown just start with open a repo". The rail's bottom corner
              is now three short rows (status, theme + gear, folder) instead
              of five, and the People list takes back what they were using. */}
          {/* No wrapper: WorkspacesPane renders its own `.ws #workspaces`, and
              this one duplicated both the class and the id.
              ⚠️ ABOVE the theme/gear row, not below it. Andrew: "swap the
              position of the repo selector block and the light/dark and
              settings one." The repo picker is something you reach for while
              working; theme and settings are set once and then left, so they
              belong in the corner under it. */}
          <WorkspacesPane />
          <div className="railfoot">
            <RailFoot />
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
      <Palette />
      <UpdateDialog />
      <VoiceDialog />
    </ConsoleRuntimeProvider>
  );
}

export default App;
