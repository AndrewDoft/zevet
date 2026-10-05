export function pickerModel(agent: string, model: string | undefined, agents: { name: string; models?: { id: string }[] }[]): string | undefined;
export function answerBoardRequest(
  req: { reqId: string; kind: string; [k: string]: any },
  deps: {
    startAgent: (name: string, launch: any) => Promise<{ ok: boolean; id?: string; engine?: string; error?: string }>;
    sendPrompt: (key: number, text: string) => void;
    findConsole: (id: string) => { key: number; id: string | null; running: boolean } | undefined;
    agents: () => { name: string; models?: { id: string }[] }[];
  },
): Promise<{ ok: boolean; id?: string; engine?: string; error?: string; notFound?: boolean }>;
