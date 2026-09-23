import type { ViewMode } from "./types";

export interface SurfacePatch {
  conversationOpen: boolean;
  selectedPath: string | null;
}

export function showConversation(): SurfacePatch;
export function showFile(selectedPath: string): SurfacePatch;
export function mainSurface(
  viewMode: ViewMode,
  selectedPath: string | null,
  conversationOpen: boolean,
): "conversation" | "detail";
export function repoToFollow(
  prevRoot: string | null | undefined,
  root: string | null | undefined,
  localRoot: string | null,
): string | null;
