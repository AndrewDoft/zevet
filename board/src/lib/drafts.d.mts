export function draftChange(
  prev: { key: string; text: string } | null,
  key: string | null,
  text: string,
): "save" | "forget" | null;
