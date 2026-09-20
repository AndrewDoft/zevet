import { type CSSProperties, useEffect, useRef } from "react";
import { MODELS, MODES, MODE_LABEL } from "../lib/constants";
import {
  composingState,
  selectMyConsoles,
  useBoard,
} from "../lib/board";
import { bridge } from "../lib/bridge";
import type { ConsoleEntry, LaunchMode } from "../lib/types";
import { ModelSelectorContent, ModelSelectorRoot, ModelSelectorTrigger } from "./model-selector";
import { Prose } from "./prose";
import { TerminalBlock } from "./terminal-block";

function ChatEmpty({ local }: { local: boolean }) {
  return (
    <div className="chat-empty">
      <h2>Nothing running yet.</h2>
      <p>{local ? "Start an agent in the selected repo." : "Use the desktop app to start an agent."}</p>
    </div>
  );
}

function ConsoleComposer({ c }: { c: ConsoleEntry }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const sendPrompt = useBoard((s) => s.sendPrompt);
  const noteComposing = useBoard((s) => s.noteComposing);

  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.value = composingState(c.key).value;
    const fit = () => {
      textarea.style.height = "auto";
      const want = textarea.scrollHeight;
      textarea.style.height = Math.min(want, 220) + "px";
      textarea.style.overflowY = want > 220 ? "auto" : "hidden";
    };
    fit();
    const t = setTimeout(fit, 0);
    return () => clearTimeout(t);
  }, [c.key]);

  return (
    <form
      className="console-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        const textarea = ref.current;
        if (!textarea) return;
        const text = textarea.value.trim();
        if (!text) return;
        sendPrompt(c.key, text);
        textarea.value = "";
        const want = textarea.scrollHeight;
        textarea.style.height = Math.min(want, 220) + "px";
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        className="console-input"
        placeholder="Tell it what to do\u2026"
        aria-label={"Message " + c.agent}
        onInput={(ev) => {
          const textarea = ev.currentTarget;
          noteComposing(c.key, textarea.value);
          textarea.style.height = "auto";
          const want = textarea.scrollHeight;
          textarea.style.height = Math.min(want, 220) + "px";
          textarea.style.overflowY = want > 220 ? "auto" : "hidden";
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && !ev.shiftKey && !ev.nativeEvent.isComposing) {
            ev.preventDefault();
            ev.currentTarget.form?.requestSubmit();
          }
        }}
      />
    </form>
  );
}

function ConsoleCard({ c, agentView }: { c: ConsoleEntry; agentView?: boolean }) {
  const outRef = useRef<HTMLDivElement>(null);
  const closeConsole = useBoard((s) => s.closeConsole);
  const lines = c.lines.slice(-120);
  const texts = lines.map((l) => l.text);

  useEffect(() => {
    const o = outRef.current;
    if (o) o.scrollTop = o.scrollHeight;
  }, [lines.length]);

  return (
    <div className="console" style={{ "--who": "var(--who-" + c.hue + ")" } as CSSProperties}>
      <div className="console-head">
        <span className="bead" />
        <span className="nm">{c.agent}</span>
        <span className="posture" data-danger={String(c.mode === "dangerous")}>
          {(MODE_LABEL[c.mode] || c.mode) + (c.model ? "  \u00b7  " + c.model : "")}
        </span>
        <button className="console-stop" type="button" onClick={() => closeConsole(c.key)}>
          {c.running ? "Stop" : "Close"}
        </button>
      </div>
      {c.error ? <div className="console-err">{c.error}</div> : null}
      {agentView ? (
        <TerminalBlock
          command={c.agent + (c.model ? "  \u00b7  " + c.model : "")}
          lines={texts}
          visibleCount={texts.length}
          done={!c.running}
          className="mt-1 max-w-none"
        />
      ) : (
        <div className="console-out" ref={outRef}>
          {lines.map((l, i) => (
            <div className="cline" data-kind={l.kind} key={i}>
              {l.kind === "out" ? <Prose text={l.text} /> : l.text}
            </div>
          ))}
        </div>
      )}
      {c.running ? <ConsoleComposer c={c} /> : null}
    </div>
  );
}

function NewAgent() {
  const localRoot = useBoard((s) => s.localRoot);
  const localAgents = useBoard((s) => s.localAgents);
  const myConsolesCount = useBoard(selectMyConsoles).length;
  const launchMode = useBoard((s) => s.launchMode);
  const launchModel = useBoard((s) => s.launchModel);
  const setLaunchMode = useBoard((s) => s.setLaunchMode);
  const setLaunchModel = useBoard((s) => s.setLaunchModel);
  const startAgent = useBoard((s) => s.startAgent);

  if (!localRoot) return null;
  const usable = localAgents.filter((a) => a.ok);
  if (!usable.length) {
    return (
      <div className="newagent">
        <div className="newagent-none">{localAgents.length ? "No agents found" : "looking for agents\u2026"}</div>
      </div>
    );
  }

  const pool: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  usable.forEach((a) =>
    (MODELS[a.name] || []).forEach((v) => {
      if (!v || seen.has(v)) return;
      seen.add(v);
      pool.push({ id: v, name: v });
    }),
  );
  if (launchModel && !seen.has(launchModel)) {
    pool.push({ id: launchModel, name: launchModel });
  }

  return (
    <div className="newagent">
      <div className="launch-controls">
        <select
          className="launch-select"
          value={launchMode}
          onChange={(ev) => setLaunchMode(ev.target.value as LaunchMode)}
        >
          {MODES.map((m) => (
            <option value={m.id} key={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <ModelSelectorRoot
          models={pool}
          value={launchModel || undefined}
          onValueChange={(v) => setLaunchModel(v)}
        >
          <ModelSelectorTrigger variant="outline" size="default" />
          <ModelSelectorContent />
        </ModelSelectorRoot>
      </div>
      <div className="launch-row">
        {usable.map((a) => (
          <button
            className="newagent-btn"
            key={a.name}
            data-danger={String(launchMode === "dangerous")}
            title={a.detail + (a.signedIn ? "  (signed in)" : "  (no account found)")}
            onClick={() => startAgent(a.name)}
          >
            {(myConsolesCount ? "Another " : "Start ") + a.name}
            {!a.signedIn ? <span className="signin-dot" title={"no account found for " + a.name} /> : null}
          </button>
        ))}
      </div>
      {launchMode === "dangerous" ? <div className="launch-warn">Runs commands and edits files without asking.</div> : null}
    </div>
  );
}

export function Consoles({ agentView }: { agentView?: boolean }) {
  const myConsoles = useBoard(selectMyConsoles);
  const local = Boolean(bridge.local);

  if (!local || !bridge.local) {
    return agentView ? <ChatEmpty local={false} /> : null;
  }
  return (
    <>
      {myConsoles.map((c) => (
        <ConsoleCard c={c} key={c.key} agentView={agentView} />
      ))}
      <NewAgent />
      {agentView && !myConsoles.length ? <ChatEmpty local /> : null}
    </>
  );
}