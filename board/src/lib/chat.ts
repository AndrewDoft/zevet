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

/** "chat" is the Chat + Work side of the switch. The id is what old prefs
 *  already hold, so a stored "chat" loads as Chat + Work with no migration. */
export type Mode = "code" | "chat";

/** The agents Chat + Work can run (desktop/chat-cli.js, chat-claude.js). */
export const CHAT_AGENTS = ["claude", "codex", "opencode"] as const;

/** Chat needs a desktop build that has it (0.2.53+). */
export function chatAvailable(): boolean {
  const l = bridge.local;
  return Boolean(
    l &&
      typeof l.chatSend === "function" &&
      typeof l.chatCreate === "function" &&
      typeof l.onChatEvent === "function",
  );
}

interface ChatState {
  mode: Mode;
  chats: ChatSummary[];
  query: string;
  activeId: string | null;
  threads: Record<string, ChatThread>;
  /** The folder a blank thread will be created with. */
  draftFolder: string;
  /** A teammate whose work is open, read-only, in place of a thread. */
  viewActor: string | null;
  setFolder: (dir: string) => Promise<void>;
  viewTeammate: (actor: string | null) => void;
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
  draftFolder: "",
  viewActor: null,

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
    set({ activeId: null, draftFolder: "", viewActor: null });
  },

  /* Attach a folder to the open thread (or to the blank one, which carries it
     into chatCreate). "" detaches: back to plain chat. */
  setFolder: async (dir) => {
    const id = get().activeId;
    if (!id) {
      set({ draftFolder: dir });
      return;
    }
    const r = await bridge.local?.chatSetFolder?.(id, dir);
    if (r) await get().refresh();
  },

  viewTeammate: (actor) => set({ viewActor: actor }),

  open: async (id) => {
    writeLastChat(zStorage, id);
    set({ activeId: id, viewActor: null });
    if (get().threads[id]) return;
    const c = await bridge.local?.chatGet?.(id);
    if (!c) {
      // Deleted elsewhere, or a hand-edited prefs file: back to a new chat.
      writeLastChat(zStorage, null);
      set((s) => (s.activeId === id ? { activeId: null } : {}));
      await get().refresh(); // drop the now-stale row from the rail
      return;
    }
    set((s) => ({ threads: { ...s.threads, [id]: fromStored(c.messages) } }));
  },

  rename: async (id, title) => {
    try {
      await bridge.local?.chatRename?.(id, title);
    } catch (err) {
      console.error("zevet: chat rename failed", err);
      return; // leave the row showing the old title, not a lie about the new one
    }
    await get().refresh();
  },

  remove: async (id) => {
    try {
      await bridge.local?.chatRemove?.(id);
    } catch (err) {
      console.error("zevet: chat remove failed", err);
      return; // leave the chat in place rather than hiding one that is still on disk
    }
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
    const { launchModel, launchAgent, launchEffort, launchMode } = useBoard.getState();
    // The picked agent runs the turn. One Chat can run is one the picker
    // offers; anything else (gemini, until desktop has it) is claude.
    const agent = (CHAT_AGENTS as readonly string[]).includes(launchAgent) ? launchAgent : "claude";
    let id = get().activeId;
    if (!id) {
      const c = await l.chatCreate(get().draftFolder || undefined);
      set({ draftFolder: "" });
      id = c.id;
      writeLastChat(zStorage, c.id);
      set((s) => ({ activeId: c.id, threads: { ...s.threads, [c.id]: emptyChatThread() } }));
    }
    const chatId = id;
    const put = (fn: (t: ChatThread) => ChatThread) =>
      set((s) => ({ threads: { ...s.threads, [chatId]: fn(s.threads[chatId] ?? emptyChatThread()) } }));
    put((t) => sendUser(t, text, launchModel, agent));
    const r = await l.chatSend(chatId, text, { agent, model: launchModel, effort: launchEffort, mode: launchMode });
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
         than reimplemented — see model-limits.mjs. The key is
         <agent>:<model>, the exact namespace ModelChoice reads for that
         agent's group; a run that hits a usage limit here grays the same
         picker row Code's would. */
      if (prev.model) {
        const last = next.transcript.messages[next.transcript.messages.length - 1] as
          | { status?: { type?: string; error?: string } }
          | undefined;
        noteModelLimit(zStorage, `${prev.agent}:${prev.model}`, last?.status, evt.payload);
      }
      return { threads: { ...s.threads, [id]: next } };
    });
  });
  const last = readLastChat(zStorage);
  if (last) void useChat.getState().open(last);
  if (useChat.getState().mode === "chat") void useChat.getState().refresh();
}
