/**
 * Team task board: cards for work no agent holds yet (D-089). A pill
 * bottom-left opens it. Viewer reads, Commenter comments, Editor does the rest;
 * controls a role may not use are not drawn, and the sync layer refuses them
 * anyway. "Start agent" hands a card to an agent through the ordinary paths.
 */
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useBoard } from "../lib/board";
import { sendSpawn, setSpawnTarget, canSpawn } from "../lib/steer";
import { useChat } from "../lib/team-chat-room";
import { closeTasks, doTask, ensureTasks, myRole, newId, useTasks } from "../lib/tasks-room";
import { STATUSES, handoff, may, type Card, type Status } from "../lib/tasks.mjs";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function CardView({ card, role, me }: { card: Card; role: ReturnType<typeof myRole>; me: string }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const edit = may(role, "edit");
  const talk = useChat().byCard[card.id] ?? 0;
  const startAgent = async () => {
    const h = handoff(card, role);
    if (!h.ok) return setNote(h.error);
    const st = useBoard.getState();
    if (card.owner && !same(card.owner, me) && canSpawn()) {
      const repo = card.link?.kind === "path" ? (card.link.ref.split("/")[0] ?? "") : "";
      setSpawnTarget({ actor: card.owner, repo, agent: "claude", model: "" });
      await sendSpawn(h.prompt); // the hub gates this route at Editor too
      return setNote("sent");
    }
    const r = await st.startAgent("claude", { background: true, root: st.localRoot ?? undefined, prompt: h.prompt, label: h.label } as never);
    setNote(r && r.ok ? "started" : (r && r.error) || "could not start");
  };
  return (
    <div className="tasks-card" data-status={card.status}>
      <div className="tasks-title">{card.title}</div>
      <div className="tasks-meta">
        {edit ? (
          <Select value={card.status} onValueChange={(v) => setNote(doTask({ op: "move", id: card.id, status: v as Status }))}>
            <SelectTrigger aria-label="Status" className="h-7 w-24 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
          </Select>
        ) : <span>{card.status}</span>}
        {edit ? (
          <input aria-label="Owner" placeholder="owner" defaultValue={card.owner} onBlur={(e) => e.target.value !== card.owner && setNote(doTask({ op: "assign", id: card.id, owner: e.target.value }))} />
        ) : <span>{card.owner || "unassigned"}</span>}
        {talk ? <span>chat: {talk}</span> : null}
        {card.link ? <span className="tasks-link">{card.link.kind}: {card.link.ref}</span> : null}
        {edit ? <button type="button" onClick={startAgent}>Start agent</button> : null}
        {edit ? <button type="button" onClick={() => setNote(doTask({ op: "remove", id: card.id }))}>Remove</button> : null}
      </div>
      {card.comments.map((m) => <div className="tasks-comment" key={m.id}><b>{m.by}</b> {m.text}</div>)}
      {may(role, "comment") ? (
        <input aria-label="Comment" placeholder="comment" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.key !== "Enter" || !text.trim()) return;
          setNote(doTask({ op: "comment", id: card.id, cid: newId(), text }));
          setText("");
        }} />
      ) : null}
      {note ? <div className="tasks-note">{note}</div> : null}
    </div>
  );
}

export function TasksPanel() {
  const [open, setOpen] = useState(false);
  const who = useBoard((s) => s.who.state);
  const { cards, error } = useTasks();
  const [title, setTitle] = useState("");
  useEffect(() => {
    ensureTasks();
  }, [who?.team, who?.login]);
  useEffect(() => () => closeTasks(), []);
  const role = myRole();
  if (!who?.team || !who.login || !role) return null;
  const me = who.login;
  const add = () => {
    if (!title.trim()) return;
    doTask({ op: "create", id: newId(), title, owner: me });
    setTitle("");
  };
  return (
    <div className="tasks-panel" data-open={open}>
      <button type="button" className="tasks-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Tasks{cards.length ? ` · ${cards.filter((c) => c.status !== "done").length}` : ""}
      </button>
      {open ? (
        <div className="tasks-body">
          {may(role, "create") ? (
            <input aria-label="New card" placeholder="new card" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          ) : null}
          {error ? <div className="tasks-note">{error}</div> : null}
          {STATUSES.map((s) => (
            <section key={s}>
              <h4>{s}</h4>
              {cards.filter((c) => c.status === s).map((c) => <CardView key={c.id} card={c} role={role} me={me} />)}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
