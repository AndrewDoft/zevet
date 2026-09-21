export interface SlashCommand {
  name: string;
  description: string;
  local: boolean;
}
export function commandsFor(agent: string | null | undefined, announced?: readonly string[]): SlashCommand[];
export function matchSlash(text: string, commands: readonly SlashCommand[]): SlashCommand[];
export function parseLocal(text: string, agent: string | null | undefined): string | null;
