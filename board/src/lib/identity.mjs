/** The board's half of linking accounts, as plain JavaScript so the tests run
 *  this exact file (same reason as connect.mjs).
 *
 *  Linking proves control of a SECOND identity the only way there is: that
 *  identity's own OAuth sign-in, run against the hub with the caller's session
 *  cookie and `link: true`. Nothing here ever sends an address the person typed
 *  as a claim — the hub gets the identity from GitHub/Google, not from us. */

const post = async (fetchImpl, route, body) => {
  const r = await fetchImpl(route, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const b = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body: b || {} };
};

const fail = (r, fallback) => ({ ok: false, error: (r.body && r.body.error) || fallback });

/**
 * Run one link attempt to its end.
 *
 * `onWaiting({ code?, url })` tells the window what to show (GitHub has a code,
 * Google does not); `open(url)` opens the provider's page; `cancelled()` is
 * polled between requests. Resolves `{ ok: true, login, merged }` or
 * `{ ok: false, error, cancelled? }` — never rejects.
 */
export async function linkAccount(provider, { fetchImpl, sleep, open, onWaiting, cancelled = () => false, now = () => Date.now() } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    if (provider === "github") {
      const s = await post(fetchImpl, "/auth/github/start", {});
      if (!s.ok || !s.body.deviceCode) return fail(s, "Could not start GitHub sign-in.");
      const url = s.body.verificationUriComplete || s.body.verificationUri;
      if (onWaiting) onWaiting({ code: s.body.userCode, url });
      if (open && url) open(url);
      let interval = Math.max(1, Number(s.body.interval) || 5) * 1000;
      const deadline = now() + (Number(s.body.expiresIn) || 900) * 1000;
      for (;;) {
        await wait(interval);
        if (cancelled()) return { ok: false, cancelled: true, error: "cancelled" };
        if (now() > deadline) return { ok: false, error: "That sign-in expired. Try again." };
        const f = await post(fetchImpl, "/auth/github/finish", { deviceCode: s.body.deviceCode, link: true });
        if (f.ok && f.body.pending) {
          if (f.body.slowDown) interval += 5000;
          continue;
        }
        if (f.ok && f.body.linked) return { ok: true, login: f.body.login, merged: Boolean(f.body.merged) };
        return fail(f, "Linking failed.");
      }
    }

    const s = await post(fetchImpl, "/auth/google/start", { link: true });
    if (!s.ok || !s.body.pairCode || !s.body.authUrl) return fail(s, "Could not start Google sign-in.");
    if (onWaiting) onWaiting({ url: s.body.authUrl });
    if (open) open(s.body.authUrl);
    const deadline = now() + (Number(s.body.expiresIn) || 600) * 1000;
    for (;;) {
      await wait(Math.max(1, Number(s.body.interval) || 2) * 1000);
      if (cancelled()) return { ok: false, cancelled: true, error: "cancelled" };
      if (now() > deadline) return { ok: false, error: "That sign-in expired. Try again." };
      const f = await post(fetchImpl, "/auth/google/finish", { pairCode: s.body.pairCode });
      if (f.ok && f.body.pending) continue;
      if (f.ok && f.body.linked) return { ok: true, login: f.body.login, merged: Boolean(f.body.merged) };
      return fail(f, "Linking failed.");
    }
  } catch {
    return { ok: false, error: "Could not connect." };
  }
}

export async function unlinkAccount(fetchImpl, { provider, login }) {
  try {
    const r = await post(fetchImpl, "/auth/unlink", { provider, login });
    return r.ok ? { ok: true } : fail(r, "Could not unlink that.");
  } catch {
    return { ok: false, error: "Could not connect." };
  }
}

/** Owner only (the hub checks). `from` is a person's login or a name that only
 *  appears on the board. */
export async function combinePeople(fetchImpl, { into, from }) {
  try {
    const r = await post(fetchImpl, "/auth/merge", { into, from });
    return r.ok ? { ok: true, merged: Boolean(r.body.merged) } : fail(r, "Could not combine them.");
  } catch {
    return { ok: false, error: "Could not connect." };
  }
}

/**
 * Pairs of people the hub cannot prove are one human, but the board can see are
 * worth the owner's look — for them to confirm, never fused on their behalf.
 *
 * Pure and side-effect-free: it does not read or write anything at the hub.
 * A pair is returned when ANY of these cheap, case-insensitive tests holds:
 *
 *  1. the logins are equal after a leading "@" is stripped — "@AndrewDoft"
 *     and "AndrewDoft";
 *  2. one login is a PREFIX of the other AND that prefix is at least 4 chars
 *     long — "andrew" and "AndrewDoft", but never "al" and "alice";
 *  3. a linked account is shared — both people carry an identity whose login is
 *     the same email (a Google identity's login IS its address).
 *
 * Each pair is returned as `[from, into]`: the one to combine FROM first (no
 * linked account, or the shorter name) and the one to combine INTO second (the
 * one with a linked account, or the longer name). Those map straight onto
 * `combinePeople`'s `{ into, from }`. A pair is returned once, in input order.
 */
export function likelySame(people) {
  const ns = (people || []).map(normalize).filter((n) => n.name);
  const out = [];
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      if (pairwise(ns[i], ns[j])) out.push(order(ns[i].p, ns[j].p));
    }
  }
  return out;
}

const normalize = (p) => {
  const login = p && p.login != null ? String(p.login) : "";
  const name = login.toLowerCase().replace(/^@/, "");
  const emails = ((p && p.identities) || []).map((i) => String(i.login || "").toLowerCase()).filter((e) => e.includes("@"));
  return { p, name, emails };
};

function pairwise(a, b) {
  if (!a.name || !b.name) return false;
  if (a.name === b.name) return true;
  const [short, long] = a.name.length <= b.name.length ? [a.name, b.name] : [b.name, a.name];
  if (short.length >= 4 && long.startsWith(short)) return true;
  const set = new Set(a.emails);
  return b.emails.some((e) => set.has(e));
}

function order(a, b) {
  const aId = (a.identities || []).length;
  const bId = (b.identities || []).length;
  const into = aId !== bId ? (aId > bId ? a : b) : String(b.login || "").length >= String(a.login || "").length ? b : a;
  return into === a ? [b, a] : [a, b];
}

/** Owner renames anyone (the hub checks); `login` is the person's stable key, not
 *  their display name. Yourself needs no owner — leave `login` off. */
export async function renamePerson(fetchImpl, { login, name }) {
  try {
    const r = await post(fetchImpl, "/auth/rename", { ...(login ? { login } : {}), name });
    return r.ok ? { ok: true } : fail(r, "Could not rename them.");
  } catch {
    return { ok: false, error: "Could not connect." };
  }
}

/** "GitHub · @octocat" / "Google · a@b.com" */
export function identityLabel(i) {
  return i.provider === "google" ? `Google · ${i.login}` : `GitHub · @${i.login}`;
}
