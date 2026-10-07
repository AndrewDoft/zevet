/** The read-only model catalogue (Settings > Agents > Models): what this
 *  machine can run, who pays, whether it can run right now, indicative cost.
 *  Pure, so the suite runs the shipped copy. No resale: nothing here sells or
 *  meters a model, it only reads what the credential ladder already knows. */
import { CLAUDE_MODELS, CODEX_MODELS } from "./agent-models.generated.mjs";
import { OPENCODE_FREE_MODELS, OPENCODE_MODEL_NAMES } from "./models.generated.mjs";
import { priceOf } from "./model-prices.mjs";

/** engine -> which credential provider pays for it by key. */
const PROVIDER = { claude: "anthropic", codex: "openai" };
const LOGIN = { claude: "Claude login", codex: "ChatGPT login" };

/** USD per MTok as shown: "$4", "$0.10", "free", "—" when unknown. */
export function formatPrice(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n === 0) return "free";
  return "$" + (n >= 1 ? String(Math.round(n * 100) / 100) : n.toFixed(2));
}

/** "$4 / $20" (input / output per MTok), "—" when there is no verified price. */
export function formatPair(price) {
  return price ? `${formatPrice(price.input)} / ${formatPrice(price.output)}` : "—";
}

/** A run's cost: "$0.42", "<$0.01", "—". */
export function formatCost(usd) {
  if (typeof usd !== "number" || !isFinite(usd)) return "—";
  if (usd === 0) return "free";
  return usd < 0.01 ? "<$0.01" : "$" + usd.toFixed(2);
}

export function median(xs) {
  const v = xs.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Who can pay for an engine's model, in the order the ladder would try them. */
function payersFor(engine, agent, credentials, ladder) {
  const out = [];
  if (agent && agent.signedIn && LOGIN[engine]) out.push(LOGIN[engine]);
  const rung = (c) => (ladder || []).findIndex((s) => s.credentialId === c.id);
  for (const c of credentials || []) {
    if (c.provider !== PROVIDER[engine]) continue;
    const kind = c.kind === "subscription_token" ? "subscription" : "key";
    const who = c.scope === "team" ? `team ${kind}${c.addedBy ? " @" + c.addedBy : ""}` : `your ${kind}`;
    const r = rung(c);
    out.push(`${who} …${c.last4}${r >= 0 ? ` · rung ${r + 1}` : ""}`);
  }
  return out;
}

/** Median cost of recent runs on one model, from this board's consoles. */
function runMedian(consoles, id) {
  const base = String(id).replace(/-\d{8}$/, "");
  const costs = (consoles || [])
    .filter((c) => c && c.usage && c.usage.model && (c.usage.model === id || String(c.usage.model).replace(/-\d{8}$/, "") === base))
    .map((c) => c.usage.cost);
  return median(costs);
}

/**
 * @param {{ agents: Array<{name:string, ok:boolean, signedIn:boolean, models?:Array<{id:string,name:string}>}>,
 *           credentials?: Array<{id:string, scope:string, provider:string, kind:string, last4:string, addedBy?:string}>,
 *           ladder?: Array<{credentialId:string}>, consoles?: Array<{usage?:{model:string|null, cost:number|null}}> }} src
 * @returns {Array<{ id:string, name:string, engine:string, payers:string[], available:boolean, price:object|null, runMedian:number|null }>}
 */
export function buildCatalogue(src) {
  const agents = src.agents || [];
  const find = (n) => agents.find((a) => a.name === n);
  const rows = [];
  const keyed = (engine, list) => {
    const agent = find(engine);
    const payers = payersFor(engine, agent, src.credentials, src.ladder);
    for (const m of list) {
      rows.push({
        id: m.id,
        name: m.name,
        engine,
        payers,
        available: Boolean(agent && agent.ok && payers.length),
        price: priceOf(m.id),
        runMedian: runMedian(src.consoles, m.id),
      });
    }
  };
  keyed("claude", (find("claude") && find("claude").models) || CLAUDE_MODELS);
  keyed("codex", (find("codex") && find("codex").models) || CODEX_MODELS);
  const oc = find("opencode");
  for (const id of OPENCODE_FREE_MODELS) {
    rows.push({
      id,
      name: OPENCODE_MODEL_NAMES[id] || id,
      engine: "opencode",
      payers: ["free tier"],
      available: Boolean(oc && oc.ok),
      price: priceOf(id),
      runMedian: runMedian(src.consoles, id),
    });
  }
  return rows;
}
