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

Then check it from outside:

```
curl -s https://usemasora.com/download/zevet-latest.json
curl -sI https://usemasora.com/download/zevet-0.2.0-windows-x64-setup.exe | head -3
```

## 5. Point the landing page at it

`masora-landing/src/app/zevet/page.tsx`, the `RELEASE` constant: version and
both hrefs. Commit and push to `main`; Vercel deploys.

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
