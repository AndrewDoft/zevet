export const CHECK_MS: number;
export const IDLE_MS: number;
export function holdsWork(doc: Pick<Document, "querySelector" | "querySelectorAll">, editorDirty: boolean): boolean;
export function createStaleReload(deps: {
  mine: string;
  fetchBuild: () => Promise<string>;
  doc: Pick<Document, "querySelector" | "querySelectorAll" | "hidden">;
  now: () => number;
  editorDirty: () => boolean;
  reload: () => void;
}): { touch(): void; tick(): Promise<void> };
