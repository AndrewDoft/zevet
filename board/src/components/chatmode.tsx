/**
 * Zevet Chat + Work: the Code | Chat + Work switch, the team and its threads
 * in the rail, and the thread, which can also do work in a folder. Code's DOM stays mounted underneath and is only hidden (see
 * `body[data-mode="chat"]` in masora.css), so switching back finds the tree,
 * the editor and every console exactly where they were.
 */
import { type PropsWithChildren, useEffect, useMemo, useState } from "react";
import { SearchIcon, SquarePen, Trash2Icon } from "lucide-react";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { Thread } from "./assistant-ui/elements/thread.aui";
import { ToolUIs } from "./tools";
import { TurnToolGroup } from "./toolgroup";
import { PeoplePane } from "./people";
import { Twist } from "./twist";
import { AgentLogo } from "./brand";
import { teammateTurns } from "../lib/roster.mjs";
import { agoLabel } from "../lib/fmt";
import { hueOf, selectEvents, serverNow } from "../lib/board";
import type { ChatSummary } from "../lib/bridge";
import type { CSSProperties } from "react";
import { HUES } from "../lib/constants";
import { chatAvailable, useChat } from "../lib/chat";
import { emptyChatThread, visibleMessages } from "../lib/chat-stream.mjs";
import { useBoard } from "../lib/board";
import { parseLocal } from "../lib/slash.mjs";
import { MasoraVoiceDictationAdapter } from "../lib/voice";
import { ChatSurface } from "../lib/surface";

