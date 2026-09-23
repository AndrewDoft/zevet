/**
 * A prompt of mine, with a slash command shown as one.
 *
 * ⚠️ THE POINT IS CONFIRMATION, NOT DECORATION. Andrew: "highlight slash
 * commands in the user color (blue for me) and bold them. that way we can be
 * sure they are registered." So the styling is deliberately NOT applied to
 * anything that merely starts with a slash — it is applied only when the name
 * matches a command the agent in this thread actually offers, which is the
 * same list the `/` menu is built from (lib/slash.mjs § commandsFor, fed by
 * the console's own announced `slashCommands`). A `/deploy` that is not a real
 * command stays plain text, and that absence is the signal.
 *
 * The composer itself cannot do this — it is a `<textarea>`, and a textarea
 * has no way to style part of its value — so the confirmation lands on the
 * message once it is sent, which is also where it stays readable afterwards.
 *
 * A RECORDED session brings its own proof. Running `/model` in a terminal
 * writes `<command-name>/model</command-name>` — the command ran, that is what
 * the record IS — so those chip unconditionally, no list to check against.
 * What the command printed, and a `!` command with its output, are the same
 * envelope and are drawn here too: muted, collapsed, and never as markdown.
 * See lib/envelope.mjs for the shapes and where they were measured.
 */
import { type CSSProperties, useContext, useMemo } from "react";
import type { TextMessagePartComponent } from "@assistant-ui/react";
import { hueOf, selectActiveConsole, useBoard } from "@/lib/board";
import { readEnvelope } from "@/lib/envelope.mjs";
import { commandsFor, slashLead } from "@/lib/slash.mjs";
import { ChatSurface } from "@/lib/surface";
import { useChat } from "@/lib/chat";

/** What a local command printed. One muted line; the rest behind it. */
function LocalOut({ text, error }: { text: string; error: boolean }) {
  const lines = text.split("\n");
  const head = lines[0];
  if (lines.length === 1) {
    return (
      <div className="local-out" data-error={error || undefined}>
        {head}
      </div>
    );
  }
  return (
    <details className="local-out" data-error={error || undefined}>
      <summary>{head}</summary>
      <pre>{lines.slice(1).join("\n")}</pre>
    </details>
  );
}

export const UserText: TextMessagePartComponent = ({ text }) => {
  const isChat = useContext(ChatSurface);
  const active = useBoard(selectActiveConsole);
  const reading = useBoard((s) => s.sessions.open);
  const myActor = useBoard((s) => s.myActor);
  const chatSlash = useChat((s) => (s.activeId ? s.threads[s.activeId]?.slashCommands ?? null : null));
  /* A recorded session has no live console behind it, so there is nothing to
     have announced anything — but the file does say which CLI wrote it, and
     that is enough for the fallback list. Without this, reading back a
     transcript showed every claude command as plain text and the highlight
     looked broken rather than absent. Chat is always claude and takes the
     list from its own run's init line. */
  const agent = isChat ? "claude" : (active?.agent ?? reading?.source ?? null);
  const announced = isChat ? chatSlash ?? undefined : active?.slashCommands;
  const known = useMemo(() => commandsFor(agent, announced), [agent, announced]);
  const env = useMemo(() => readEnvelope(text), [text]);

  if (env) {
    /* Dropped upstream by transcript.mjs; handled here too, because the one
       thing worse than losing a message is reading our plumbing out loud. */
    if (env.kind === "noise") return null;
    if (env.kind === "out") return <LocalOut text={env.text} error={env.error} />;
    if (env.kind === "bash") return <code className="ran-said">{env.command}</code>;
    return (
      <>
        <span className="slash-said" style={{ "--who": hueOf(myActor) } as CSSProperties}>
          {env.name}
        </span>
        {env.args ? ` ${env.args}` : null}
      </>
    );
  }

  /* The rule lives in slash.mjs beside its siblings, and is tested there:
     a first token, and only a name this agent actually offers. */
  const lead = slashLead(text, known);
  if (!lead) return <>{text}</>;

  return (
    <>
      <span className="slash-said" style={{ "--who": hueOf(myActor) } as CSSProperties}>
        {"/" + lead.name}
      </span>
      {lead.rest}
    </>
  );
};
