# Mac fixes after 0.2.1

Branch: `michael/apple-silicon`. Pull request: https://github.com/AndrewDoft/zevet/pull/1.

## Available now

The hub's board has the Settings install button, live download progress, retry controls, and shorter wording. Reload the app to load it. This also works with installed 0.2.0 clients. The public 0.2.1 installers and update feed were not replaced.

The repaired Apple Silicon app is installed locally in `~/Applications/zevet.app`. It still requires the user's normal team sign-in. It was built from this branch; Andrew should publish the desktop fixes under a new version.

## Checks on September 19, 2026

- macOS 26.5.1, arm64: 807 tests passed, 4 skipped, no failures.
- Built the DMG; strict bundle integrity passed; all 20 native binaries contain arm64. Bundled ONNX and Transformers loaded. The app launched with its normal sandbox.
- In the actual 0.2.0 app, Settings opened the official 0.2.1 DMG; Finder displayed the app and Applications shortcut.
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

The previous hub page is backed up at `/srv/masora/zevet-ui-before-0e329bd.html`. Only `/srv/zevet/hub/public/index.html` changed on the live hub, without restarting it or changing authentication.
