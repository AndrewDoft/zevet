/** A cadence id from desktop/schedule.js as a label, or the id if unknown. */
export function cadenceLabel(id: string): string;

/** A moment relative to now, in both directions: "in 12m" / "12m ago". */
export function whenText(ms: number, now?: number): string;