export function ModeSwitch() {
  const mode = useChat((s) => s.mode);
  const setMode = useChat((s) => s.setMode);
  if (!chatAvailable()) return null;
  return (
    <div className="pane-title modebar">
      <div className="modeseg" role="tablist" aria-label="Mode">
        {(["code", "chat"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            id={"mode-" + m}
            aria-selected={mode === m}
            onClick={() => setMode(m)}
          >
            {m === "code" ? "Code" : "Chat + Work"}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One thread, in the rail's own agent-row dress. Double-click renames. */
function ThreadRow({ chat, hue }: { chat: ChatSummary; hue: number }) {
  const { id, title } = chat;
  const activeId = useChat((s) => s.activeId);
  const viewing = useChat((s) => s.viewActor);
  const open = useChat((s) => s.open);
  const rename = useChat((s) => s.rename);
  const remove = useChat((s) => s.remove);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  if (editing) {
    return (
      <input
        className="chatrow-edit"
        autoFocus
        value={draft}
        aria-label="Title"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() && draft.trim() !== title) void rename(id, draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(title);
            setEditing(false);
          }
        }}
      />
    );
  }
  const sel = activeId === id && !viewing;
  return (
    <div className="agent-row-wrap">
      <div
        className="agent-row"
        data-active={String(sel)}
        data-thread={id}
        style={{ "--who": `var(--who-${((hue % HUES) + HUES) % HUES})` } as CSSProperties}
      >
        <button
          type="button"
          className="agent-row-pick"
          aria-current={sel ? "true" : undefined}
          onClick={() => void open(id)}
          onDoubleClick={() => {
            setDraft(title);
            setEditing(true);
          }}
          title={title || "Untitled"}
        >
          <span className="agent-row-gap" aria-hidden="true" />
          <span className="agent-row-name">{title || "Untitled"}</span>
          <span className="agent-row-ago">{agoLabel(chat.updated, serverNow())}</span>
        </button>
        <button type="button" className="agent-row-stop" aria-label="Delete" title="Delete" onClick={() => void remove(id)}>
          <Trash2Icon className="size-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** My threads, grouped the way Code groups agents: by the folder they work in.
 *  A thread with none is plain chat. */
function MyThreads({ hue }: { hue: number }) {
  const chats = useChat((s) => s.chats);
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const groups = new Map<string, ChatSummary[]>();
  for (const c of chats) {
    const key = c.folder ? c.folder.split(/[\\/]+/).filter(Boolean).pop() || c.folder : "Chats";
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return (
    <>
      {[...groups].map(([name, rows]) => (
        <div className="repo-group" key={name}>
          <button
            type="button"
            className="repo-group-head"
            aria-expanded={!shut[name]}
            onClick={() => setShut((o) => ({ ...o, [name]: !o[name] }))}
          >
            <Twist open={!shut[name]} />
            <span className="repo-group-name">{name}</span>
            <span className="repo-group-count">{rows.length}</span>
          </button>
          {shut[name] ? null : rows.map((c) => <ThreadRow key={c.id} chat={c} hue={hue} />)}
        </div>
      ))}
    </>
  );
}

/** The rail in Chat + Work: Code's own People pane (team, hues, invited rows),
 *  with my threads where Code hangs my agents. */
export function ChatRail() {
  const query = useChat((s) => s.query);
  const setQuery = useChat((s) => s.setQuery);
  const newChat = useChat((s) => s.newChat);
  const viewTeammate = useChat((s) => s.viewTeammate);
  return (
    <div className="chatrail">
      <div className="pane-title row">
        <span>Chats</span>
        <button type="button" className="rail-new" id="chatNew" aria-label="New chat" title="New chat" onClick={newChat}>
          <SquarePen className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <label className="chatsearch">
        <SearchIcon className="size-3.5" aria-hidden="true" />
        <input type="search" value={query} placeholder="Search" aria-label="Search chats" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="pane-body chatlist" id="chatPeople">
        <PeoplePane
          threads={(hue) => <MyThreads hue={hue} />}
          onPerson={(actor, me) => viewTeammate(me ? null : actor)}
        />
      </div>
    </div>
  );
}

/** A teammate's recent work, read-only: what they asked and what their agent
 *  did about it, from the same hub events Code's rail is built on. */
function TeammateThread({ actor }: { actor: string }) {
  const events = useBoard(selectEvents);
  const turns = teammateTurns(events, actor);
  return (
    <div className="chat-thread chat-thread-body tm-thread" data-teammate={actor} style={{ "--who": hueOf(actor) } as CSSProperties}>
      {turns.map((t, i) => (
        <div className="tm-turn" key={i}>
          {t.prompt ? <div className="tm-prompt">{t.prompt.detail}</div> : null}
          {t.tools.map((e, j) => (
            <div className="tm-tool" key={j}>
              <AgentLogo agent="claude" className="size-3" />
              <span>{e?.tool}</span>
              <span className="tm-target">{e?.target || e?.detail}</span>
            </div>
          ))}
          {t.ended ? <div className="tm-end">finished</div> : null}
        </div>
      ))}
    </div>
  );
}

function textOf(message: AppendMessage): string {
  const typed = message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
  const attached = (message.attachments ?? []).flatMap((a) =>
    (a.content ?? []).filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text),
  );
  return attached.length ? `${attached.join("\n\n")}\n\n${typed}`.trim() : typed;
}

function ChatRuntime({ children }: PropsWithChildren) {
  const thread = useChat((s) => (s.activeId ? s.threads[s.activeId] : undefined)) ?? EMPTY;
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const newChat = useChat((s) => s.newChat);
  const setModelSelectorOpen = useBoard((s) => s.setModelSelectorOpen);
  const setVoiceAsk = useBoard((s) => s.setVoiceAsk);
  const setVoiceHotkey = useBoard((s) => s.setVoiceHotkey);
  const dictation = useMemo(
    () => new MasoraVoiceDictationAdapter({ onMissing: (u) => setVoiceAsk(u), onSaid: (l) => setVoiceHotkey(l) }),
    [setVoiceAsk, setVoiceHotkey],
  );
  const messages = useMemo(() => visibleMessages(thread) as ThreadMessageLike[], [thread]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (m) => m,
    isRunning: thread.busy,
    onNew: async (message) => {
      const text = textOf(message);
      if (!text) return;
      /* LOCAL commands zevet answers itself, same rule as Code's runtime.
         /clear is claudeToo:false → parseLocal is null → sent; claude runs it
         and the conversation_reset line empties the thread (chat-stream). */
      const local = parseLocal(text, useBoard.getState().launchAgent || "claude");
      if (local === "stop") {
        stop();
        return;
      }
      if (local === "new") {
        newChat();
        return;
      }
      if (local === "model") {
        setModelSelectorOpen(true);
        return;
      }
      await send(text);
    },
    onCancel: async () => stop(),
    adapters: {
      attachments: new CompositeAttachmentAdapter([new SimpleTextAttachmentAdapter()]),
      dictation,
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToolUIs />
      {children}
    </AssistantRuntimeProvider>
  );
}
const EMPTY = emptyChatThread();
// Tool activity inline and compact, the way Code draws it.
const CHAT_COMPONENTS = { Welcome: () => null, ToolGroup: TurnToolGroup };

export function ChatMain() {
  const mode = useChat((s) => s.mode);
  const refresh = useChat((s) => s.refresh);
  const title = useChat((s) => s.chats.find((c) => c.id === s.activeId)?.title ?? "");
  const viewActor = useChat((s) => s.viewActor);
  useEffect(() => {
    if (mode === "chat") void refresh();
  }, [mode, refresh]);
  if (!chatAvailable()) return null;
  return (
    <main className="chatmain">
      <div className="pane-title chatmain-title">
        <span>{viewActor ? "@" + viewActor : title || "New chat"}</span>
      </div>
      {viewActor ? <TeammateThread actor={viewActor} /> : null}
      <ChatSurface.Provider value={true}>
        <ChatRuntime>
          <div className="chat-thread chat-thread-body" hidden={Boolean(viewActor)}>
            <Thread autoFocus={mode === "chat"} components={CHAT_COMPONENTS} />
          </div>
        </ChatRuntime>
      </ChatSurface.Provider>
    </main>
  );
}
