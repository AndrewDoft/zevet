// Secret redaction, on the machine that typed the secret, BEFORE anything is
// built into an event or sealed for the relay.
//
// ⚠️ WHY THIS IS CLIENT-SIDE. The hub cannot redact what it cannot read, and the
// sealed traffic (steers, claims, documents) is exactly that. A hub-side scrub
// would only ever cover the plaintext half, and would have taught everyone that
// "the hub scrubs it" is a property of the whole product. So the net is here,
// where the plaintext still is, and what leaves the machine is already clean.
//
// A net, not a guarantee: a secret that looks like an English sentence goes
// through, and no regex fixes that. `ZEVET_DETAIL=brief` drops text entirely.
//
// Each rule names what it caught, so a reader of the board can tell a redacted
// GitHub token from a redacted .env line: `[redacted:github-token]`.
//
// ⚠️ NO "LONG HEX BLOB" RULE. The old net replaced any 40+ hex run, which blanked
// every git sha and sha-256 on the board while catching almost no real secret
// (real keys carry a prefix, and the prefixes are rules here). A sha in a
// command is the product working, not a leak.
//
// client/opencode-plugin.mjs is one self-contained file and cannot import this;
// it carries a copy of the block between the markers below, and
// test/redact.test.mjs fails if the two drift.

// <redact-rules>
const RULES = [
  ["pem-private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["openrouter-key", /\bsk-or-[A-Za-z0-9_-]{16,}/g],
  ["openai-key", /\bsk-(?!ant-|or-)[A-Za-z0-9_-]{16,}/g],
  ["stripe-key", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["xai-key", /\bxai-[A-Za-z0-9]{16,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["jwt", /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi],
  // NAME=value, whole line, when the NAME says it holds a secret. The value is
  // anything: .env files are where unshaped secrets live.
  ["env-secret", /^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Z0-9_]*[ \t]*=)[ \t]*\S.*$/gm],
  ["credential-assignment", /\b(?:token|api[-_]?key|secret|password|passwd|pwd)\b[\s"':=]+\S+/gi],
];

/** Replace every secret-shaped run in `text` with `[redacted:<kind>]`. */
function redact(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [name, re] of RULES) {
    out = out.replace(re, (m, keep) => (name === "env-secret" ? `${keep}[redacted:${name}]` : name === "bearer-token" ? `Bearer [redacted:${name}]` : `[redacted:${name}]`));
  }
  return out;
}
// </redact-rules>

export { RULES, redact };

/** The names of the rules whose pattern matches `text`: what a test needs to
 *  show a fixture is reachable through one rule and no other. */
export function matchedRules(text) {
  return RULES.filter(([, re]) => new RegExp(re.source, re.flags).test(text)).map(([name]) => name);
}

/** `redact` over every string inside a JSON-shaped value (plan steps, say),
 *  leaving the shape alone — redacting the serialised text could eat the
 *  closing quote of a line-anchored match and break the JSON. */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}
