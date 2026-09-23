# scripts/drive — dev-only Electron driving harness

Launches the real desktop app with a throwaway `ZEVET_HOME` and Electron
`--user-data-dir` (a true first-install state), attaches over CDP with
playwright-core, and drives it from bash. Not shipped — not in
`desktop/package.json`'s `build.files`.

```bash
node scripts/drive/drive.mjs launch                      # fresh profile, waits for CDP
node scripts/drive/drive.mjs windows                      # list open windows
node scripts/drive/drive.mjs snapshot [--window N]        # DOM outline: tag/id/role/text/disabled/hidden
node scripts/drive/drive.mjs click "<selector>|text=..."
node scripts/drive/drive.mjs type "<selector>" "<text>"
node scripts/drive/drive.mjs press "<key>"
node scripts/drive/drive.mjs eval "<js>"                  # evaluated in the page
node scripts/drive/drive.mjs screenshot "<path>"
node scripts/drive/drive.mjs opened                       # shell.openExternal calls this run recorded
node scripts/drive/drive.mjs close                        # kills the app, cleans up state
```

`ZEVET_TEST_HOOKS=1` (set automatically by `launch`) stubs `shell.openExternal`
in the main process: it logs `{url, at}` to `<home>/opened-external.jsonl`
instead of opening a real browser. `opened` reads that log.
