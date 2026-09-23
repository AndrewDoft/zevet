/**
 * Code or Chat, and the chat that was open: what a relaunch comes back to.
 *
 * Kept in the "zevet.*" prefs, which prefs-mirror.mjs writes through to the
 * desktop app's ~/.zevet/prefs.json on EVERY set and hydrates back before the
 * board is imported — so a crash, a cleared localStorage or a new hub origin
 * all restore it. .mjs so `node --test` can drive a real restart of it.
 */
export const MODE_KEY = "zevet.mode";
export const LAST_CHAT_KEY = "zevet.chat.last";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Chat only where this desktop build has it; anything else is Code. */
export function readMode(storage, chatAvailable) {
  return chatAvailable && storage.getItem(MODE_KEY) === "chat" ? "chat" : "code";
}

export function writeMode(storage, mode) {
  storage.setItem(MODE_KEY, mode === "chat" ? "chat" : "code");
}

export function readLastChat(storage) {
  const v = storage.getItem(LAST_CHAT_KEY);
  return typeof v === "string" && UUID.test(v) ? v : null;
}

export function writeLastChat(storage, id) {
  if (id) storage.setItem(LAST_CHAT_KEY, id);
  else storage.removeItem(LAST_CHAT_KEY);
}
