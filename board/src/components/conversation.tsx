/**
 * The conversation column.
 *
 * This used to be `<Consoles agentView />`: a list of flat `.cline` divs with a
 * bare textarea under them. It is the registry Thread now, reading the
 * structured transcript through the external-store runtime — so tool calls,
 * their results, reasoning and markdown each render as themselves.
 *
 * What is NOT delegated: choosing an agent to start. assistant-ui's "new
 * thread" is one button because it assumes one model; zevet has three CLIs,
 * four permission postures and a model per CLI, and that choice is the product.
 */
import { Thread } from "./assistant-ui/elements/thread.aui";
import { EmptyState, EmptyStateGreeting } from "./assistant-ui/elements/empty-state";
import { selectActiveConsole, selectMyConsoles, useBoard } from "../lib/board";
import { bridge } from "../lib/bridge";
import { Launcher } from "./launcher";
import { RunMeters } from "./runmeters";

function Blank({ title, note }: { title: string; note: string }) {
  return (
    <EmptyState className="mx-auto py-10">
      <EmptyStateGreeting>{title}</EmptyStateGreeting>
      <p className="text-muted-foreground -mt-4 text-center text-[13.5px]">{note}</p>
    </EmptyState>
  );
}

export function Conversation() {
  const local = Boolean(bridge.local);
  const consoles = useBoard(selectMyConsoles);
  const active = useBoard(selectActiveConsole);

  if (!local) {
    return (
      <Blank
        title="Nothing running here."
        note="Start an agent from the desktop app to watch it work."
      />
    );
  }

  // No console selected — either none has been started, or "new thread" was
  // pressed. Either way the next thing to do is pick an agent.
  if (!active) {
    return (
      <div className="chat-launch">
        {consoles.length ? null : (
          <Blank
            title="Nothing running yet."
            note="Pick an agent and a posture. It runs on this machine, in the open repo."
          />
        )}
        <Launcher />
      </div>
    );
  }

  return (
    <div className="chat-thread">
      <div className="chat-thread-body">
        <Thread autoFocus={false} />
      </div>
      {/* Under the transcript, in the column that has room for it. The rail's
          strip keeps the same numbers at a glance. */}
      <RunMeters />
    </div>
  );
}
