# Releasing zevet

Every machine with zevet installed watches one file:
`https://usemasora.com/download/zevet-latest.json`. Publishing a release means
putting two installers and that file on the download host. Until the file
changes, nothing updates — a 404 or a stale version is treated as "nothing to
report", so there is no step here that half-ships.

## 0. Before anything

```
npm test              # the whole gate, from the repo root
```

Green, or stop. The gate includes `test/desktop-packaging.test.mjs`, which is
what catches the classic failure: a `require` added to `main.js` without adding
the file to `build.files` in `desktop/package.json`, which produces an app that
crashes on launch and a build that succeeded.

## 1. Bump the version

`desktop/package.json` is the source of truth — electron-builder puts that
number in the artifact names, and `scripts/make-feed.mjs` refuses to publish if
the two disagree.

```
# desktop/package.json  "version": "0.2.0"
git commit -am "release: 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The tag starts `.github/workflows/build.yml`, which builds on a Windows runner
and a macOS runner and, on the Mac, actually launches the app before uploading.

## 2. Collect the artifacts

From the Actions run, download both artifacts into one empty directory:

```
zevet-0.2.0-windows-x64-setup.exe
zevet-0.2.0-macos-arm64.dmg
```

⚠️ **An empty directory.** `desktop/out/` is not cleaned between builds, and two
versions in one folder is how a feed ends up advertising one build and serving
another. `make-feed.mjs` checks for exactly this and exits rather than write it.

### The .dmg from Codemagic

The Mac leg can also run on Codemagic (app `6ab33101a3079c5deee322d8`, workflow `macos`
in `codemagic.yaml`, mac_mini_m2), started from Windows:

```
node scripts/codemagic.mjs --branch <release branch or tag commit's branch> --out release-0.2.0/cm
```

It runs the suite, `npm run dist:mac`, `npm run smoke:mac`, then prints `lipo -archs` of the
app binary and the dmg's SHA-256. Token: `CODEMAGIC_TOKEN`, else the DPAPI file zevet-voice
uses. Move the `.dmg` from `cm/` into the release directory before step 3.

The Mac app is ad-hoc sealed, not notarized. First launch on a Mac: right-click → Open
(macOS 14), or System Settings → Privacy & Security → **Open Anyway** (macOS 15+, where
right-click no longer offers it). Terminal alternative:
`xattr -dr com.apple.quarantine /Applications/zevet.app`.

## 3. Generate the feed

```
node scripts/make-feed.mjs ./release-0.2.0 --notes "The editor, dark mode, and a code index."
```

It prints each file with its size and checksum and writes `zevet-latest.json`
beside them. Nothing about that file is typed by hand; the checksums are read
off the bytes that are about to be published.

`--notes` is one short sentence. It is shown in the rail under "Version 0.2.0 is
ready", in a 258px column, so it is a line and not a changelog.

**The feed is signed, and unsigned feeds are rejected by the app.** The script
refuses to write one without the private key:

```
$env:ZEVET_UPDATE_SIGNING_KEY = (pwsh -NoProfile -File C:/Users/andre/.claude/bin/update-signing-key.ps1 zevet | Out-String)
node scripts/make-feed.mjs ./release-0.2.0 --notes "..."
```

Never log or commit that PEM. The same value is the GitHub Actions secret
`ZEVET_UPDATE_SIGNING_KEY` on `AndrewDoft/zevet` (nothing in Actions builds the feed
today; it is there so one can). To re-sign a feed that is already published, in place:
`node scripts/make-feed.mjs --sign-only zevet-latest.json`.

Scheme (the same as Zevet Voice's `updates/signing.py`): Ed25519 over
`"zevet-update-v1\n"` (the domain string plus ONE newline byte) followed by the canonical
JSON of `payload` (sorted keys, `,`/`:` separators, non-ASCII left as is). The feed keeps its
old top-level `version`/`notes`/`platforms` so installed apps that predate signing keep
updating; new apps read only `payload` and `signature`
(`{algorithm:"ed25519", key_id:"zevet-2026-09", signature:<base64>}`). Pinned public key
(raw, base64) `WtLCaM3MBForULoSLJ0tYRmPyr4fOv24wBbugXSahZc=`, id `zevet-2026-09`, in
`desktop/update-signing.js`. Rotating: ship an app that pins both, then retire the old id.

Before an installer is offered, the app also checks its publisher (Authenticode
`CN=Andrew Doft`, or Developer ID team `27C8FVB83B`). It is enforced when the running app
carries that publisher itself and log-only otherwise, so unsigned dev builds still update.

### The hub's client manifest

`hub/server.mjs` serves `/dist/manifest.json`; installed clients (`client/updater.mjs`)
run the code it lists. It is signed the same way with the same key under the domain
`"zevet-client-v1\n"`. The hub holds no private key, so the signature is made at release time:

```
$env:ZEVET_UPDATE_SIGNING_KEY = (pwsh -NoProfile -File C:/Users/andre/.claude/bin/update-signing-key.ps1 zevet | Out-String)
node scripts/sign-client-manifest.mjs     # writes hub/client-manifest.signed.json — commit it
```

Run it after ANY change under `client/` and after every version bump.
`scripts/release-check.mjs` fails while the file is stale. A stale or missing file is not
fatal to the hub: it then serves the unsigned manifest, which current clients reject, so
client updates pause until the file is re-signed and the hub redeployed. Clients also refuse
a plain-`http` hub (loopback excepted). For a local dev hub only,
`ZEVET_ALLOW_UNSIGNED_MANIFEST=1` makes the updater accept an unsigned manifest.

## 4. Upload

The download host is `/srv/masora/downloads` on the GCE box `masora-app`
(project `masora-production`, zone `us-east1-b`). Port 22 is firewalled, so:

```
gcloud compute scp --tunnel-through-iap --zone us-east1-b \
  release-0.2.0/zevet-0.2.0-windows-x64-setup.exe \
  release-0.2.0/zevet-0.2.0-macos-arm64.dmg \
  release-0.2.0/zevet-latest.json \
  masora-app:/tmp/

