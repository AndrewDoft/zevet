/** The model string a picker row stands for, recovered from its `<family>:<alias>` id. */
export function aliasOf(id: string): string;

/** How to show a model alias: what it is, where it comes from, and whether
 *  using it feeds a training set. */
export function describeModel(alias: string): { label: string; from: string; note: string; trains: boolean };
