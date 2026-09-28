// Sends the team-invite email through Resend's HTTP API directly — no SDK.
// See docs/resend.md for the exact request/response shape and the date it was
// verified against Resend's own docs.
//
// ⚠️ NEVER THROWS. The caller (hub/server.mjs's /auth/allow) has already
// minted the invite key and added the person to the allowlist by the time this
// runs; a mailer that could crash the request would turn "Resend is briefly
// down" into "the invite silently never happened". Every failure — no API
// key configured, Resend down, a 403 because the sending domain is not yet
// verified — comes back as `{ ok: false, error }` and the caller falls back to
// showing the inviter the key instead.

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10000;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * The invite's content, generated in exactly ONE place — hub/server.mjs's
 * /auth/allow hands the same `text` back to the inviter (as `inviteText`,
 * for "Copy invite") that `sendInviteEmail` below puts in the email body, so
 * the two can never say something different (BUG-2026-09-28: they used to).
 *
 * `teamName` — for the subject and body.
 * `key`      — the plaintext invite key (XXXX-XXXX). Never logged.
 * `macUrl`/`winUrl` — the stable direct download links (also emailed, so a
 *   recipient on their phone or without a browser handy can still go
 *   straight to the file for their platform).
 *
 * Returns `{ subject, text, html }`.
 */
export function inviteMessage({ teamName, key, macUrl, winUrl } = {}) {
  const team = teamName || "the team";
  const subject = `Join ${team} on Zevet`;
  const text = [
    `${team} invited you to Zevet.`,
    ``,
    `Key: ${key}`,
    ``,
    `Download: https://usemasora.com/zevet`,
    `macOS: ${macUrl}`,
    `Windows: ${winUrl}`,
    ``,
    `Install, open, enter the team and key.`,
  ].join("\n");
  const html =
    `<p>${escapeHtml(team)} invited you to Zevet.</p>` +
    `<p>Key: <code style="font:16px/1 monospace;letter-spacing:1px">${escapeHtml(key)}</code></p>` +
    `<p><a href="https://usemasora.com/zevet">Download</a> &middot; <a href="${macUrl}">macOS</a> &middot; <a href="${winUrl}">Windows</a></p>` +
    `<p>Install, open, enter the team and key.</p>`;
  return { subject, text, html };
}

/**
 * `apiKey`/`from` — RESEND_API_KEY / RESEND_FROM, read by the caller so this
 * module has no env dependency of its own and is trivial to test.
 * `to`         — the invitee's email.
 * `teamName`/`key`/`macUrl`/`winUrl` — see `inviteMessage` above.
 *
 * Returns `{ ok: true, id }` or `{ ok: false, error, status? }`.
 */
export async function sendInviteEmail({ apiKey, from, to, teamName, key, macUrl, winUrl, fetchImpl } = {}) {
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY not set" };
  if (!to) return { ok: false, error: "no recipient email" };

  const { subject, text, html } = inviteMessage({ teamName, key, macUrl, winUrl });

  const f = typeof fetchImpl === "function" ? fetchImpl : fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await f(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err && err.name === "AbortError" ? "Resend did not answer in 10 seconds" : `could not reach Resend: ${err.message}`;
    console.error(`zevet: invite email to ${to} failed: ${msg}`);
    return { ok: false, error: msg };
  }
  clearTimeout(timer);

  let body = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = null;
  }

  if (!res.ok) {
    const msg = (body && body.message) || `Resend answered ${res.status}`;
    console.error(`zevet: invite email to ${to} failed: ${res.status} ${msg}`);
    return { ok: false, error: msg, status: res.status };
  }

  const id = body && body.id ? String(body.id) : "";
  console.log(`zevet: invite email sent to ${to}${id ? ` (${id})` : ""}`);
  return { ok: true, id };
}