gcloud compute ssh masora-app --tunnel-through-iap --zone us-east1-b --command \
  'sudo mv /tmp/zevet-0.2.0-* /tmp/zevet-latest.json /srv/masora/downloads/ && ls -la /srv/masora/downloads/'
```

⚠️ **Order matters.** Move the installers first and the feed last. A feed that
names a file the host does not have yet makes every machine on the team retry a
404 until the upload finishes.

⚠️ **The glob is expanded by your shell, not by `sudo`.** `sudo chmod 644
/srv/masora/downloads/zevet-*` silently does nothing, because the unprivileged
shell cannot read that directory and so the pattern never matches. Wrap it:
`sudo sh -c "chmod 644 /srv/masora/downloads/zevet-*"`.

Then check it from outside:

```
curl -s https://usemasora.com/download/zevet-latest.json
curl -sI https://usemasora.com/download/zevet-0.2.0-windows-x64-setup.exe | head -3
```

## 4a. Repointing the stable download links

`https://usemasora.com/download/Zevet.dmg` and `.../Zevet-Setup.exe` are the
links that never change — the invite email (`hub/mailer.mjs`) and anything
else that should survive a release both use these, not a versioned filename.
Caddy rewrites them to the versioned file:

```
handle /download/Zevet.dmg {
	root * /srv/downloads
	rewrite * /zevet-0.2.0-macos-arm64.dmg
	...
}
handle /download/Zevet-Setup.exe {
	root * /srv/downloads
	rewrite * /zevet-0.2.0-windows-x64-setup.exe
	...
}
```

⚠️ **Edit `/srv/masora/Caddyfile` in place — never `sed -i`.** `sed -i` writes a
new inode and renames it over the old one; `/srv/masora/Caddyfile` is bind-mounted
into the caddy container, which is still holding the OLD inode open, so the
container goes on serving the pre-edit file until it is recreated — the exact
trap `docs/RELEASING.md`'s hub section and `masora-landing/next.config.ts`
both document for the same reason. A python `open(..., "r+")` that writes and
truncates keeps the original inode:

