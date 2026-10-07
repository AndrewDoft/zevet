"use strict";
// Who pays for a turn (D-073): engine + account, from what this machine already
// knows about each engine's login. Identity only, never a token: claude's
// subscription tier and email, codex's plan out of its id_token's CLAIMS (the
// JWT payload is read, the token is not kept or returned). Unknown is "" and
// the board shows nothing for it; nothing here guesses.
//
// A teammate's card gets the same label as ONE sealed frame per session with the
// document key (doc-crypto), exactly like a claim (claims.js): the hub relays a
// base64 blob and sees only the actor and session it sees on every event.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENGINE = { claude: "Claude", codex: "Codex", opencode: "OpenCode", zevet: "Zevet model" };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** claude: `email (Max)` from ~/.claude.json's oauthAccount and the credentials file's subscriptionType. */
function claudeAccount({ home, env }) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const tier = text(readJson(path.join(dir, ".credentials.json"))?.claudeAiOauth?.subscriptionType);
  const email = text((readJson(env.CLAUDE_CONFIG_DIR ? path.join(dir, ".claude.json") : path.join(home, ".claude.json")) || {}).oauthAccount?.emailAddress);
  if (email) return tier ? `${email} (${cap(tier)})` : email;
  return tier ? cap(tier) : "";
}

/** codex: `ChatGPT Plus` from auth.json's id_token claims, `API key` for a key login. */
function codexAccount({ home, env }) {
  const auth = readJson(path.join(env.CODEX_HOME || path.join(home, ".codex"), "auth.json"));
  if (!auth) return "";
  const idToken = text(auth.tokens?.id_token);
  if (idToken) {
    try {
      const claims = JSON.parse(Buffer.from(idToken.split(".")[1] || "", "base64url").toString("utf8"));
      const plan = text(claims["https://api.openai.com/auth"]?.chatgpt_plan_type);
      return plan ? `ChatGPT ${cap(plan)}` : "ChatGPT";
    } catch {
      return "";
    }
  }
  return text(auth.OPENAI_API_KEY) ? "API key" : "";
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
function payerFor(agent, { model = "", credential = "", engine = "", home = os.homedir(), env = process.env } = {}) {
  const key = agent === "claude-code" ? "claude" : String(agent || "").toLowerCase();
  const name = ENGINE[key];
  if (!name) return { engine: "", account: "", label: "" };
  let account = "";
  if (key === "claude") account = credential ? text(credential) : engine === "engine2" || engine === "auto" ? "" : claudeAccount({ home, env });
  else if (key === "codex") account = codexAccount({ home, env });
  else if (key === "opencode") account = opencodeAccount(model);
  const label = key === "zevet" ? name : account ? `${name} · ${account}` : "";
  return { engine: name, account, label };
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
