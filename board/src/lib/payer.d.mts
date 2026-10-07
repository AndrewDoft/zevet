export type Payer = { actor: string; session: string; label: string; account: string };
export function payerOfSession(payers: readonly Payer[], actor: string, session: string): string;
export function payerOfActor(payers: readonly Payer[], actor: string, agent: string): string;
export function billsLine(who: string, label: string): string;
