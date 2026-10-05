# The `hd` claim

Source: https://developers.google.com/identity/openid-connect/openid-connect — "ID token claims", fetched 2026-09-27.

> `hd`: The domain associated with the Google Workspace or Cloud organization of the
> user. Provided only if the user belongs to a Google Cloud organization. You must
> check this claim when restricting access to a resource to only members of certain
> domains. The absence of this claim indicates that the account does not belong to a
> Google hosted domain.

A string, present only on a Google Workspace account, absent on a personal Google
account. `hub/google-auth.mjs`'s `readIdToken` is the only place this repo reads it,
straight off the id token this process fetched itself from `oauth2.googleapis.com` —
never re-derived from the email address (a personal account can verify a mailbox at
someone else's domain; only `hd` is asserted by Google).

Two places rely on it, both reading `Accounts`' own `domain`/`ownerHd`, never a second
copy of the claim:

- **the default team's Workspace door** (`ZEVET_GOOGLE_DOMAIN`): anyone whose `hd`
  matches is admitted without an invite (`Accounts#mayEnter`).
- **a created team's "Anyone at `<domain>`" toggle**: captured once, off the owner's
  own sign-in (`Accounts#signIn` stores it as `owner.hd`), and settable only to that
  exact value — the owner is turning on a rule for the domain Google says is theirs,
  not naming an arbitrary one.
