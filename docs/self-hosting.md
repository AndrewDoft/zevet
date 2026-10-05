# Self-hosting (admins)

People never see or enter a hub. They type a team name; the app resolves it to
that team on one hub, and each team on a hub is isolated (own secret, accounts,
board, credentials, relay rooms; `test/team-isolation.test.mjs`).

The app picks the hub in this order (`desktop/hub-target.js`):

1. `ZEVET_HUB` in the app's environment
2. `hub` already stored in `~/.zevet/config.json` (existing installs, untouched)
3. `defaultHub` in `~/.zevet/config.json`
4. the hosted hub

Point a fleet at your own hub by setting either of the first or third:

```
ZEVET_HUB=https://zevet.example.com
```

```json
{ "defaultHub": "https://zevet.example.com" }
```

Only `http(s)://` values are accepted. Run the hub itself as in the README.
The terminal installers (`dist/setup.sh`, `setup.ps1`) read `ZEVET_HUB` too.
