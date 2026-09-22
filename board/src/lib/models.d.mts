/** The model string a picker row stands for, recovered from its `<family>:<alias>` id. */
export function aliasOf(id: string): string;

/** How to show a model alias: what it is, where it comes from, and whether
 *  using it feeds a training set. */
export function describeModel(alias: string): { label: string; from: string; note: string; trains: boolean };

/** Names for models the desktop app read from the CLIs' caches just now;
 *  they win over the generated list. */
export function learnModels(list: ReadonlyArray<{ id: string; name: string; note: string }>): void;

/** The name of the model a console is on: the one it reports, else the one it
 *  was started with; "" when neither is known. */
export function runningModelName(reported: string | null | undefined, started: string | null | undefined): string;
