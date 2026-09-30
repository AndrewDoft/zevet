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
