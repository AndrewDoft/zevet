/**
 * Zevet Chat's store: which mode is in front, the list of chats, and one
 * thread per opened chat. The desktop side (desktop/chat.js) owns the files
 * and the claude process; this owns what is on screen.
 *
 * Its own small store rather than more of board.ts: nothing in Code reads it,
 * and Code must stay exactly as it was when Chat is in front.
 */
import { create } from "zustand";
import { bridge, zStorage, type ChatSummary } from "./bridge";
import {
  chatEvent,
  emptyChatThread,
  failTurn,
  fromStored,
  sendUser,
  type ChatThread,
} from "./chat-stream.mjs";

export type Mode = "code" | "chat";
const MODE_KEY = "zevet.mode";

/** Chat needs a desktop build that has it (0.2.53+). */
export function chatAvailable(): boolean {
  const l = bridge.local;
  return Boolean(l && typeof l.chatSend === "function" && typeof l.onChatEvent === "function");
}

interface ChatState {
  mode: Mode;
  chats: ChatSummary[];
  query: string;
  activeId: string | null;
  threads: Record<string, ChatThread>;
  setMode: (m: Mode) => void;
  refresh: () => Promise<void>;
  setQuery: (q: string) => void;
  newChat: () => void;
  open: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => void;
}

export const useChat = create<ChatState>((set, get) => ({
  mode: zStorage.getItem(MODE_KEY) === "chat" && chatAvailable() ? "chat" : "code",
  chats: [],
  query: "",
  activeId: null,
  threads: {},

  setMode: (m) => {
    zStorage.setItem(MODE_KEY, m);
    set({ mode: m });
    document.body.dataset.mode = m;
    if (m === "chat") void get().refresh();
  },

  refresh: async () => {
    const l = bridge.local;
    if (!l?.chatList) return;
    const chats = await l.chatList(get().query);
    set({ chats: Array.isArray(chats) ? chats : [] });
  },

  setQuery: (q) => {
    set({ query: q });
    void get().refresh();
  },

  /* A new chat is only a blank thread until its first Send: an empty chat
     that was never written to must not litter the list. */
  newChat: () => set({ activeId: null }),

  open: async (id) => {
    set({ activeId: id });
    if (get().threads[id]) return;
    const c = await bridge.local?.chatGet?.(id);
    set((s) => ({ threads: { ...s.threads, [id]: c ? fromStored(c.messages) : emptyChatThread() } }));
  },

  rename: async (id, title) => {
    await bridge.local?.chatRename?.(id, title);
    await get().refresh();
  },

  remove: async (id) => {
    await bridge.local?.chatRemove?.(id);
    set((s) => {
      const threads = { ...s.threads };
      delete threads[id];
      return { threads, activeId: s.activeId === id ? null : s.activeId };
    });
    await get().refresh();
  },

  send: async (text) => {
    const l = bridge.local;
    if (!l?.chatSend || !l.chatCreate) return;
    let id = get().activeId;
    if (!id) {
      const c = await l.chatCreate();
      id = c.id;
      set((s) => ({ activeId: c.id, threads: { ...s.threads, [c.id]: emptyChatThread() } }));
    }
    const chatId = id;
    const put = (fn: (t: ChatThread) => ChatThread) =>
      set((s) => ({ threads: { ...s.threads, [chatId]: fn(s.threads[chatId] ?? emptyChatThread()) } }));
    put((t) => sendUser(t, text));
    const r = await l.chatSend(chatId, text);
    if (!r || !r.ok) put((t) => failTurn(t, (r && r.error) || "Could not send."));
    void get().refresh();
  },

  stop: () => {
    const id = get().activeId;
    if (id) void bridge.local?.chatStop?.(id);
  },
}));

let wired = false;
/** Once, at boot: desktop events into the threads they belong to. */
export function wireChat(): void {
  document.body.dataset.mode = useChat.getState().mode;
  const l = bridge.local;
  if (wired || !l?.onChatEvent || !chatAvailable()) return;
  wired = true;
  l.onChatEvent(({ id, evt }) => {
    if (evt.type === "saved") {
      void useChat.getState().refresh();
      return;
    }
    useChat.setState((s) =>
      s.threads[id] ? { threads: { ...s.threads, [id]: chatEvent(s.threads[id], evt) } } : {},
    );
  });
  if (useChat.getState().mode === "chat") void useChat.getState().refresh();
}
