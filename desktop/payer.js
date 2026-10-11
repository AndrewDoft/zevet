"use strict";
// Who pays for a turn (D-073): engine + account, from what each engine's own CLI says about its
// login (cli-status.js: `claude auth status`, `codex login status`). Identity only, never a token:
// no credential file is opened here. Unknown is "" and the board shows nothing for it; nothing
// here guesses.
//
// A teammate's card gets the same label as ONE sealed frame per session with the
// document key (doc-crypto), exactly like a claim (claims.js): the hub relays a
// base64 blob and sees only the actor and session it sees on every event.

const ENGINE = { claude: "Claude", codex: "Codex", opencode: "OpenCode", zevet: "Zevet model" };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

/** claude: `email (Max)` from the CLI's own status (cli.claude). */
function claudeAccount({ cli }) {
  const v = cli && cli.claude;
  if (!v || v.loggedIn !== true) return "";
  const tier = v.method === "plan" ? cap(text(v.plan)) : "";
  const email = text(v.email);
  if (email) return tier ? `${email} (${tier})` : email;
  return tier;
}

/**
 * The route of the credential Claude Code will actually use. Order per
 * https://code.claude.com/docs/en/authentication#authentication-precedence (fetched 2026-10-09): cloud-provider flags,
 * ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, apiKeyHelper (a settings file, not read here), CLAUDE_CODE_OAUTH_TOKEN, then the
 * /login: whatever `claude auth status` (cli.claude) says it is, a plan or a key. No credential file is opened.
 * "" when it cannot be told, including cloud providers, which are neither a plan nor the user's own key.
 */
function claudeRoute({ env, cli }) {
  const on = (v) => text(v) && !/^(0|false)$/i.test(text(v));
  if (on(env.CLAUDE_CODE_USE_BEDROCK) || on(env.CLAUDE_CODE_USE_VERTEX) || on(env.CLAUDE_CODE_USE_FOUNDRY)) return "";
  if (text(env.ANTHROPIC_AUTH_TOKEN) || text(env.ANTHROPIC_API_KEY)) return "byok";
  if (text(env.CLAUDE_CODE_OAUTH_TOKEN)) return "plan";
  const v = cli && cli.claude;
  return v && v.loggedIn === true ? (v.method === "plan" ? "plan" : "byok") : "";
}

/** codex: a ChatGPT login is the plan, a stored key is the user's own (cli.codex). */
function codexRoute({ cli }) {
  const v = cli && cli.codex;
  return v && v.loggedIn === true ? (v.method === "plan" ? "plan" : "byok") : "";
}

/** codex: `ChatGPT` for a plan login, `API key` for a key login (cli.codex). */
function codexAccount({ cli }) {
  const v = cli && cli.codex;
  if (!v || v.loggedIn !== true) return "";
  return v.method === "plan" ? "ChatGPT" : "API key";
}

/** opencode: the account is the model's provider; a `:free` model costs nobody anything. */
function opencodeAccount(model) {
  const m = text(model);
  if (!m) return "";
  if (/(:|-)free$/.test(m)) return "free model";
  return m.includes("/") ? m.split("/")[0] : "";
}

/**
 * `{ engine, account, label }` for one agent. `credential` is the label of a
 * saved credential this machine launches claude with (it overrides the login);
 * `engine` "engine2"/"auto" is the second Max account, whose identity is not
 * readable here, so it is unknown.
 */
function payerFor(agent, { model = "", credential = "", engine = "", env = process.env, cli = {} } = {}) {
  const key = agent === "claude-code" ? "claude" : String(agent || "").toLowerCase();
  const name = ENGINE[key];
  if (!name) return { engine: "", account: "", label: "", route: "", payer: "" };
  let account = "";
  let route = "";
  if (key === "claude") route = engine === "engine2" || engine === "auto" ? "" : claudeRoute({ env, cli });
  else if (key === "codex") route = codexRoute({ cli });
  else if (key === "opencode") route = /(:|-)free$/.test(text(model)) ? "open" : "";
  if (key === "claude") account = credential ? text(credential) : engine === "engine2" || engine === "auto" ? "" : claudeAccount({ cli });
  else if (key === "codex") account = codexAccount({ cli });
  else if (key === "opencode") account = opencodeAccount(model);
  const label = key === "zevet" ? name : account ? `${name} · ${account}` : "";
  // payer is what Masora is told (`<route>:<provider>`); label is display only and never leaves the machine.
  return { engine: name, account, label, route, payer: route ? `${route}:${key}` : "" };
}

/** GCM additional data: a sealed payer opens only for the session it names. */
const aadFor = (session) => `payer\u0000${session}`;

function sealPayer(docCrypto, key, session, p) {
  const body = { label: p.label, account: p.account || "" };
  return docCrypto.seal(key, aadFor(session), Buffer.from(JSON.stringify(body), "utf8")).toString("base64");
}

/** What goes to the hub for one session: the sealed label, or a release. */
function payerBody(docCrypto, key, actor, session, p) {
  if (!p || !p.label) return { kind: "payer", actor, session, release: true };
  return { kind: "payer", actor, session, payer: sealPayer(docCrypto, key, session, p) };
}

/** The `{ actor, session, label, account }` a frame carries, or null. */
function openPayer(docCrypto, key, frame) {
  try {
    const session = String(frame.session || "");
    const body = JSON.parse(docCrypto.open(key, aadFor(session), Buffer.from(String(frame.payer || ""), "base64")).toString("utf8"));
    const label = text(body.label).slice(0, 120);
    if (!session || !label) return null;
    return { actor: String(frame.actor || ""), session, label, account: text(body.account).slice(0, 120) };
  } catch {
    return null;
  }
}

/** One frame from the hub's channel into `store` (Map actor\0session -> payer). True when it changed. */
function applyPayerFrame(store, name, data, { docCrypto, key, isMine = () => false }) {
  if (name === "hello") {
    const had = store.size > 0;
    store.clear();
    return had;
  }
  if ((name !== "payer" && name !== "payer-release") || !data || isMine(String(data.session || ""))) return false;
  const k = `${String(data.actor || "").toLowerCase()}\u0000${String(data.session || "")}`;
  if (name === "payer-release") return store.delete(k);
  const p = openPayer(docCrypto, key, data);
  if (p) store.set(k, p);
  return Boolean(p);
}

module.exports = { payerFor, payerBody, sealPayer, openPayer, applyPayerFrame, aadFor, claudeAccount, codexAccount, opencodeAccount };
