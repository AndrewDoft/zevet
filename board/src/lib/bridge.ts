import type { LocalWorkspace, LocalEntry, UsableAgent, ColorThemeSpec } from "./types";

export interface ReadResult {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  bytes?: number;
  bom?: boolean;
  eol?: string;
  error?: string;
}

export interface StartAgentResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface StatsResult {
  ok: boolean;
  lines?: Record<string, number | undefined>;
  diff?: Record<string, { status: string } | undefined>;
  error?: string;
}

export interface StatusResult {
  ok: boolean;
  repo?: { branch?: string; sha?: string; ahead?: number | null; behind?: number | null };
  cindex?: unknown;
  [key: string]: unknown;
}

export interface LocalBridge {
  available: boolean;
  read: (root: string, relPath: string) => Promise<ReadResult>;
  write: (root: string, relPath: string, text: string, opts: { bom?: boolean; eol?: string }) => Promise<{ ok: boolean; error?: string }>;
  agents: () => Promise<UsableAgent[]>;
  startAgent: (name: string, root: string, opts: { model: string; mode: string }) => Promise<StartAgentResult>;
  sendToAgent: (id: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  stopAgent: (id: string) => Promise<unknown>;
  watch: (root: string, relPath: string, lastWritten: string | null) => Promise<{ ok: boolean }>;
  unwatch: (root: string, relPath: string) => Promise<unknown>;
  diffHunks?: (root: string, rel: string) => Promise<{ ok: boolean; hunks?: Array<{ start?: number }> }>;
  onFileChanged: (cb: (p: { root: string; relPath: string; text?: string; bom?: boolean; eol?: string }) => void) => () => void;
  onAgentEvent: (cb: (evt: { id?: string; type: string; code?: number | null; signal?: string | null; text?: string; payload?: unknown }) => void) => () => void;
  stats: (root: string, paths: string[]) => Promise<StatsResult>;
  status: (root: string | null) => Promise<StatusResult>;
  chrome: (spec: ColorThemeSpec) => void;
  addWorkspace: () => Promise<LocalWorkspace | null>;
  indexStatus: (root: string | null) => Promise<{ ok: boolean } & Record<string, unknown>>;
  indexEnable?: (root: string | null) => Promise<{ ok?: boolean; indexed?: number; skipped?: number; error?: string } | null | undefined>;
  updateCheck: () => Promise<unknown>;
  updateStatus: () => Promise<unknown>;
  updateInstall: () => Promise<{ ok?: boolean; manual?: boolean; error?: string }>;
  onUpdate: (cb: (s: unknown) => void) => void;
  onIndexEvent: (cb: (p: { kind?: string; total?: number; loaded?: number; indexed?: number }) => void) => void;
  workspaces: () => Promise<LocalWorkspace[]>;
  tree: (dir: string) => Promise<{ ok: boolean; entries?: LocalEntry[]; truncated?: boolean; error?: string }>;
}

export interface ZevetConfig {
  hub?: string;
  actor?: string;
  session?: boolean;
  hasSecret?: boolean;
  legacy?: boolean;
}

export interface ZevetBridge {
  config: () => Promise<ZevetConfig | null | undefined>;
  githubStart: (hub?: string) => Promise<{ ok?: boolean; error?: string; userCode?: string }>;
  githubWait: () => Promise<{ ok?: boolean; cancelled?: boolean; error?: string; login?: string }>;
  githubCancel: () => void;
  githubLogout?: () => Promise<{ ok?: boolean; error?: string } | null | undefined>;
}

declare global {
  interface Window {
    zevetLocal?: Partial<LocalBridge>;
    zevetDoc?: { available?: boolean } & Record<string, unknown>;
    zevetEditor?: Record<string, unknown>;
    zevetHighlight?: { highlight?: (t: string, l: string) => string; languageFor?: (p: string) => string };
    zevetSprites?: { spriteFor?: (o: { tool?: string | null; width: number; height: number }) => string };
    zevet?: Partial<ZevetBridge>;
    __zevetCfg?: ZevetConfig;
    __zevetHub?: string;
  }
}

export const bridge = {
  get local(): LocalBridge | undefined {
    const l = window.zevetLocal;
    return l && l.available ? (l as LocalBridge) : undefined;
  },
  get zevet(): ZevetBridge | undefined {
    return window.zevet as ZevetBridge | undefined;
  },
  get canWrite(): boolean {
    return Boolean(window.zevetLocal && typeof window.zevetLocal.write === "function");
  },
  get canShare(): boolean {
    return Boolean(
      window.zevetDoc && window.zevetDoc.available &&
      window.zevetEditor,
    );
  },
  get cfg(): ZevetConfig | undefined {
    return window.__zevetCfg;
  },
  get hub(): string {
    return window.__zevetHub || location.origin;
  },
};