```
gcloud compute ssh masora-app --tunnel-through-iap --zone us-east1-b --command '
  sudo cp /srv/masora/Caddyfile /srv/masora/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
  sudo python3 - <<PYEOF
import re
p = "/srv/masora/Caddyfile"
with open(p, "r+") as f:
    text = f.read()
    text = re.sub(r"zevet-[0-9.]+-macos-arm64\.dmg", "zevet-0.2.0-macos-arm64.dmg", text)
    text = re.sub(r"zevet-[0-9.]+-windows-x64-setup\.exe", "zevet-0.2.0-windows-x64-setup.exe", text)
    f.seek(0)
    f.write(text)
    f.truncate()
PYEOF
  '
```

Confirm the running container actually sees the new text (not just the file on
the host) before reloading:

```
gcloud compute ssh masora-app --tunnel-through-iap --zone us-east1-b --command \
  'docker exec $(docker ps -qf name=caddy) grep -n "zevet-0.2.0" /srv/masora/Caddyfile'
gcloud compute ssh masora-app --tunnel-through-iap --zone us-east1-b --command \
  'sudo docker exec $(docker ps -qf name=caddy) caddy reload --config /etc/caddy/Caddyfile'
```

Then from outside, confirm the stable links now 302/serve the new files:

```
curl -sI https://usemasora.com/download/Zevet.dmg | head -3
curl -sI https://usemasora.com/download/Zevet-Setup.exe | head -3
```

## 5. The landing page points itself

⚠️ **THIS STEP IS GONE, and the paragraph below is kept because it was the
source of a recurring bug.** It used to say: edit the `RELEASE` constant in
`masora-landing/src/app/zevet/page.tsx`, then rebuild and redeploy the
container. That made a release two separate acts, and the second one drifted
from the first every time — the live page sat a version behind the feed more
than once, and at one point linked an installer from three releases earlier
while installed copies had already updated past it.

The page reads `zevet-latest.json` now, with ISR at 5 minutes. **Publishing the
feed in step 4 IS publishing the site**, within five minutes, with no deploy.
Check it, because "nothing to do" and "silently broken" look identical:

```
curl -s https://usemasora.com/zevet | grep -o 'zevet-[0-9.]*-windows-x64-setup.exe'
```

It should name the version you just published. If it names the fallback in
`page.tsx` instead, the container could not reach the feed — that is a real
fault worth chasing rather than a reason to go back to hand-editing.

The rest of this section applies only when the PAGE ITSELF changes — new copy,
a new screenshot, a new section — which is now the only reason to rebuild it.

⚠️ **THE PUSH IS NOT THE DEPLOY.** `usemasora.com/zevet` is served by the
`landing` container on the same GCE box — `/srv/masora/Caddyfile` proxies it to
`landing:8080` — not by Vercel. Pushing main updates only the Vercel URL. The
0.2.0 release was one `curl` away from being announced while the live page still
linked 0.1.2.

```
npm run build                                   # output: "standalone"
tar -czf landing-build.tar.gz Dockerfile .next/standalone .next/static
gcloud compute scp --tunnel-through-iap --zone us-east1-b landing-build.tar.gz masora-app:/tmp/
gcloud compute ssh masora-app --tunnel-through-iap --zone us-east1-b --command '
  sudo rm -rf /tmp/landing-build && sudo mkdir -p /tmp/landing-build
  sudo tar -xzf /tmp/landing-build.tar.gz -C /tmp/landing-build
  sudo sh -c "cd /tmp/landing-build && docker build -t masora-landing:zevet-020 ."
  sudo cp /srv/masora/compose.yml /srv/masora/compose.before-zevet-020.yml
  sudo sed -i "s|image: masora-landing:voice-016|image: masora-landing:zevet-020|" /srv/masora/compose.yml
  sudo sh -c "cd /srv/masora && docker compose up -d landing"'
```

