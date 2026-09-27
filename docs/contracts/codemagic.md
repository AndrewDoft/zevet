# Codemagic REST API — secure app variables

**Verified 2026-09-27** against the live OpenAPI document, fetched this session:
`https://codemagic.io/api/v3/schema/openapi.json` (the human-readable page at
`https://docs.codemagic.io/rest-api/applications/` points at
`https://codemagic.io/api/v3/schema` for this, which itself just embeds the same
spec into a Scalar viewer — the JSON above is the actual source of truth).

Auth: header `x-auth-token: <token>` (`securitySchemes.api_key`, matches what
`scripts/codemagic.mjs` already sends). Base URL is `https://codemagic.io/`, **not**
`https://api.codemagic.io/` — that second, unversioned host only serves the older
`/builds` endpoints `scripts/codemagic.mjs` uses to start and poll a build.

## Create a variable group

```
POST /api/v3/apps/{app_id}/variable-groups
{"name": "apple_signing"}
```
`name` must match `^[^.$]*$`. Response: `{"data": {"id": "...", "name": "..."}}`
(the id field is `id`, not `_id`).

## Add secure variables to it (bulk)

```
POST /api/v3/variable-groups/{variable_group_id}/variables
{
  "secure": true,
  "variables": [{"name": "CERTIFICATE_P12", "value": "..."}, ...]
}
```
One call writes every variable in the group; `secure: true` marks all of them
masked in build logs. `GET /api/v3/apps/{app_id}/variable-groups` lists existing
groups (used to make group creation idempotent — this call fails if you POST a
group with a name that already exists).

## What's in `apple_signing` today (zevet + zevet-voice apps)

`CERTIFICATE_P12` (base64 `.p12`), `CERTIFICATE_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `codemagic.yaml`'s `macos` and
`macos-autoupdate` workflows pull the group in via `environment.groups`, then map
`CERTIFICATE_P12` / `CERTIFICATE_PASSWORD` to electron-builder's own `CSC_LINK` /
`CSC_KEY_PASSWORD` env var names before `npm run dist:mac`.
