# Mac fixes after 0.2.1

Branch: `michael/apple-silicon`. Pull request: https://github.com/AndrewDoft/zevet/pull/1.

## Available now

The hub's board uses Masora's current Space Grotesk typography, paper-and-ink palette, therefore mark, and a neutral dark theme. Settings has the install button, live download progress, retry controls, and shorter wording. Reload the app to load it. This also works with installed 0.2.0 clients. The public 0.2.1 installers and update feed were not replaced.

The repaired Apple Silicon app is installed locally in `~/Applications/zevet.app`. It still requires the user's normal team sign-in. It was built from this branch; Andrew should publish the desktop fixes under a new version.

## Checks on September 19, 2026

- macOS 26.5.1, arm64: 813 tests passed, 4 skipped, no failures.
- Built the DMG; strict bundle integrity passed; all 20 native binaries contain arm64. Bundled ONNX and Transformers loaded. The app launched with its normal sandbox.
- In the actual 0.2.0 app, Settings opened the official 0.2.1 DMG; Finder displayed the app and Applications shortcut.
- Native UI: light and dark themes, file editing surface, IDE and Agent views, 720×420 through 1240×820 windows, Mac traffic-light clearance, Settings keyboard focus and Escape were checked. Setup was checked with both GitHub and the expanded manual form.
- Code rendering: monospace alignment and fallback fonts verified; text and selection survive theme changes. Small text and syntax colors meet 4.5:1 contrast on the tested surfaces.
- Watcher stress case: 99 of 100 immediate changes missed before the fix; none missed afterward. The editor-read-to-watch gap is also covered.
- Packaged-runtime test: concurrent edits, presence, an agent process changing a file, encrypted relay, second peer's disk update, and late-peer snapshot recovery all passed.

The peer test uses a real local hub and temporary files. It does not claim two physical computers or authenticated Claude/Codex turns. The 0.2.1 hub holds the team key; encryption here does not imply secrecy from the hub.

## Repeat

Generate the icon, run `bash scripts/gate.sh`, then build from `desktop/` with `npm run dist:mac` and run `npm run smoke:mac`.

From the repository root, run the packaged peer check:

```sh
ELECTRON_RUN_AS_NODE=1 desktop/out/mac-arm64/zevet.app/Contents/MacOS/zevet scripts/check-mac-peers.cjs "$PWD" "$(command -v node)"
```

It uses temporary files and does not change user agent settings.

## Distribution

The disk image opens as **Zevet**, with Masora's paper-and-ink styling, a Retina background, and the app beside the real Applications shortcut. The app identity and storage paths are unchanged. Regenerate the committed background images with `cd desktop && swift make-dmg-background.swift`.

Build through `npm run dist:mac`. Its wrapper preserves electron-builder's CLI options and creates a native Finder background bookmark using Swift on the mounted staging image, before compression, signing, or checksums. The older Python-generated bookmark looked valid but did not resolve on current macOS, leaving a blank background. Mac builds therefore require the Xcode command-line tools already provided on the CI runner. The smoke test checks the final image's contents, Finder layout, both background resolutions, and actual bookmark resolution after mounting at a temporary location. Finder was also checked with the finished image.

The beta bundle has an ad hoc integrity seal. Apple Developer ID signing and notarization still require publisher credentials. The existing configured signing path remains available. Mac updates open the installer; replacing the app is still manual.

### Website download, September 19

`https://usemasora.com/download/Zevet.dmg` now serves the branded wrapper as a
download named `Zevet.dmg`. The page stays open and gives one installation step.
The immutable server file is `zevet-0.2.1-macos-arm64-branded-v2.dmg`:
157,380,993 bytes; SHA256
`1ef1e7f7086df0ea7b599e849ec261e48b5526c6a351ab603704fcb3fff2b56d`.
All 318 entries and file modes in its app match the official 0.2.1 app. Only the
disk-image presentation changed; this does not release the branch's later app
code under an old version. Original versioned downloads and the update feed are
unchanged. Windows uses `/download/Zevet-Setup.exe` with its original bytes.

The full live response matched the tested image. Native Finder, renamed-image
portability, the repaired build path, Mac smoke, and the 813-pass/4-skip test gate
passed. The website click stayed on the page and showed the instruction; an
automated browser-saved file was not independently verified.

Michael's Apple Developer membership was confirmed active through July 5, 2027.
He created the Developer ID Application certificate on September 19. Its public
key matches the prepared request and local private key. The identity and Apple's
G2 intermediate are installed; macOS now reports one valid code-signing identity.
No trust overrides were applied. Notarization authentication is now saved and
verified in Michael's local Keychain profile `zevet-notary`; never put credentials
in this repository or chat. The official 0.2.1 app has been Developer ID signed,
with secure timestamps and hardened runtime on all 20 native files. Its resources,
plists, native executable content, paths, and permissions match the original
release; only signature metadata changed. A real isolated launch, ONNX/Transformers
loading, and strict signature checks passed.

Apple submission `8f97d111-aa1d-48fa-83ce-b563cd2ef442` was uploaded on September 19
at 19:26 UTC and is still processing. Resume that same submission; a local wait
timeout does not cancel it. The public download has not yet been replaced with
the signed app. Six local preflight warnings concern native code stored in
Electron resource directories; no Error-level findings were returned. Apple's
actual result, stapled tickets, and final Gatekeeper checks remain required.

For `--prepackaged` builds, sign and notarize the app
first: the pinned builder skips that work when given an existing app.

This local signing setup does not configure GitHub Actions. Future public Mac
releases must pass `ZEVET_EXPECT_SIGNED=1 npm run smoke:mac` and staple validation;
the workflow's ad-hoc development builds are not trusted release installers.

Server rollback files: `/srv/masora/Caddyfile.before-zevet-branded-v2-20260919T185500Z`
and `/srv/masora/compose.before-zevet-download-page-20260919.yml`.

The previous update-button hotfix is backed up at `/srv/masora/zevet-ui-before-0e329bd.html`. The later Masora design deployment is backed up at `/srv/masora/zevet-before-masora-design`, with before/after hashes for the eight changed UI/font files. The hub restarted to load the font allowlist; authentication and stored account data were unchanged.

Michael's GitHub authorization succeeded, but the live hub is unclaimed and reserved for Andrew. Andrew must sign in once, then add `mshvid1101` in Settings → Account. The local app is ready; it does not bypass this access rule.