Then `curl https://usemasora.com/zevet` and look for the new filenames — a 200
proves nothing, the old container also returns 200.

The page and the feed are independent — the page is what a new person
downloads, the feed is what an existing install follows. They should name the
same version, and nothing enforces it, so check.

## 6. Watch one machine take it

Open an installed zevet. Settings → Version → **Check now**. It should move to
"0.2.0 is ready to install" within a second or two, and the rail should show the
row. Click it; on Windows the app exits and comes back on the new version.

If it says nothing at all, the phases that are deliberately silent are
"checking" and "current" — Settings shows the real state and the error text.

---

## Testing the updater without publishing anything

`ZEVET_APP_FEED` overrides the feed URL. `scripts/` has no fake host in it, but
one is about twenty lines of `node:http`: serve a manifest naming a file, serve
the file, point the app at it.

```
ZEVET_APP_FEED=http://127.0.0.1:8801/download/zevet-latest.json npm start
```

This is how the feature was verified before it had ever been published — the
real app, its own timer, a real stream, a real checksum.

The feed must be signed. For a loopback feed only, the app also honours
`ZEVET_APP_FEED_TRUSTED_KEY=<key id>:<raw public key, base64>`, so
`node scripts/make-feed.mjs <dir> --test-key <dir>/test-key.json` (a throwaway key, never
the real one) gives a feed a dev build will take. `codemagic.yaml`'s
`macos-autoupdate` workflow does exactly that.

## What is not automated, and why

**Uploading.** Publishing is the one irreversible step, and it is a `scp` into a
production box that also serves the Masora app. It stays a command somebody
runs on purpose.

**Signing.** Windows is signed as "Andrew Doft" via Azure Trusted Signing/OIDC
(see §Windows below) and verified in-job with `Get-AuthenticodeSignature`. macOS
signs with the "Developer ID Application" identity and notarizes with an App
Store Connect API key once `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_API_KEY` /
`APPLE_API_KEY_ID` / `APPLE_API_ISSUER` are all set (see §Code signing above);
without any one of the five the disk image ships ad-hoc sealed only, the app
cannot update itself in place — it opens the disk image and the person drags
it across — and it warns on first run. See D-006 in `DECISIONS.md`.

---

## Deploying the hub

The hub serves the board, `editor.js`, the sprites, `setup.sh`/`setup.ps1` and
the client update channel, so a renderer-side fix reaches every install on its
next launch WITHOUT a new app version. Use that.

`/srv/zevet` is **not** a git checkout — it is a tarball extracted in place:

```
git archive --format=tar.gz -o zevet-0.2.0.tar.gz v0.2.0
gcloud compute scp --tunnel-through-iap --zone us-east1-b zevet-0.2.0.tar.gz masora-app:/tmp/
gcloud compute ssh masora-app --tunnel-through-iap --zone us-east1-b --command '
  sudo tar -czf /srv/masora/zevet-tree.bak-$(date +%Y%m%d-%H%M%S).tar.gz -C /srv zevet
  sudo tar -xzf /tmp/zevet-0.2.0.tar.gz -C /srv/zevet
  sudo docker restart masora-zevet-hub-1'
```

⚠️ **In place, over the top — do not swap the directory.** `/srv/zevet:/app` is
a bind mount resolved when the container starts, so replacing the directory
leaves the container on the old inode. The same trap as the Caddyfile, which
`masora-landing/next.config.ts` documents at length.

Confirm with `/healthz`, which names the fields it gained:

```
curl -s https://hub.usemasora.com/healthz
{"ok":true,"events":0,"listeners":0,"rooms":0,"wsListeners":0}
```

`rooms` and `wsListeners` exist only in the WebSocket-era hub. If they are
absent, the restart did not pick up the new tree.

## The token cutover

Only needed once, and it was done on 2026-09-19. Recorded because the next
person to change `ZEVET_TOKEN` will hit the same two traps.

⚠️ **`docker restart` does NOT re-read `env_file`.** Environment is baked in at
container creation. A restart after editing `/srv/zevet/.env` reports success,
comes up clean, and keeps serving the OLD token. It takes:

