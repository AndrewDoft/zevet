/** Shared author-aware tokens for every code-change surface. */
export const CHANGE_FALLBACKS = {
  added: { fg: "#15803d", bg: "rgba(34,197,94,.12)" },
  removed: { fg: "#b91c1c", bg: "rgba(239,68,68,.12)" },
};

export function authorChangeTokens(author, roster = [], kind = "added") {
  const index = roster.findIndex((entry) => entry && entry.actor === author);
  if (index < 0) {
    const fallback = CHANGE_FALLBACKS[kind === "removed" ? "removed" : "added"];
    return { "--change-fg": fallback.fg, "--change-bg": fallback.bg };
  }
  const hue = `var(--who-${index % 5})`;
  return {
    "--change-fg": hue,
    "--change-bg": kind === "removed"
      ? `color-mix(in srgb, ${hue} 18%, var(--paper))`
      : `color-mix(in srgb, ${hue} 14%, transparent)`,
  };
}

export function authorIdentityTokens(author, roster = []) {
  const index = roster.findIndex((entry) => entry && entry.actor === author);
  return { "--who": index < 0 ? "var(--who-0)" : `var(--who-${index % 5})` };
}
