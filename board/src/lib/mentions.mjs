/** @-mentions in the composer: the picker's data, and reading the text back.
 *  Plain JavaScript so the gate runs this exact file.
 *
 *  A mention is stored IN the message text as assistant-ui's default directive,
 *  `:user[Kai]{name=kai}` or `:agent[Kai · Claude]{name=<agent key>}`
 *  (the regex below is the library's own), so an older client that does not
 *  know about mentions simply shows that text. What leaves for the agent is
 *  `plainMentions(text)`: `@Kai`. */

const DIRECTIVE = /:(user|agent)\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?/gu;

const AGENT_NAMES = { "claude-code": "Claude", claude: "Claude", codex: "Codex", opencode: "opencode" };
export const agentName = (a) => AGENT_NAMES[a] || a || "agent";

/** Directive syntax cannot carry `]`, `}` or a newline. */
const clean = (s) => String(s).replace(/[\]}\n]/g, " ").trim();

/** Picker categories from the live roster. Not me, not my own agents: you cannot steer yourself. */
export function mentionCategories({ roster, agents, myActor }) {
  const them = (a) => a && a !== myActor;
  const people = (roster || [])
    .filter((r) => them(r.actor))
    .map((r) => ({ id: clean(r.actor), type: "user", label: clean(r.actor), description: r.idle ? "idle" : "active" }));
  const seen = new Set();
  const bots = [];
  for (const a of agents || []) {
    if (!them(a.actor) || a.ended || seen.has(a.key)) continue;
    seen.add(a.key);
    bots.push({
      id: clean(a.key),
      type: "agent",
      label: clean(`${a.actor} · ${agentName(a.agent)}`),
      description: a.mission || a.repo || "",
    });
  }
  return [
    { id: "user", label: "Teammates", items: people },
    { id: "agent", label: "Agents", items: bots },
  ].filter((c) => c.items.length);
}

/** [{kind:"text",text} | {kind:"mention",type,label,id}] */
export function splitMentions(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(DIRECTIVE)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "mention", type: m[1], label: m[2], id: m[3] ?? m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** The `mentions: [{type,id}]` array that rides next to the text; one entry per target. */
export function mentionsOf(text) {
  const seen = new Set();
  return splitMentions(text)
    .filter((s) => s.kind === "mention")
    .map((s) => ({ type: s.type, id: s.id }))
    .filter((m) => !seen.has(m.type + "\0" + m.id) && seen.add(m.type + "\0" + m.id));
}

/** What the agent is told: `@Kai`, `@Kai · Claude`. */
export function plainMentions(text) {
  return splitMentions(text)
    .map((s) => (s.kind === "text" ? s.text : "@" + s.label))
    .join("");
}