```
sudo sh -c "cd /srv/masora && docker compose up -d --force-recreate zevet-hub"
```

⚠️ **Write the file with a heredoc, not `printf`.** Through
`gcloud compute ssh --command`, a shell, and `sudo sh -c`, the backslashes in
`printf %s\n` were eaten and a literal `n` was appended to the token. The hub
then rejected the correct credential with a plain 401 and nothing said why.

```
sudo tee /srv/zevet/.env >/dev/null <<'ZEOF'
ZEVET_TOKEN=<the derived token>
ZEOF
sudo chmod 600 /srv/zevet/.env
```

Always prove both halves afterwards, from outside — the first attempt returned
200 for the OLD token and 401 for the new one, exactly backwards, and only the
check showed it:

```
curl -so /dev/null -w "%{http_code}\n" -H "x-zevet-token: <old>"     https://hub.usemasora.com/api/state   # want 401
curl -so /dev/null -w "%{http_code}\n" -H "x-zevet-token: <derived>" https://hub.usemasora.com/api/state   # want 200
```

⚠️ And one about this document. The block above ends with `ZEOF`, not `EOF`,
because appending this file with a heredoc that CONTAINED a line reading `EOF`
closed the outer heredoc early: half the text landed in the file and the rest
was executed as shell. Nested heredocs need a distinct delimiter.

---

## Turning on GitHub sign-in

One-time, and it needs a human with a GitHub account — there is no API for creating an
OAuth app.

1. github.com → Settings → Developer settings → **OAuth Apps** → New OAuth App.
2. Name it `zevet`. Homepage `https://usemasora.com/zevet`. The callback URL is
   **required by the form and never used** — device flow has no callback. Put the homepage
   in again.
3. ⚠️ **Tick “Enable Device Flow”.** This is the whole thing. Without it GitHub returns a
   200 with an empty body and no explanation; `hub/github-auth.mjs` recognises that exact
   shape and names this tickbox in the error, because nobody finds it by guessing.
4. Copy the **Client ID** (`Iv1.…` or `Ov23…`). There is no client secret to copy, and if
   you generate one you do not need it.

Then on the hub (see **Deploying the hub** above for how to reach the box):

```
sudo tee -a /srv/zevet/.env >/dev/null <<'ZEOF'
ZEVET_GITHUB_CLIENT_ID=<the client id>
ZEVET_SECRET=<the existing master secret>
ZEOF
sudo sh -c "cd /srv/masora && docker compose up -d --force-recreate zevet-hub"
```

⚠️ **`ZEVET_SECRET` must be the secret already in the field, not a new one.** The hub hands
it to whoever signs in, and every document already in a room is encrypted under it. A fresh
one orphans all of them, silently — the editor opens blank and nothing logs an error.

⚠️ **If `ZEVET_TOKEN` is also set, it must be the derivative of that secret, or the hub
refuses to start** and prints the value it wanted. That refusal is deliberate: the two
disagreeing is the cutover bug above, and a hub that boots into it looks perfectly healthy
while 401-ing the whole team.

⚠️ **`docker restart` will not do.** It does not re-read `env_file`; see the cutover notes.

The client id is not a secret. Device flow has none, which is exactly why a desktop app is
allowed to use it.

### Signing in with Google

Unlike GitHub's device flow, Google's web flow needs a browser redirect to a fixed HTTPS
callback — and only the hub has one. So the desktop app never talks to Google at all: it
asks the hub to start a sign-in, opens the browser, and polls the hub for the result. The
same shape as GitHub, one more route.

⚠️ **This one has a real client secret**, which the GitHub device flow does not. It lives
only in `/srv/zevet/.env`, mode 600, and never reaches the app or the browser.

1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth
   client ID**, type **Web application**.
