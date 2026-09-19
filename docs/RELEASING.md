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

## 3. Generate the feed

```
node scripts/make-feed.mjs ./release-0.2.0 --notes "The editor, dark mode, and a code index."
```

It prints each file with its size and checksum and writes `zevet-latest.json`
beside them. Nothing about that file is typed by hand; the checksums are read
off the bytes that are about to be published.

`--notes` is one short sentence. It is shown in the rail under "Version 0.2.0 is
ready", in a 258px column, so it is a line and not a changelog.

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

## 5. Point the landing page at it

`masora-landing/src/app/zevet/page.tsx`, the `RELEASE` constant: version and
both hrefs. Commit and push to `main`.

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

## What is not automated, and why

**Uploading.** Publishing is the one irreversible step, and it is a `scp` into a
production box that also serves the Masora app. It stays a command somebody
runs on purpose.

**Signing.** Neither artifact is signed. macOS therefore cannot be updated in
place — the app opens the disk image and the person drags it across — and both
platforms warn on first run. See D-006 in `DECISIONS.md`; the fix is an Apple
Developer account, which is a purchase rather than a patch.

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
curl -s https://34-74-69-129.sslip.io/healthz
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
curl -so /dev/null -w "%{http_code}\n" -H "x-zevet-token: <old>"     https://34-74-69-129.sslip.io/api/state   # want 401
curl -so /dev/null -w "%{http_code}\n" -H "x-zevet-token: <derived>" https://34-74-69-129.sslip.io/api/state   # want 200
```

⚠️ And one about this document. The block above ends with `ZEOF`, not `EOF`,
because appending this file with a heredoc that CONTAINED a line reading `EOF`
closed the outer heredoc early: half the text landed in the file and the rest
was executed as shell. Nested heredocs need a distinct delimiter.
