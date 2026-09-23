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
import { readLastChat, readMode, writeLastChat, writeMode } from "./mode.mjs";
import { noteModelLimit } from "./model-limits.mjs";
import { useBoard } from "./board";
import type { LaunchMode } from "./types";

export type Mode = "code" | "chat";

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
  mode: readMode(zStorage, chatAvailable()),
  chats: [],
  query: "",
  activeId: null,
  threads: {},

  setMode: (m) => {
    writeMode(zStorage, m);
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
  newChat: () => {
    writeLastChat(zStorage, null);
    set({ activeId: null });
  },

  open: async (id) => {
    writeLastChat(zStorage, id);
    set({ activeId: id });
    if (get().threads[id]) return;
    const c = await bridge.local?.chatGet?.(id);
    if (!c) {
      // Deleted elsewhere, or a hand-edited prefs file: back to a new chat.
      writeLastChat(zStorage, null);
      set((s) => (s.activeId === id ? { activeId: null } : {}));
      return;
    }
    set((s) => ({ threads: { ...s.threads, [id]: fromStored(c.messages) } }));
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
    if (readLastChat(zStorage) === id) writeLastChat(zStorage, null);
    await get().refresh();
  },

  send: async (text) => {
    const l = bridge.local;
    if (!l?.chatSend || !l.chatCreate) return;
    const { launchModel: picked, launchAgent, launchEffort, launchMode } = useBoard.getState();
    // Chat runs the Claude CLI only: a Code pick of an opencode/codex model is
    // not a model claude can take, so Chat falls back to claude's default.
    const launchModel = !launchAgent || launchAgent === "claude" ? picked : "";
    let id = get().activeId;
    if (!id) {
      const c = await l.chatCreate();
      id = c.id;
      writeLastChat(zStorage, c.id);
      set((s) => ({ activeId: c.id, threads: { ...s.threads, [c.id]: emptyChatThread() } }));
    }
    const chatId = id;
    const put = (fn: (t: ChatThread) => ChatThread) =>
      set((s) => ({ threads: { ...s.threads, [chatId]: fn(s.threads[chatId] ?? emptyChatThread()) } }));
    put((t) => sendUser(t, text, launchModel));
    const r = await l.chatSend(chatId, text, { model: launchModel, effort: launchEffort, mode: launchMode });
    if (!r || !r.ok) put((t) => failTurn(t, (r && r.error) || "Could not send."));
    void get().refresh();
  },

  stop: () => {
    const id = get().activeId;
    if (id) void bridge.local?.chatStop?.(id);
  },
}));

/* BEFORE FIRST PAINT. This module is imported by App, which main.tsx imports
   only after the prefs mirror has hydrated and before it renders anything, so
   the body already says which mode it is when the first frame is drawn: a
   relaunch into Chat never flashes Code. */
document.body.dataset.mode = useChat.getState().mode;

let wired = false;
/** Once, at boot: desktop events into the threads they belong to, and the
 *  chat that was open when the app closed. */
export function wireChat(): void {
  const l = bridge.local;
  if (wired || !l?.onChatEvent || !chatAvailable()) return;
  wired = true;
  l.onChatEvent(({ id, evt }) => {
    if (evt.type === "saved") {
      void useChat.getState().refresh();
      return;
    }
    useChat.setState((s) => {
      const prev = s.threads[id];
      if (!prev) return {};
      const next = chatEvent(prev, evt);
      /* Same bookkeeping as board.ts's noteModelLimit (Code), reused rather
         than reimplemented — see model-limits.mjs. Chat is claude-only
         (desktop/chat.js), so the key is always claude:<model>, the exact
         namespace ModelChoice already reads for claude's group; a run that
         hits a usage limit here grays the same picker row Code's would. */
      if (prev.model) {
        const last = next.transcript.messages[next.transcript.messages.length - 1] as
          | { status?: { type?: string; error?: string } }
          | undefined;
        noteModelLimit(zStorage, `claude:${prev.model}`, last?.status, evt.payload);
      }
      return { threads: { ...s.threads, [id]: next } };
    });
  });
  const last = readLastChat(zStorage);
  if (last) void useChat.getState().open(last);
  if (useChat.getState().mode === "chat") void useChat.getState().refresh();
}
