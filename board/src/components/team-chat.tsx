/**
 * Team chat (D-NEXT-W2-15B): a pill next to Tasks opens the team's sealed chat
 * room. Viewer reads; Commenter and above post (the composer is not drawn for a
 * Viewer, and the sync layer and hub refuse anyway). Message text is rendered as
 * React text nodes, never HTML. A message may name a task card.
 */
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useBoard } from "../lib/board";
import { closeChat, ensureChat, markRead, postChat, useChat } from "../lib/team-chat-room";
import { myRole, useTasks } from "../lib/tasks-room";
import { LIMITS, may } from "../lib/team-chat.mjs";

const NO_CARD = "none";

export function TeamChatPanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [cardId, setCardId] = useState(NO_CARD);
  const [replyTo, setReplyTo] = useState("");
  const who = useBoard((s) => s.who.state);
  const { messages, unread, error } = useChat();
  const { cards } = useTasks();
  useEffect(() => {
    ensureChat();
  }, [who?.team, who?.login]);
  useEffect(() => () => closeChat(), []);
  useEffect(() => {
    if (open && unread) markRead();
  }, [open, unread, messages.length]);
  const role = myRole();
  if (!who?.team || !who.login || !role) return null;
  const title = (id?: string) => cards.find((c) => c.id === id)?.title;
  const byId = new Map(messages.map((m) => [m.id, m]));
  const send = () => {
    if (!text.trim()) return;
    const err = postChat(text, { ...(cardId !== NO_CARD ? { cardId } : {}), ...(replyTo ? { replyTo } : {}) });
    if (err) return;
    setText("");
    setReplyTo("");
  };
  return (
    <div className="tasks-panel chat-panel" data-open={open}>
      <button type="button" className="tasks-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Chat{unread ? ` · ${unread}` : ""}
      </button>
      {open ? (
        <div className="tasks-body">
          {messages.map((m) => {
            const parent = m.replyTo ? byId.get(m.replyTo) : undefined;
            return (
              <div className="tasks-card chat-msg" key={m.id}>
                {parent ? <div className="tasks-comment">re {parent.by}: {parent.text.slice(0, 80)}</div> : null}
                <div><b>{m.by}</b> {m.text}</div>
                <div className="tasks-meta">
                  {m.cardId ? <span className="tasks-link">{title(m.cardId) ?? "card"}</span> : null}
                  {may(role, "post") ? <button type="button" onClick={() => setReplyTo(m.id)}>Reply</button> : null}
                </div>
              </div>
            );
          })}
          {error ? <div className="tasks-note">{error}</div> : null}
          {may(role, "post") ? (
            <>
              {replyTo ? <div className="tasks-note">re {byId.get(replyTo)?.by} <button type="button" onClick={() => setReplyTo("")}>Clear</button></div> : null}
              <Select value={cardId} onValueChange={(v) => setCardId(v ?? NO_CARD)}>
                <SelectTrigger aria-label="Card" className="h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CARD}>no card</SelectItem>
                  {cards.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
                </SelectContent>
              </Select>
              <input aria-label="Message" placeholder="message" maxLength={LIMITS.text} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
