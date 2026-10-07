"use strict";
// Invite into one session, and join one (D-NEXT-W2-17). The hub runs the checks
// (hub/session-share.mjs); this side seals the session reference with the team
// document key, asks the hub, and answers the one question only this machine
// can: may I push to that repo? Never throws; always answers { ok, error? }.
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const agentSteer = require("./agent-steer.js");

const aadFor = (id, session) => `session-invite\u0000${id}\u0000${session}`;

const post = async (fetchImpl, hub, token, route, body) => {
  const res = await fetchImpl(`${String(hub).replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zevet-token": token },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  let out = {};
  try {
    out = await res.json();
  } catch {
    out = {};
  }
  return { status: res.status, out };
};

/** Seal and send one invite for `session`. `mode` is watch | comment | edit. */
async function sendInvite({ fetchImpl = fetch, hub, token, key, docCrypto = agentSteer.loadDocCrypto(), session, mode = "watch", repo = "" }) {
  if (!hub || !token) return { ok: false, error: "Sign in to your team first" };
  if (!key || !docCrypto) return { ok: false, error: "This machine has no team secret. Re-run setup" };
  if (!session) return { ok: false, error: "No session to invite into" };
  const id = randomUUID();
  let sealed;
  try {
    sealed = docCrypto.seal(key, aadFor(id, session), Buffer.from(JSON.stringify({ session, repo, mode }), "utf8")).toString("base64");
  } catch (err) {
    return { ok: false, error: `Could not seal the invite: ${err.message}` };
  }
  try {
    const { status, out } = await post(fetchImpl, hub, token, "/api/session-invite", { id, session, mode, sealed });
    return status === 200 && out.ok ? { ok: true, id, mode } : { ok: false, error: out.error || `The team server answered ${status}` };
  } catch (err) {
    return { ok: false, error: `Could not reach your team: ${err.message}` };
  }
}

/** Can this machine push to `dir`'s remote? `git push --dry-run` authenticates
 *  against the remote without sending anything. Any failure answers false. */
function probePush(dir, exec = execFile) {
  return new Promise((resolve) => {
    if (!dir) return resolve(false);
    exec("git", ["-C", dir, "push", "--dry-run", "origin", "HEAD"], { timeout: 20000, windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * Join by invite id. For `edit` the hub first says "push" (it cannot know);
 * only then is the repo probed here and the join retried with the answer.
 * `resolveRepo(name)` -> dir|null, `probe(dir)` -> Promise<boolean>.
 */
async function joinInvite({ fetchImpl = fetch, hub, token, key, docCrypto = agentSteer.loadDocCrypto(), id, mode, resolveRepo = () => null, probe = probePush }) {
  if (!hub || !token) return { ok: false, error: "Sign in to your team first" };
  if (!id) return { ok: false, error: "Paste an invite" };
  const ask = async (push) => {
    try {
      return await post(fetchImpl, hub, token, "/api/session-invite/join", { id, ...(mode ? { mode } : {}), ...(push === undefined ? {} : { push }) });
    } catch (err) {
      return { status: 0, out: { error: `Could not reach your team: ${err.message}` } };
    }
  };
  let r = await ask();
  if (r.status !== 200 && r.out.check === "push" && r.out.repo) {
    const dir = resolveRepo(r.out.repo);
    r = await ask(dir ? await probe(dir) : false);
  }
  if (r.status !== 200 || !r.out.ok) return { ok: false, check: r.out.check || "", error: r.out.error || `The team server answered ${r.status}` };
  const o = r.out;
  if (!key || !docCrypto) return { ok: false, error: "This machine has no team secret. Re-run setup" };
  try {
    docCrypto.open(key, aadFor(o.id, o.session), Buffer.from(String(o.sealed || ""), "base64"));
  } catch {
    return { ok: false, error: "The invite did not open here. Check you are on the same team" };
  }
  return { ok: true, mode: o.mode, readOnly: o.readOnly, session: o.session, repo: o.repo, agent: o.agent, actor: o.actor };
}

module.exports = { sendInvite, joinInvite, probePush, _internals: { aadFor } };
