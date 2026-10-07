export type PlanStep = { text: string; status: "pending" | "in_progress" | "completed" };
export type PlanProgress = { steps: PlanStep[]; done: number; total: number; current: string };
export function latestPlan(messages: unknown[]): PlanProgress | null;
export function planFromToolCall(toolName: unknown, args: unknown): PlanStep[] | null;
