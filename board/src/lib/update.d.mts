export interface UpdateStateLike {
  phase: string;
  version?: string;
  current?: string;
  percent?: number;
  canInstall?: boolean;
  manual?: boolean;
  notes?: string;
  error?: string;
}

export interface UpdatesLike {
  state: UpdateStateLike | null;
  revision: number;
  checking: boolean;
  installing: boolean;
  installError: string;
  notice: string;
}

export interface UpdateBridgeLike {
  updateStatus?: () => Promise<unknown>;
  updateCheck?: () => Promise<unknown>;
  updateInstall?: () => Promise<unknown>;
  onUpdate?: (cb: (s: unknown) => void) => void;
}

export interface UpdateControl {
  readonly updates: UpdatesLike;
  setBusy(patch: Partial<Pick<UpdatesLike, "checking" | "installing">>): void;
  receiveUpdate(next: UpdateStateLike): void;
  check(): void;
  install(): void;
  startUpdates(): void;
}

export type UpdateCommand =
  | { kind: "install" | "restart"; label: string; disabled: boolean }
  | { kind: "check"; label: string; disabled: boolean };

export function updatePercent(state: UpdateStateLike | null): number;
export function updateStatusText(state: UpdateStateLike | null, up: { checking: boolean; installing: boolean }): string;
export function updateCommand(
  state: UpdateStateLike | null,
  up: { checking: boolean; installing: boolean },
  opts: { hasCheck: boolean; hasInstall: boolean },
): UpdateCommand | null;
export function canInstallState(state: UpdateStateLike | null, hasInstall: () => boolean): boolean;
export const INSTALLER_OPENED: string;
export const NOT_ACCEPTED: string;
export const CHECK_FAILED: string;
export const INSTALL_FAILED: string;
export function createUpdateControl(
  bridge: () => UpdateBridgeLike | undefined,
  onChange: (u: UpdatesLike) => void,
): UpdateControl;