2. Under **Authorized redirect URIs** add exactly, byte for byte:
   `https://<hub-host>/auth/google/callback` — the canonical hub host is
   `hub.usemasora.com`, so a fresh setup adds
   `https://hub.usemasora.com/auth/google/callback`.
   ⚠️ **What is actually configured right now is still the sslip address**
   (`https://34-74-69-129.sslip.io/auth/google/callback`) — the hub domain
   moved on 2026-09-27 but `ZEVET_GOOGLE_REDIRECT` deliberately was not
   flipped in the same pass (see the git history around that date): sign-in
   works unaffected either way, since Caddy answers on both names, and the
   env only changes once someone has added `hub.usemasora.com`'s callback as
   an ADDITIONAL authorized redirect URI in Google Cloud Console (the sslip
   one stays registered too — removing it would be its own outage). Check
   which one is live with
   `ssh masora-app 'grep ZEVET_GOOGLE_REDIRECT /srv/zevet/.env'` before
   assuming this doc's example matches reality.
   ⚠️ A mismatch here does not fail until the very last step of a sign-in, as Google's
   `redirect_uri_mismatch`. A trailing slash is a mismatch.
3. Copy the **Client ID** and the **Client secret**.

Then on the hub (see **Deploying the hub** above for how to reach the box):

```
sudo tee -a /srv/zevet/.env >/dev/null <<'ZEOF'
ZEVET_GOOGLE_CLIENT_ID=<the client id>
ZEVET_GOOGLE_CLIENT_SECRET=<the client secret>
ZEVET_GOOGLE_REDIRECT=<the redirect URI you just registered in step 2 — must match byte for byte>
ZEVET_GOOGLE_DOMAIN=<your Workspace domain, or leave the line out>
ZEOF
sudo chmod 600 /srv/zevet/.env
sudo sh -c "cd /srv/masora && docker compose up -d --force-recreate zevet-hub"
```

⚠️ **`docker restart` will not do.** It does not re-read `env_file`; same trap as above.

**`ZEVET_GOOGLE_DOMAIN` is a door, not a filter.** Anyone whose Google account carries that
Workspace domain is admitted *without being invited* — that is the point of it, and it is
why revoking somebody now writes them to a block list rather than only deleting the invite.
Deleting alone would let the domain rule re-admit them on their next sign-in. Leave the
variable unset and only invited accounts get in.

`ZEVET_GOOGLE_OWNER=<login>` reserves first claim of the hub, exactly as
`ZEVET_GITHUB_OWNER` does. The first successful sign-in by *either* provider becomes the
owner if there is not one already.

**A Google identity and a GitHub identity are different people to the hub**, even with the
same name. Both records carry a `provider`, and matching requires provider *and* id —
a GitHub numeric id and a Google `sub` are both strings of digits from unrelated
namespaces, and treating them as comparable would be a way in. Invite a Google teammate by
email address; invite a GitHub one by username. `accounts.allow()` tells them apart by the
`@`.

**Checking it works.** `curl -s https://<hub>/auth/whoami` reports `googleSignIn` once the
client id is set; without it the sign-in routes answer 503 and the app says the hub has no
Google sign-in configured, which is the honest answer rather than a broken button.

### Claiming the hub

The **first** GitHub sign-in becomes the owner and can invite everyone else from
Settings → Account. So sign in yourself before telling anybody the address. Setting
`ZEVET_GITHUB_OWNER=<your login>` beforehand closes the window entirely.

State lives in `/srv/zevet/var/accounts.json`, mode 600 — the owner, the allowlist, the live
sessions and the master secret.

⚠️ **`var/` survives a deploy only because it is in `.gitignore`.** The release tarball is
extracted over `/srv/zevet` in place; extraction does not delete what it does not mention,
but a tracked `var/accounts.json` would overwrite the live one. That would sign the whole
team out and orphan every encrypted document in a single command.

### Back it up

```
sudo cp /srv/zevet/var/accounts.json /srv/masora/accounts.bak-$(date +%Y%m%d-%H%M%S).json
```

Losing this file loses the master secret, and with it every document in every room. It is
now the single most valuable file on that box.

---

## Code signing

