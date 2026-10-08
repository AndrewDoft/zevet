/** Per-model list prices, USD per million tokens. The ONLY place prices live.
 *  Every entry carries the page it was read from and the date it was read; a
 *  model with no entry shows "—" in the catalogue, never a guess. `free: true`
 *  rows are $0 at the vendor, not unknown. Prices are list API prices: a
 *  subscription login pays no per-token price, so these are indicative only. */
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const OPENROUTER = "https://openrouter.ai/api/v1/models";
const ZEN = "https://opencode.ai/docs/zen/";
const ASOF = "2026-10-07";

const row = (id, input, output, source, extra) => ({ id, input, output, source, as_of: ASOF, ...extra });

/** Haiku 5.5 is priced by prompt size: `input`/`output` on the row are the <=100k tier; `over` replaces
 *  them, and the cache rates, for a prompt over `above` tokens. Cache write (5m, 1h) and read, per MTok.
 *  https://platform.claude.com/docs/en/models/haiku-5-5/overview, read 2026-10-08. */
const HAIKU_5_5 = {
  cacheWrite5m: 0.125,
  cacheWrite1h: 0.2,
  cacheRead: 0.01,
  over: { above: 100_000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
};

export const MODEL_PRICES = [
  row("claude-fable-5-1", 10, 50, ANTHROPIC),
  row("claude-opus-5-5", 4, 20, ANTHROPIC),
  row("claude-opus-5", 5, 25, ANTHROPIC),
  row("claude-sonnet-5", 2, 10, ANTHROPIC),
  // https://platform.claude.com/docs/en/models/sonnet-5-5/overview, read 2026-10-08. Flat price, no size tier.
  row("claude-sonnet-5-5", 2, 10, ANTHROPIC, { cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 }),
  row("claude-haiku-4-5-20251001", 1, 5, ANTHROPIC),
  row("claude-haiku-5-5", 0.1, 0.5, ANTHROPIC, HAIKU_5_5),
  row("gpt-6-astra", 10, 50, OPENAI),
  row("gpt-6-sol", 2, 10, OPENAI),
  row("gpt-6-luna", 0.1, 0.5, OPENAI),
  row("gpt-5.6-sol", 4, 20, OPENAI),
  row("gpt-5.6-terra", 2, 12, OPENAI),
  row("gpt-5.6-luna", 0.2, 1.2, OPENAI),
  row("gpt-5.5", 5, 30, OPENAI),
  row("opencode/nemotron-3-ultra-free", 0, 0, ZEN),
  row("openrouter/poolside/laguna-s-2.1:free", 0, 0, OPENROUTER),
  row("openrouter/thinkingmachines/inkling:free", 0, 0, OPENROUTER),
  row("openrouter/cohere/north-mini-code:free", 0, 0, OPENROUTER),
  row("openrouter/nvidia/nemotron-3-super-120b-a12b:free", 0, 0, OPENROUTER),
];

const BY_ID = new Map(MODEL_PRICES.map((p) => [p.id, p]));

/** The price entry for a model id, or null. A dated claude id (suffix -YYYYMMDD) matches its undated entry. */
export function priceOf(id) {
  const k = String(id || "");
  return BY_ID.get(k) || BY_ID.get(k.replace(/-\d{8}$/, "")) || null;
}
