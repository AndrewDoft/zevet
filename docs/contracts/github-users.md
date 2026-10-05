# GitHub public-users API — invite email lookup contract

Verified 2026-09-28 against:
- https://docs.github.com/rest/users/users (`GET /users/{username}`)
- Live: `curl https://api.github.com/users/octocat` → 200, `"email": null`
  (confirms the field exists and is nullable on this exact response shape,
  today)

Used by `hub/github-auth.mjs`'s `githubPublicEmail(login)`, called from
`hub/server.mjs`'s `/auth/allow` when an invite is typed as a bare GitHub
login with no email of its own.

## Request

```
GET https://api.github.com/users/{username}
Accept: application/vnd.github+json
User-Agent: zevet-hub
```

Unauthenticated (no token) — this is a PUBLIC profile endpoint. GitHub rate
limits unauthenticated requests to **60/hour per IP**; fine for invite
volume on a team hub, not fine for bulk lookups.

## Response (200)

Relevant field only:

```json
{ "email": "person@example.com" }
```

or `"email": null` when the person has not made an address public.

Per the doc page: "email: the publicly visible email address" — GitHub only
lets a person set a **verified** address as their public one, so a non-null
value here is treated as verified without a second check (same trust basis
`githubUser`'s own `email` field uses for a signed-in caller's token).

## Not found (404)

A login that does not exist (or the API being unreachable) answers 404 or a
network error; `githubPublicEmail` returns `{ ok: false, error }` and the
caller (`/auth/allow`) reports `recipient_needed: true` so the UI can ask for
an email inline (settings.tsx's `PendingRow`), rather than silently dropping
the invite.
