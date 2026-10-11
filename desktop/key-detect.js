// API keys already on THIS machine that Zevet could use as BYOK. Electron-free so the suite drives
// it with a fake fs/env/fetch. A subscription is never read here: no OAuth block out of Claude's or
// Codex's credential files, nothing from Gemini CLI's login, and an `sk-ant-oat` value (an OAuth
// token wearing an API-key variable) is refused. A plan is used only through the vendor's own CLI
// (cli-status.js).
//
// Sources, in priority order: process env (ANTHROPIC/OPENAI/GEMINI/GOOGLE/OPENROUTER), opencode's
// auth.json entries of type "api", Codex's auth.json OPENAI_API_KEY ($CODEX_HOME honoured),
// ~/.gemini/.env and ~/.env (GEMINI_API_KEY; skipped for Vertex). Every file read is a regular file
// of at most 256 KB. A key is stored only after one GET to the provider's key/model list accepts it.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const MAX_BYTES = 256 * 1024;
const ENV = [
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["gemini", "GEMINI_API_KEY"],
  ["gemini", "GOOGLE_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
];
const OPENCODE = { openrouter: "openrouter", anthropic: "anthropic", openai: "openai", google: "gemini" };
const TRUTHY = /^(1|true|yes|on)$/i;

/** A regular file of at most MAX_BYTES, as text; anything else is null. */
function readSmall(f, p) {
  try {
    const st = f.statSync(p);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return f.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(f, p) {
  const text = readSmall(f, p);
  if (text == null) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** dotenv-style `[export ]NAME=value`, quotes stripped, `#` comments ignored. */
function parseDotenv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** A plain API key: one token, no OAuth bearer posing as a key. */
function usable(v) {
  if (typeof v !== "string") return "";
  const k = v.trim();
  if (!k || k.length > 512 || /[\s\u0000-\u001f]/.test(k) || k.startsWith("sk-ant-oat")) return "";
  return k;
}

/** Every {provider, from, key} this machine yields, in priority order. Internal: the key leaves only via adoptKeys. */
function candidates(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const f = opts.fs || fs;
  const out = [];
  const add = (provider, from, v) => {
    const key = usable(v);
    if (key) out.push({ provider, from, key });
  };
  let vertex = TRUTHY.test(String(env.GOOGLE_GENAI_USE_VERTEXAI || ""));

  for (const [provider, name] of ENV) add(provider, "env", env[name]);

  const xdg = env.XDG_DATA_HOME ? [path.join(env.XDG_DATA_HOME, "opencode", "auth.json")] : [];
  for (const p of [...xdg, path.join(home, ".local", "share", "opencode", "auth.json"), path.join(home, ".config", "opencode", "auth.json")]) {
    const j = readJson(f, p);
    if (!j) continue;
    for (const [id, entry] of Object.entries(j)) {
      if (OPENCODE[id] && entry && entry.type === "api") add(OPENCODE[id], "opencode", entry.key);
    }
  }

  const codex = readJson(f, path.join(env.CODEX_HOME || path.join(home, ".codex"), "auth.json"));
  if (codex) add("openai", "codex", codex.OPENAI_API_KEY);

  for (const p of [path.join(home, ".gemini", ".env"), path.join(home, ".env")]) {
    const text = readSmall(f, p);
    if (text == null) continue;
    const vars = parseDotenv(text);
    if (TRUTHY.test(vars.GOOGLE_GENAI_USE_VERTEXAI || "")) vertex = true;
    add("gemini", "gemini-env", vars.GEMINI_API_KEY);
  }
  return vertex ? out.filter((c) => c.provider !== "gemini") : out;
}

/** [{provider, from}], first source per provider. Presence only. */
function detectKeys(opts) {
  const seen = new Set();
  const found = [];
  for (const c of candidates(opts)) {
    if (seen.has(c.provider)) continue;
    seen.add(c.provider);
    found.push({ provider: c.provider, from: c.from });
  }
  return found;
}

const fingerprint = (provider, key) => crypto.createHash("sha256").update(`${provider} ${key}`).digest("hex").slice(0, 16);

function removedSet(opts) {
  const j = opts.removedPath ? readJson(opts.fs || fs, opts.removedPath) : null;
  return new Set(Array.isArray(j && j.removed) ? j.removed : []);
}

/** The person removed `provider`'s key: never auto-add what this machine holds for it again (a one-way fingerprint, never the key). */
function forgetKeys(provider, opts = {}) {
  if (!opts.removedPath) return false;
  const f = opts.fs || fs;
  const removed = removedSet(opts);
  for (const c of candidates(opts)) if (c.provider === provider) removed.add(fingerprint(c.provider, c.key));
  try {
    f.mkdirSync(path.dirname(opts.removedPath), { recursive: true });
    f.writeFileSync(opts.removedPath, JSON.stringify({ removed: [...removed] }));
    return true;
  } catch {
    return false;
  }
}

/** One GET that only a live key passes. "valid" | "invalid" (the provider said 401/403) | "unknown" (offline, timeout, 5xx). */
async function validateKey(provider, key, { fetch: http = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const probes = {
    anthropic: ["https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }],
    openai: ["https://api.openai.com/v1/models", { authorization: `Bearer ${key}` }],
    gemini: ["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { "x-goog-api-key": key }],
    openrouter: ["https://openrouter.ai/api/v1/key", { authorization: `Bearer ${key}` }],
  };
  const probe = probes[provider];
  if (!probe) return "unknown";
  try {
    const res = await http(probe[0], { headers: probe[1], signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return "valid";
    return res.status === 401 || res.status === 403 ? "invalid" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Validate and store every detected key not yet held. `list()` is the stored credentials' metadata
 * ({provider, kind, last4}), `add({provider, key, from})` stores one. Returns [{provider, from, state}]:
 * stored | exists | removed | invalid | unknown. Only "valid" is stored; "unknown" is retried next run.
 */
async function adoptKeys({ list, add, ...opts }) {
  const removed = removedSet(opts);
  const held = list();
  const seen = new Set();
  const result = [];
  for (const c of candidates(opts)) {
    if (seen.has(c.provider)) continue;
    seen.add(c.provider);
    const row = { provider: c.provider, from: c.from };
    if (removed.has(fingerprint(c.provider, c.key))) result.push({ ...row, state: "removed" });
    else if (held.some((h) => h.provider === c.provider && h.kind === "api_key" && h.last4 === c.key.slice(-4))) result.push({ ...row, state: "exists" });
    else {
      const state = await validateKey(c.provider, c.key, opts);
      if (state === "valid") add({ provider: c.provider, key: c.key, from: c.from });
      result.push({ ...row, state: state === "valid" ? "stored" : state });
    }
  }
  return result;
}

module.exports = { detectKeys, forgetKeys, validateKey, adoptKeys, parseDotenv, MAX_BYTES };