macOS is wired and live as of the `macnotary` work (ported from the `macsign` branch).
`desktop/electron-builder.config.js` computes the build config from the environment;
`test/signing.test.mjs` pins both halves, including the case where only *some* of the
Apple credentials are present (refused — `desktop/signing.js`'s `macSigning()` is
all-five-or-none, never a partial signature that Gatekeeper still refuses while the
build log reads like a success).

**macOS — Apple Developer Program, $99/yr.** Add as repository *secrets*:

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | the Developer ID Application `.p12`, base64-encoded |
| `CSC_KEY_PASSWORD` | its export password |
| `APPLE_API_KEY` | an App Store Connect API key's `.p8`, base64-encoded |
| `APPLE_API_KEY_ID` | that key's id |
| `APPLE_API_ISSUER` | the App Store Connect issuer uuid |

Notarization is an **App Store Connect API key**, not an Apple ID + app-specific
password — the password path locked the Apple ID twice in one afternoon on a bad
credential (see `DECISIONS.md`), and an API key structurally cannot do that.
`app-builder-lib`'s `getNotarizeOptions()` (`macPackager.js`) reads `APPLE_API_KEY`,
`APPLE_API_KEY_ID` and `APPLE_API_ISSUER` for this ("option 2: API key"); no team id
is needed on this path. `APPLE_API_KEY` must be a **filesystem path** to the `.p8` by
the time electron-builder runs — that's what `@electron/notarize`'s `appleApiKey` is
documented as, and what it passes straight through as `notarytool submit`'s `--key` —
so the secret holds base64 and `build.yml`'s "Decode the App Store Connect API key"
step decodes it to a file and repoints the env var at that path before `npm run
dist:mac`.

With them set: `electron-builder.config.js` turns on `hardenedRuntime` + `notarize`;
`@electron/osx-sign` (`desktop/sign-macos.cjs` uses the pinned 1.3.1; electron-builder 26.17.0 carries its own 1.3.3) walks the whole `.app` and
signs every Mach-O it finds bottom-up; `desktop/staple-macos.cjs` (`afterSign`) staples
the notarization ticket onto the `.app` (electron-builder's own `notarize()` submits and
waits but never staples); `desktop/notarize-dmg.cjs` (`afterAllArtifactBuild`) separately
submits the built `.dmg` to `notarytool` and staples that too, since the app being
notarized does not give the `.dmg` — a different file, a different hash — a ticket of
its own. `build.yml`'s "Smoke the macOS app on Apple Silicon" step runs `codesign
--verify --deep --strict`, `spctl -a -vv -t exec` (asserting the verdict includes
`source=Notarized Developer ID`), and `xcrun stapler validate` on the `.app` whenever
`ZEVET_EXPECT_SIGNED` is set; it is a no-op (loud, not silent) on a fork or PR with no
secrets. A fresh CI keychain also lacks Apple's Developer ID intermediate CA, which
`build.yml`'s "Import Apple's Developer ID intermediate CA" step imports before the
build whenever `CSC_LINK` is set — without it electron-builder reports a perfectly
valid imported cert as `CSSMERR_TP_NOT_TRUSTED`.

This is also what unblocks **in-place auto-update on macOS**. macOS will not let an unsigned
app replace itself, so `desktop/app-update.js` currently opens the disk image and asks the
person to drag it across. Windows has had one-click update since 0.2.0; macOS cannot until
this is bought.

**Windows — Azure Trusted Signing, about $10/month. Already on.** Secrets
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID` (OIDC federated
credential via `azure/login`, scoped to the `signing` environment — no client
secret; `id-token: write` is what lets the runner mint the token); repository
*variables* `AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT`,
`AZURE_CERT_PROFILE`, `AZURE_PUBLISHER_NAME`. Chosen over an OV/EV certificate
because those now require the key on a hardware token, which a GitHub Actions
runner cannot use.

⚠️ `AZURE_PUBLISHER_NAME` must match the certificate subject exactly, or NSIS rejects its
own signature at install time.

Adding the secrets is the whole act of turning it on. The next tagged build signs.
