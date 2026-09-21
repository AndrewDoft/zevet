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
 */
import { type CSSProperties, useMemo } from "react";
import type { TextMessagePartComponent } from "@assistant-ui/react";
import { hueOf, selectActiveConsole, useBoard } from "@/lib/board";
import { commandsFor, slashLead } from "@/lib/slash.mjs";

export const UserText: TextMessagePartComponent = ({ text }) => {
  const active = useBoard(selectActiveConsole);
  const reading = useBoard((s) => s.sessions.open);
  const myActor = useBoard((s) => s.myActor);
  /* A recorded session has no live console behind it, so there is nothing to
     have announced anything — but the file does say which CLI wrote it, and
     that is enough for the fallback list. Without this, reading back a
     transcript showed every claude command as plain text and the highlight
     looked broken rather than absent. */
  const agent = active?.agent ?? reading?.source ?? null;
  const announced = active?.slashCommands;
  const known = useMemo(() => commandsFor(agent, announced), [agent, announced]);

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
