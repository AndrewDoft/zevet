import type { ThreadMessageLike } from "@assistant-ui/react";

export function groupTurnTools(
  messages: readonly ThreadMessageLike[],
  opts?: { min?: number },
): readonly ThreadMessageLike[];
export function turnToolCount(message: ThreadMessageLike | null | undefined): number;
