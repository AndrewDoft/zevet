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

The beta bundle has an ad hoc integrity seal. Apple Developer ID signing and notarization still require publisher credentials. The existing configured signing path remains available. Mac updates open the installer; replacing the app is still manual.

The previous update-button hotfix is backed up at `/srv/masora/zevet-ui-before-0e329bd.html`. The later Masora design deployment is backed up at `/srv/masora/zevet-before-masora-design`, with before/after hashes for the eight changed UI/font files. The hub restarted to load the font allowlist; authentication and stored account data were unchanged.

Michael's GitHub authorization succeeded, but the live hub is unclaimed and reserved for Andrew. Andrew must sign in once, then add `mshvid1101` in Settings → Account. The local app is ready; it does not bypass this access rule.
