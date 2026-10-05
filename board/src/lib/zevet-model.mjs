/**
 * The "Zevet" pick: not a model but a router (desktop/zevet-router.js) that
 * answers each turn with the cheapest backend able to and falls to the next
 * when one is rate limited. Its picker id follows the `<agent>:<alias>` rule
 * of every other row, so choosing it starts an agent called "zevet".
 *
 * Kept out of the component so the suite can pin that it comes FIRST.
 */
export const ZEVET_MODEL = { id: "zevet:auto", name: "Zevet", keywords: ["zevet", "auto", "router", "cheapest"], verified: false };

/**
 * `models` with Zevet in front of every group. Offered only when some agent
 * here can run at all: with none, there is nothing for it to route to.
 *
 * @template T
 * @param {T[]} models
 * @param {Array<{ ok: boolean }>} agents
 * @returns {Array<T | typeof ZEVET_MODEL>}
 */
export function withZevet(models, agents) {
  return agents.some((a) => a.ok) ? [ZEVET_MODEL, ...models] : models;
}

/**
 * What the picker starts on: the last pick, unless it can no longer run
 * (limited, not installed, gone from the catalogue), and then Zevet, which
 * routes around exactly that. Andrew, 2026-09-30: the first verified row put a
 * free MiMo model in front of a fresh install. Without Zevet (Chat) it is the
 * first verified runnable row; with nothing verified, "" — the CLI's default.
 *
 * @param {Array<{ id: string, disabled?: boolean, verified?: boolean }>} all
 * @param {string} last  the stored alias (board.ts launchModel)
 * @param {(id: string) => string} aliasOf
 * @returns {string}
 */
export function defaultPick(all, last, aliasOf) {
  const match = all.find((m) => aliasOf(m.id) === last && !m.disabled);
  if (match) return match.id;
  if (all[0]?.id === ZEVET_MODEL.id) return ZEVET_MODEL.id;
  return all.find((m) => m.verified && !m.disabled)?.id ?? "";
}
