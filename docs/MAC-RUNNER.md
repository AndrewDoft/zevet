# Michael's Mac as Zevet's macOS build runner

Zevet can't ship: every release needs a green `build.yml` run, and the macOS leg on GitHub's hosted
`macos-latest` has timed out in `smoke:mac` (CDP attach) since 2026-10-09, even on unchanged code.
This turns an Apple Silicon Mac into a free self-hosted GitHub Actions runner for that one leg.
Signing and notarization still use the repo's `signing` environment secrets; nothing has to be
installed in the keychain beforehand.

## For the agent on the Mac

Rules: never print the registration token; don't install anything other than what's below; don't
touch other repos.

1. Check: `uname -m` must print `arm64`. `xcode-select -p` must succeed (if not, run
   `xcode-select --install` and ask Michael to click Install). `python3 --version` and `git --version`
   must work. Node doesn't matter; the workflow installs its own.
2. Get a registration token from Andrew. It is valid for one hour. Andrew runs:
   `gh api -X POST repos/AndrewDoft/zevet/actions/runners/registration-token --jq .token`
3. Install the runner. Take the current version from
   https://github.com/actions/runner/releases/latest, using the `actions-runner-osx-arm64-<ver>.tar.gz`
   asset, and check the sha256 listed on that release page:
   ```
   mkdir -p ~/actions-runner-zevet && cd ~/actions-runner-zevet
   curl -fsSLO https://github.com/actions/runner/releases/download/v<ver>/actions-runner-osx-arm64-<ver>.tar.gz
   shasum -a 256 actions-runner-osx-arm64-<ver>.tar.gz   # must match the release page
   tar xzf actions-runner-osx-arm64-<ver>.tar.gz
   ./config.sh --url https://github.com/AndrewDoft/zevet --token <TOKEN> \
     --name michael-mac --labels zevet-mac --work _work --unattended --replace
   ./svc.sh install && ./svc.sh start && ./svc.sh status
   ```
   `svc.sh` installs a LaunchAgent, not a daemon. That matters because `smoke:mac` launches the app
   and needs the logged-in GUI session.
4. Report back: the output of `./svc.sh status`, and confirm that the runner `michael-mac` shows
   **Idle** at https://github.com/AndrewDoft/zevet/settings/actions/runners (or check with
   `gh api repos/AndrewDoft/zevet/actions/runners --jq '.runners[]|[.name,.status,.busy]'` if gh is
   logged in).

## What Michael should know

- The Mac must be awake and logged in while a release builds; one build takes about 15–25 minutes.
  `caffeinate` isn't needed between releases.
- During `smoke:mac`, the Zevet app opens briefly with an isolated profile, then closes. Builds live in
  `~/actions-runner-zevet/_work`.
- `build.yml` sends it only tag pushes and manual dispatches. That alone does NOT keep a public repo
  safe: a fork PR runs its own copy of the workflows, so it can edit `ci.yml` (which has a
  `pull_request` trigger) to `runs-on: zevet-mac` and run code on this Mac. The repo's fork-PR policy
  is `first_time_contributors` (2026-10-12), so a returning contributor's PR would run unapproved.
  Before registering the runner, require approval for every outside contributor:
  `gh api -X PUT repos/AndrewDoft/zevet/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors`.
  Read every fork PR's workflow diff before approving its run.
- To remove it: `cd ~/actions-runner-zevet && ./svc.sh stop && ./svc.sh uninstall && ./config.sh remove --token <new token>`.

## Then (Andrew / orchestrator)

`gh variable set MAC_RUNNER -R AndrewDoft/zevet --body zevet-mac`, then run `node scripts/ship.mjs`
again. To go back to the hosted runner, `gh variable delete MAC_RUNNER -R AndrewDoft/zevet`.
