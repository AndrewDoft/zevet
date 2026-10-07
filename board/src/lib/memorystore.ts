// Pinned notes for the folder on screen (D-NEXT-W2-10). The desktop seals,
// opens and flags them against the working tree; this only holds what it sends.
import { create } from "zustand";
import { bridge } from "./bridge";
import type { PinnedNote } from "./memory.mjs";

export const useMemory = create<{ notes: PinnedNote[]; root: string }>(() => ({ notes: [], root: "" }));

export async function refreshMemory(root: string): Promise<void> {
  const r = root ? await bridge.local?.memoryList?.({ root }) : null;
  useMemory.setState({ root, notes: r && r.ok ? (r.notes as PinnedNote[]) : [] });
}

let wired = false;
export function wireMemory(getRoot: () => string): void {
  const l = bridge.local;
  if (wired || !l || typeof l.onMemoryEvent !== "function") return;
  wired = true;
  l.onMemoryEvent(() => void refreshMemory(getRoot()));
}

const act = (fn: "memoryCreate" | "memoryEdit" | "memoryRetire", input: Record<string, unknown>) =>
  (bridge.local?.[fn] as undefined | ((i: Record<string, unknown>) => Promise<{ ok: boolean }>))?.(input);

export async function pinNote(root: string, path: string, text: string): Promise<void> {
  await act("memoryCreate", { root, path, text });
  await refreshMemory(root);
}
export async function editNote(root: string, id: string, text: string, rehash = false): Promise<void> {
  await act("memoryEdit", { root, id, text, rehash });
  await refreshMemory(root);
}
export async function retireNote(root: string, id: string): Promise<void> {
  await act("memoryRetire", { root, id });
  await refreshMemory(root);
}
