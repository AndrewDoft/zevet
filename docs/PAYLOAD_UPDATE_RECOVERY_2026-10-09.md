# Michael's Mac: payload update recovery and prevention

## Diagnosis and observed repair

The retired-channel and Rosetta hypotheses were not confirmed. The read-only inspection found:

- `~/Library/Application Support/Zevet/payload/channel`: missing, which means stable.
- `staged.json` and `bad.json`: missing.
- Installed app: `~/Applications/zevet.app`, arm64, installer version 0.2.131.
- Actual log directory: `~/Library/Logs/zevet-desktop/`, not `~/Library/Logs/zevet/`.
- Zevet was not running when this investigation started.

Exact `current.json` before launching:

```json
{"build":"0.2.132","seq":2132,"previous":{"build":"0.2.129","seq":2129},"trial":false,"trial_started":null,"boots":0,"failures":[],"high_seq":2132,"high_seq_build":"0.2.132","high_seq_manifest":"00fb6f9520f5084c0c5a764d5f1b7090912aa22f2148d7c620cba7c16e988fe4","high_seq_issued":"2026-10-08T13:08:24.884Z"}
```

The log already proved a successful update beyond 0.2.131:

```text
2026-10-08T22:08:48.525Z INFO payload 0.2.132 activated; relaunching
2026-10-08T22:08:48.954Z INFO running payload 0.2.132 (current, trial) from ~/Library/Application Support/Zevet/payload/versions/0.2.132
2026-10-08T22:09:17.377Z INFO payload confirmed healthy
```

Home-directory prefixes in these log excerpts are abbreviated to `~`; messages and timestamps are otherwise exact.
The reported 0.2.131 matched the installer metadata, not the active payload. A persistent update failure could
not be reproduced, and the evidence does not establish what prevented an earlier check. Historical network
failures existed, but none establishes the cause of the reported incident. No channel or replay-protection
state was rewritten.

At inspection, stable and canary both already published signed 0.2.139, seq 2139, rather than the handoff's
0.2.137/frozen canary. Launching the installed app triggered its normal updater:

```text
2026-10-09T04:10:49.625Z INFO running payload 0.2.132 (current) from ~/Library/Application Support/Zevet/payload/versions/0.2.132
2026-10-09T04:10:51.982Z INFO payload 0.2.139 activated; relaunching
2026-10-09T04:10:52.327Z INFO running payload 0.2.139 (current, trial) from ~/Library/Application Support/Zevet/payload/versions/0.2.139
2026-10-09T04:10:55.943Z INFO payload confirmed healthy
```

Exact `current.json` after activation:

```json
{"build":"0.2.139","seq":2139,"previous":{"build":"0.2.132","seq":2132},"trial":false,"trial_started":null,"boots":0,"failures":[],"high_seq":2139,"high_seq_build":"0.2.139","high_seq_manifest":"27a2953eaa5189073a717c801fe058237d90dc7036f9ca612e75d00752cc2b59","high_seq_issued":"2026-10-09T04:00:17.884Z"}
```

Settings → Account → Version visibly showed 0.2.139. The active pulse signature, raw manifest hash, and all
97 materialized files were independently verified. The normal installer updater also installed shell 0.2.139
at 04:15 UTC.

## Gate-discovered installer test hazard and recovery

The full Mac gate exposed an existing destructive test: the “cleanup step exits 0” test in
`test/app-update.test.mjs` executed `_macReplaceSteps()[7]` against the actual user and system Applications
folders. It removed the installed Zevet bundle during the gate. The app's persisted account and payload data
were outside that cleanup and remained present.

Zevet was restored at its original path from the official 0.2.139 DMG. The signed installer feed, 205311184-byte
download and SHA256 `4100ada24b24e59c041f9294c5e08bba9cfadcf9be906f9ee33fb6cf0786a8cf` were verified first.
Apple accepted the bundle as Notarized Developer ID, and its code signature passed verification. No signed
bundle contents were patched.

The private replacement-step builder now accepts disposable cleanup roots for tests. Production callers keep
their existing roots. The executable cleanup test supplies only its temporary directory and asserts that no
Applications path appears BEFORE running the command. Mutating away that isolation made the test fail before
execution. This narrow safety fix is necessary to run the requested Mac gate without deleting installed apps.

## Prevention branch

- Bootstrap accepts saved stable only. Retired saved channels are logged and rewritten to stable; an explicit
  `ZEVET_PAYLOAD_CHANNEL` remains authoritative. Rewrite failures are logged and that launch still uses stable.
- Every non-staged `check()` result is logged on change with channel, sequence floor, build and reason. The
  original result and rejection behavior is preserved. No sequence, signature, rollout or activation guard changes.
- A signed stable pulse ahead of the running build starts a persistent lag clock. More than 24 hours without
  staging reports once through the existing scrubbed Sentry path with channel, high_seq, running build, stable
  build and last status. Staging or catching up clears the clock. New targets do not reset it; restarts preserve it.
- Ship signs stable and compatibility canary pulses, uploads bytes before pointers, verifies both channels, and
  refuses to call the payload step complete while either channel is behind. No release was run here.
- Bootstrap and diagnostics are shell files: Andrew must ship a new installer to deliver them. A payload-only
  release cannot change an installed bootstrap. Compatibility mirroring keeps old channel files updating meanwhile.

## Validation and handoff

The 132 focused updater/release/Sentry tests passed; all 82 installer tests passed. IPC generation verification,
board typechecking, syntax checks and diff whitespace checks passed. Thirteen deliberate mutations were caught:
channel repair, override preservation, status logging, deduplication, 24-hour threshold, persistence, staged-update
suppression, signature trust, Sentry capture, compatibility publishing/completion, bootstrap channel wiring,
bootstrap monitor wiring, and Mac test cleanup isolation. Mutated sources were restored before final checks.

The first full local gate ran 3741 tests: 3731 passed, two failed, eight skipped, zero cancelled. Its serial rerun
remained red. Both failures were reproduced with the changed production files replaced temporarily by their
base-commit contents, then restored:

- `detect.test.mjs`: “nothing installed anywhere” discovers the real `/opt/homebrew/bin/codex`, outside the fixture.
- `setup-sso-e2e.test.mjs`: Google callback request fails with `fetch failed`, cause `read ECONNRESET`.

Those unrelated failures were not hidden or weakened. This branch is for draft review, not release approval.
Andrew/orchestrator owns merge and ship. Nothing was merged or pushed to main, and no release feed was changed.
