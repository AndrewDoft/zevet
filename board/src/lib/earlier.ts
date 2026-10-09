import { create } from "zustand";

/** Messages the thread is not drawing (lib/window.mjs) and the way to draw more. */
export const useEarlier = create<{ hidden: number; more: () => void }>(() => ({ hidden: 0, more: () => {} }));
