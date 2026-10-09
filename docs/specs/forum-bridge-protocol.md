# Forum bridge protocol (Masora -> hub)

Wire contract Masora must implement to read the board, steer an agent and answer an approval as a signed-in team member. The hub side is `hub/server.mjs` (`masoraBridge`), `hub/masora-auth.mjs` (`verifyBridge`).

## Enabling

- The hub verifies with env `ZEVET_BRIDGE_PUBLIC_KEY`: the raw 32-byte Ed25519 public key, base64 (or base64url). Masora holds the private key. Unset or malformed: every route returns `503 {"error":"bridge_unconfigured"}`.
- Each team has a policy `masoraBridge: "off" | "on"`, default `off`, set only by the team owner (`PUT /api/policy {"masoraBridge":"on"}`). While off, every route returns `403 {"error":"bridge_off"}`. This is checked after the token verifies and before the member is looked up.
- The Masora workspace (`wid`) must already map to a team (`ZEVET_MASORA_TEAMS` or a bound team), and `email` must belong to a signed-in member of it. Nothing is created.

## Request

Header `x-masora-assertion: <compact JWS>` on every call.

| Route | Method | Body |
|---|---|---|
| `/masora/board` | GET | none |
| `/masora/steer` | POST | `{"actor","session","text"[,"repo"]}`; `text` 1-4000 chars |
| `/masora/approval` | POST | `{"id","decision":"allow"\|"deny","cardHash"}` |

Bodies are JSON, at most 16 KiB.

## Token

Header: `{"alg":"EdDSA","typ":"JWT"}`. Signature: Ed25519 over `base64url(header) + "." + base64url(claims)`. Any other `alg` (including `none` and `HS256`) is rejected. The HS256 sign-in assertion for `/auth/masora` is not accepted here, and a bridge token is not accepted there.

Claims, all required:

| Claim | Value |
|---|---|
| `typ` | `"zevet_bridge"` |
| `aud` | `"zevet-hub-bridge"` |
| `iss` | `"masora"` |
| `wid` | Masora workspace id |
| `email` | the acting member's email |
| `jti` | unique id, single use |
| `iat`, `exp` | seconds since epoch; `0 < exp - iat <= 60`; `iat` at most 30 s ahead of the hub clock; `exp` in the future |
| `req` | request binding, below |

### `req`

```
req = base64url( SHA-256( METHOD + "\n" + PATH_WITH_QUERY + "\n" + RAW_BODY ) )
```

- `METHOD`: upper case (`GET`, `POST`).
- `PATH_WITH_QUERY`: the request target exactly as the hub receives it, e.g. `/masora/board`. If a proxy rewrites the path, sign what the hub sees.
- `RAW_BODY`: the exact bytes sent, as UTF-8 text; empty string for GET.
- base64url without padding. A token is valid for one request only.

## Replay

Each `jti` is accepted once. The set is persisted in the hub's data directory and survives restarts. The same applies to `/auth/masora` sign-in assertions.

## Board response

`GET /masora/board` returns `{now, agents, events}`. Agents carry no `emails` or `logins`. Each agent has `approval`:

- `null` when no card is open, or when the team's `approve` policy is `off`, or when the member's role cannot approve.
- otherwise `{"id","text","cardHash"}`. `text` is the full card (`<tool> <arguments>`), never truncated or reflowed. `cardHash = base64url(SHA-256(id + "\n" + text))`.

Show `text` to the human unaltered.

## Answering

`POST /masora/approval` must echo the `cardHash` of the card the human saw. If the card on the hub no longer hashes to it (or `cardHash` is missing), the hub answers `409 {"error":"card_changed"}` and nothing is sent. Re-read the board and ask again.

## Errors

| Status | Body | Meaning |
|---|---|---|
| 401 | `{"error":"malformed"\|"bad alg"\|"bad signature"\|"wrong token"\|"incomplete"\|"window too large"\|"expired"\|"from the future"\|"request mismatch"\|"already used"}` | token rejected |
| 429 | `{"error":"too many failed attempts..."}` | too many failures from this address; only failed calls count, a valid token is never blocked by earlier failures |
| 403 | `{"error":"bridge_off"}` | team switch is off |
| 403 | `{"error":"you are not a signed-in member of this team"}` | unknown email |
| 403 | role / policy refusals (`steer` and `approve` policy, role below editor) | |
| 404 | `{"error":"this workspace has no team"}`, unknown agent or approval, unknown route | |
| 409 | `{"error":"card_changed"}` | card text changed or hash missing |
| 409 | `{"ok":false,"status":...}` | already answered, or their app is offline |
| 400 | `{"error":...}` | bad body or decision; answering your own agent |
| 503 | `{"error":"bridge_unconfigured"}` | no public key on the hub |

403 and 404 refusals are logged on the hub with team, a hash of the email and the reason. Steers and approvals answered through the bridge are logged with `via:masora-bridge`.
