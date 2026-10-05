# Resend — send-email contract

Verified 2026-09-27 against:
- https://resend.com/docs/api-reference/emails/send-email
- https://resend.com/docs/api-reference/errors

No SDK. `hub/mailer.mjs` calls this directly with `fetch`.

## Request

```
POST https://api.resend.com/emails
Authorization: Bearer <RESEND_API_KEY>
Content-Type: application/json

{
  "from": "Masora <invites@usemasora.com>",
  "to": ["person@example.com"],
  "subject": "Join <Team> on Zevet",
  "html": "...",
  "text": "..."
}
```

`from`/`subject` required; `to` may be a string or string[] (max 50). `html`/`text`
both sent here even though only one is required — belt and suspenders, and `text`
is the only thing some mail clients show.

## Success (200)

```json
{ "id": "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }
```

## Error

Status + `{ "message": "..." }` (a `name`/type like `validation_error` also
appears but `message` is the only field this codebase reads). Measured today:

- sending from `onboarding@resend.dev` succeeds only to the account owner's own
  verified address (`andrew@usemasora.com`).
- sending from `invites@usemasora.com` (unverified domain) returns
  **403** with message `"The usemasora.com domain is not verified. Please, add
  and verify your domain."` — `hub/mailer.mjs` treats any non-2xx as
  `{ ok: false, error }` and never throws; the caller (`/auth/allow` in
  `hub/server.mjs`) degrades to `email_sent: false` and hands the key back to
  the inviter instead.

## Sharing the CRM's key with the hub (2026-09-28)

`RESEND_API_KEY` is set on masora-app for both `/srv/crm` (Zevet CRM,
AndrewDoft/zevet-crm — a separate app) and `/srv/zevet` (this hub), same
value, copied by hand rather than a shared secret store. Two gotchas hit
copying it this session, worth pinning:

- `/srv/crm/.env` quotes the value (`RESEND_API_KEY="re_..."`). A bare
  `cut -d= -f2-` copy carries the quote characters into the Bearer header —
  Resend answers `400 {"message":"API key is invalid"}` for THAT specific
  failure mode (quotes-in-token), not the domain-verification 403 above.
  Strip them before writing to `/srv/zevet/.env` (unquoted there, matching
  its other lines).
- The CRM's key is **restricted to sending** — `GET /domains` with it answers
  `401 {"message":"This API key is restricted to only send emails",
  "name":"restricted_api_key"}`. That is not a broken key; it means "cannot
  ask this key what domains are verified," and the only way to confirm
  send-capability with a send-only key is an actual send.
