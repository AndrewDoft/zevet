import type { ComponentType } from "react";
export const SLOTS: readonly ["rail", "overlay"];
export interface ExtEntry {
  id: string;
  slot: "rail" | "overlay";
  order: number;
  Component: ComponentType;
}
export function collectExt(modules: Record<string, unknown>): ExtEntry[];
