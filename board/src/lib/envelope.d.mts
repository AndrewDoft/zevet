/** A message that is nothing but harness plumbing. See envelope.mjs. */
export type Envelope =
  /** A caveat, a system reminder, a task notification: never shown. */
  | { kind: "noise" }
  /** A slash command, as one chip: `/model` plus whatever followed it. */
  | { kind: "command"; name: string; args: string }
  /** A `!` bash command the person ran in the terminal. */
  | { kind: "bash"; command: string }
  /** What a local command printed, ANSI already stripped. */
  | { kind: "out"; text: string; error: boolean };

export function stripAnsi(text: string): string;
export function readEnvelope(text: string): Envelope | null;
