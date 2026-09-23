/**
 * Zevet Chat: the Code | Chat switch, the chat list in the rail, and the
 * thread. Code's DOM stays mounted underneath and is only hidden (see
 * `body[data-mode="chat"]` in masora.css), so switching back finds the tree,
 * the editor and every console exactly where they were.
 */
import { type PropsWithChildren, useEffect, useMemo, useState } from "react";
import { PencilIcon, SearchIcon, SquarePen, Trash2Icon } from "lucide-react";
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
            {m === "code" ? "Code" : "Chat"}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatRow({ id, title }: { id: string; title: string }) {
  const activeId = useChat((s) => s.activeId);
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
  return (
    <div className="chatrow" data-sel={activeId === id}>
      <button type="button" className="chatrow-open" onClick={() => void open(id)} title={title || "Untitled"}>
        {title || "Untitled"}
      </button>
      <button type="button" className="chatrow-act" aria-label="Rename" title="Rename" onClick={() => { setDraft(title); setEditing(true); }}>
        <PencilIcon className="size-3.5" aria-hidden="true" />
      </button>
      <button type="button" className="chatrow-act" aria-label="Delete" title="Delete" onClick={() => void remove(id)}>
        <Trash2Icon className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export function ChatRail() {
  const chats = useChat((s) => s.chats);
  const query = useChat((s) => s.query);
  const setQuery = useChat((s) => s.setQuery);
  const newChat = useChat((s) => s.newChat);
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
      <div className="pane-body chatlist">
        {chats.map((c) => (
          <ChatRow key={c.id} id={c.id} title={c.title} />
        ))}
      </div>
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
      const local = parseLocal(text, "claude");
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
const CHAT_COMPONENTS = { Welcome: () => null };

export function ChatMain() {
  const mode = useChat((s) => s.mode);
  const refresh = useChat((s) => s.refresh);
  const title = useChat((s) => s.chats.find((c) => c.id === s.activeId)?.title ?? "");
  useEffect(() => {
    if (mode === "chat") void refresh();
  }, [mode, refresh]);
  if (!chatAvailable()) return null;
  return (
    <main className="chatmain">
      <div className="pane-title chatmain-title">
        <span>{title || "New chat"}</span>
      </div>
      <ChatSurface.Provider value={true}>
        <ChatRuntime>
          <div className="chat-thread chat-thread-body">
            <Thread autoFocus={mode === "chat"} components={CHAT_COMPONENTS} />
          </div>
        </ChatRuntime>
      </ChatSurface.Provider>
    </main>
  );
}
