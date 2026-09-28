# AUDIT — zevet (AndrewDoft/zevet, main @ 5cdff9a, v0.2.83) — 2026-09-28

Read-only. Nothing but this file was added. Evidence style: `file:line` = lines I read;
`$ cmd` = command I ran here (Node v22.22.2, Linux, no Electron binary, no macOS/Windows).
Two sub-audits (hub/client, desktop) were done by helper agents; every finding I rank
CRITICAL/HIGH below I re-verified myself (marked **[verified]**). Others are marked **[agent]**
= read by the helper, not re-read by me. Not measured: installer size (no build here, `desktop/out`
absent), Electron RSS, runtime profiles.

## 0. Repo in numbers

| dir | files | lines (excl. lockfiles/png) |
|---|---|---|
| board/src (React/TSX) | 264 | 43,743 |
| desktop (Electron) | 57 | 17,602 |
| test | 118 | 28,370 |
| hub | 23 | 5,511 (of which hub/public is committed build output) |
| client | 12 | 3,846 |
| scripts | 19 | 2,231 |
| editor src+test | 3 | 729 |

543 tracked files, 50 commits, pack 7.38 MiB (`git count-objects -vH`). 4 lockfiles: 660 pkgs (board, 357 MB
`node_modules`), 474 (desktop), 60 (editor), 1 (root).

---

## 1. Architecture map

```mermaid
flowchart LR
  subgraph Dev["Teammate machine"]
    CLI["Coding agents\nclaude / codex / opencode"]
    HOOK["client/hook.mjs + opencode-plugin\n(runs before every tool call)"]
    subgraph EL["Electron 38 app (desktop/)"]
      MAIN["main.js (3870 lines)\n94 ipcMain.handle"]
      PRE["preload.js\nzevet / zevetLocal / zevetDoc"]
      REN["Renderer BrowserWindow\nloads REMOTE hub origin"]
      SETUP["setup.html (loadFile)"]
      ASK["ask-server.js\n127.0.0.1 loopback, bearer"]
      MCP["zevet-mcp.js (ELECTRON_RUN_AS_NODE)"]
      EMB["embedder.js\ntransformers.js + onnxruntime-node (optional)"]
      UPD["app-update.js\ncustom updater"]
      FS["~/.zevet/*.json\nconfig.json (secret), credentials, masora.json"]
    end
  end
  subgraph HUBVM["GCE VM masora-app (docker: zevet-hub, node:22-alpine)"]
    CADDY["Caddy reverse proxy"]
    HUB["hub/server.mjs (2552 lines)\nHTTP + SSE + WS, zero npm deps"]
    PUB["hub/public\nboard.js 1.5MB, editor.js 835KB (committed)"]
    ACC[("var/accounts*.json\nsessions, master secret, invite hashes")]
    EVT[("var/events*.jsonl")]
  end
  subgraph EXT["External"]
    GH["github.com / api.github.com\n(device flow)"]
    GO["accounts.google.com / oauth2.googleapis.com"]
    RS["api.resend.com (invite mail)"]
    HF["huggingface.co (MiniLM model)"]
    DL["usemasora.com/download/*\nzevet-latest.json + installers"]
  end
  subgraph SEAMS["Seams to sibling products"]
    MAS["Masora app 127.0.0.1:3210\n/api/connector/register, context brief, MCP http"]
    VOI["Zevet Voice CLI (spawned)\nusemasora.com/voice iframe"]
    CRM["Zevet CRM /srv/crm (separate repo)\nshares RESEND_API_KEY on same VM"]
  end
  CLI --> HOOK -->|POST /ingest, sha256 token| CADDY --> HUB
  REN -->|SSE /events, WS /ws, /api/*| CADDY
  HUB --- ACC & EVT
  HUB --> PUB
  HUB --> GH & GO & RS
  REN <-->|93 contextBridge channels| PRE <--> MAIN
  MAIN --> CLI
  MAIN --> ASK --> CLI
  MAIN --> MCP --> CLI
  MAIN --> EMB --> HF
  MAIN --> UPD --> DL
  MAIN --> FS
  MAIN -->|pair + brief + push, safeStorage token| MAS
  MAIN -->|spawn| VOI
  REN -.iframe usemasora.com/context,/voice (XFO/CSP stripped).-> DL
  CRM -.same Resend key, same VM.- RS
```

Summary:
1. Hub is a dependency-free Node server (`hub/*.mjs` imports only `node:*`; `$ grep` of bare specifiers in hub/client found none). It relays events (SSE), collaborative docs (WS rooms), and serves the built board.
2. Board is a React 19 + assistant-ui SPA built with Vite into `hub/public/` and **committed** (13 MB dir); the hub has no build step (`board/build.mjs:4-10`).
3. The desktop app does NOT bundle the board: its main window loads `${cfg.hub}/?token=…` (`desktop/main.js:701,716`), so UI ships on hub deploy, native features ship via installer.
4. Renderer↔main is a 93-channel named bridge (`preload.js`, 499 lines); main.js is a 3870-line single file owning ~94 handlers, 42 `require(`, 17 top-level `let/var`.
5. Auth: one shared team secret → derived `ZEVET_TOKEN` (hash) for the hub + HKDF doc key the hub never sees; plus GitHub/Google sign-in sessions and 8-char invite keys (`accounts.mjs:582`).
6. Auto-update is custom (`app-update.js`, 857 lines): manifest+installer from `usemasora.com`, sha256 from the same host; no publisher signature check.
7. Coding agents are spawned as child processes by main (`agent-console.js`), with hooks calling back to the hub; a loopback `ask-server` handles permission prompts.
8. Seams: Masora (pair/brief/push/MCP, `masora*.js`, `family.js`), Zevet Voice (`zevet-voice.js`, iframe), CRM (only a shared Resend key, `docs/resend.md:49-62`). No CRM code in this repo.
9. Deploy is manual: `git pull && docker restart zevet-hub` (README.md:57-72). No Dockerfile/compose in repo.
10. CI: two workflows, both `workflow_dispatch`/tag-only (`build.yml:11-14`, `onboard-live.yml:18-19`); **no PR/push CI**.

---

## 2. Dependency inventory

Manifests: `package.json` (root), `board/`, `desktop/`, `editor/`; lockfiles for all four. Hub/client/scripts have none (stdlib only).
Import-site counts = files importing the package. "reach" = counted only from files reachable from `board/src/main.tsx`
(script: import-graph BFS, scratchpad `deps.mjs`; unreachable files are dead, see §6).

### 2.1 root `package.json`
| dep | sites | verdict |
|---|---|---|
| playwright-core 1.63.0 (dev) | 3 files (`scripts/drive/drive.mjs`, `scripts/test-macos-autoupdate.mjs`, `build.yml`) | KEEP (tests drive real Electron) |

### 2.2 `board/package.json` (build-time only per its description; yet all under `dependencies`)
| dep | sites (reach) | verdict / proof |
|---|---|---|
| @ai-sdk/openai | 0 | **REMOVE** — `grep -rE "@ai-sdk/openai" board/src *.mjs *.ts scripts` → 0; lockfile `required-by` empty |
| ai | 0 imports (1 hit = the string "ai" in `voice-conversation.tsx:146`) | **REMOVE** as direct dep (it stays transitively via @assistant-ui/ai-sdk if that is kept — but that is dead too, below) |
| @fontsource-variable/geist | 0 | **REMOVE** — no import in `src/**`, `index.css`; fonts are served from `hub/public/fonts` |
| @types/react-syntax-highlighter | 0 | **REMOVE** with the two below |
| react-syntax-highlighter 16.1 | 1 file, unreachable (`elements/syntax-highlighter.tsx`) | **REMOVE**; `components/highlight.tsx` header records it cost 2.3 MB and was replaced by hub/public/highlight.js |
| @assistant-ui/react-syntax-highlighter | 1, unreachable | **REMOVE** |
| react-shiki | 2, both unreachable (`shiki-highlighter*.tsx`) | **REMOVE** (drags `shiki`) |
| @assistant-ui/ai-sdk | 1, unreachable (`context-display.aui.tsx:4`) | **REMOVE** (drags ai, @ai-sdk/react, @ai-sdk/mcp) |
| @assistant-ui/react-mcp | 1, unreachable (`mcp-config.aui.tsx`) | **REMOVE** (drags @modelcontextprotocol/client) |
| @assistant-ui/react-generative-ui | 1, unreachable (`generative-ui.tsx`) | **REMOVE** |
| @assistant-ui/store | 1, unreachable | **DEDUPE** — already a dependency of @assistant-ui/react (`package-lock`), drop the direct pin |
| react-resizable-panels | 1, unreachable (`ui/resizable.tsx`) | **REMOVE** |
| react-markdown | 1 unreachable; required by @assistant-ui/react-markdown (lockfile) | KEEP as peer-satisfier only (or drop; it is a hard dep of react-markdown pkg) |
| @assistant-ui/react | 30 (reach) | KEEP (core) |
| @assistant-ui/react-markdown | 2 | KEEP |
| @base-ui/react | 11 | KEEP |
| class-variance-authority | 7 | KEEP |
| cmdk | 1 (`ui/command.tsx`) | KEEP (palette) |
| cn 0.3.0 | 11 (imported as `from "cn"`; `src/lib/utils.ts` is a 1-line re-export, imported by 127 files) | KEEP; note also pulled in by `shadcn` |
| heat-graph | 2 | KEEP |
| lucide-react | 60 | KEEP (tree-shaken) |
| react / react-dom | 121 / 2 | KEEP |
| remark-gfm | 1 | KEEP |
| zustand | 3 | KEEP |
| tw-animate-css | 1 (CSS `@import`, `index.css:2`) | KEEP |
| tw-shimmer | 1 (`index.css:4`), masora.css:1404 says it is NOT used for light theme | KEEP or REPLACE by ~15 lines CSS |
| **shadcn 4.21** | 1: `@import "shadcn/tailwind.css"` (`index.css:3`), a 629-line CSS file | **REPLACE** — a whole CLI (babel, ts-morph, execa, @modelcontextprotocol/sdk, undici… `package-lock` deps list) installed for one CSS file; vendor it into `src/styles/` |
| devDeps @tailwindcss/vite, tailwindcss, @vitejs/plugin-react, vite, @types/react(-dom) | 1 each | KEEP |
| typescript ^7.0.2 | 0 imports, **no script runs it** | KEEP but wire a `typecheck` script (§4) |

Net if dead files (§6) and the above are removed: 12 direct deps out of 34; lockfile 660 pkgs would shrink (not measured).

### 2.3 `desktop/package.json`
| dep | sites | verdict |
|---|---|---|
| electron 38.1.2 (dev) | 2 (`main.js` and `preload.js` `require("electron")`) | KEEP |
| electron-builder 25.1.8 | build config; patched in `node_modules` by postinstall | KEEP; **bump to ≥26.16.0** and delete `patch-electron-builder-keychain.cjs` (its own header says upstream fixed it, `:8-12`) |
| @electron/osx-sign 1.3.1 | 1 (`sign-macos.cjs:17`) | KEEP (already a transitive of electron-builder → **DEDUPE** by not pinning separately if compatible) |
| @huggingface/transformers 4.3.0 (optional) | 1 lazy `require` (`embedder.js:553`) | KEEP as optional; see §7 for the size/port cost |

### 2.4 `editor/package.json` (all `devDependencies`, exact pins)
14 `@codemirror/*` + `y-codemirror.next`, `y-protocols`, `yjs`, `esbuild`: each 1 reference (`src/index.js`/`language.js`/`build.mjs`) → all KEEP. `y-protocols` has 2 refs (index + test).

### 2.5 Version drift / policy
- Pin style differs per manifest: root/desktop/editor exact (`1.63.0`, `38.1.2`, `6.20.3`…), board caret (`^19.3.0`, `^7.0.2`).
- No package appears in two manifests → no cross-manifest version conflict; drift is *policy*, not versions.
- `version`: root & desktop 0.2.83 (hand-synced), board/editor 0.0.0.
- Node: `engines >=20` (root) vs CI Node 22 (`build.yml`) vs hub image `node:22-alpine` (README:57-72 **[agent]**).
- **Committed bundle is not reproducible from the lockfile:** `$ cd board && npm ci && node build.mjs` produced `board.js 1489932 bytes`; committed `hub/public/board.js` is 1,518,868 bytes; `board.js.srchash` unchanged (it hashes only `board/src`, `board/build.mjs:33-45`, not deps/toolchain). I restored with `git checkout -- hub/public`. So the "gate asserts bundle matches source" claim (`build.mjs:7-9`) cannot detect toolchain drift and the artifact differs machine-to-machine.

---

## 3. Bugs (ranked)

### CRITICAL
**B1. Unauthenticated remote hub crash (one request kills the process). [verified]**
`hub/server.mjs:584` `decodeURIComponent(part.slice(eq+1).trim())` inside `tokenFrom()`, called from the async request handler (`server.mjs:1084`, no try/catch; also 1740→910→891, and upgrade 2454). No `process.on('uncaughtException'|'unhandledRejection')` (`$ grep` → none).
Repro run here: started hub (`PORT=18787 ZEVET_TOKEN=aa…`), `curl -H 'Cookie: zevet_session=%' /api/state` → `status=000`, hub log: `URIError … server.mjs:584 … Node.js v22.22.2`, process exited 1; next `/healthz` → connection refused.
Impact: any anonymous client can crash the production hub on demand (Docker `--restart unless-stopped` restarts it; all SSE/WS sessions and in-memory rooms are dropped each time; loop-able).
Fix (≈6 lines): use existing `safeDecode()` (`server.mjs:924`) and skip cookie on null; wrap handler body in try/catch → 400/500; add `unhandledRejection` logger.

**B2. Remote page holds the full local-machine bridge; agent "dangerous" mode is renderer-selectable. [verified in part]**
The board window loads a **remote origin** with a preload exposing 93 channels, `sandbox:false` (`main.js:626-645`, comment 626-640 argues it is acceptable because the hub is already trusted). `local:startAgent` (`main.js:3212`) checks only `knownRoot(cwd)`; `mode` is `opts.mode` straight from the renderer (`main.js:3268-3272`) and `dangerous` maps to `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` (`agent-console.js:351-356`). No handler validates `event.senderFrame` (**[agent]** grep `senderFrame|event.sender` → none).
Scenario: XSS or compromise of the hub (or of any hub-served/board-rendered content, e.g. agent output rendered as markdown) → start unsandboxed agent with attacker prompt in any opened workspace = RCE on every teammate.
Fix: allowlist `mode` in main against the user's stored setting; reject calls whose `senderFrame.url` origin ≠ hubOrigin; enable `sandbox:true` (verify preload needs only `contextBridge/ipcRenderer`, which it does: `preload.js` requires only those).

### HIGH
**B3. Auto-update trust = the download host. [agent, consistent with code comments]**
Manifest `https://usemasora.com/download/zevet-latest.json` (`app-update.js:82`); sha256 in the manifest from the same host proves transport integrity only — the file itself says so (`app-update.js:22-32`). Windows then runs the NSIS installer silently `/S` (`:619,:728`); macOS runs a `/bin/sh -c` hdiutil/ditto/mv script (`:786-830`, unverified on hardware per header `:49-50`). Host compromise = RCE for every install. Comments at `:10-15,49-58` say "unsigned" — stale now that `signing.js`/`sign-macos.cjs` exist.
Fix: sign the manifest with ed25519, pin pubkey in app (≈60 lines); or move to a framework updater with signature verification (see §7).

**B4. Same class for client hooks. [agent]** `client/updater.mjs:202-222` downloads `.mjs` from the hub, sha256 from the same hub; `client/hook.mjs:84` defaults to `http://127.0.0.1` and does not refuse plain-http remote hubs → shared token in cleartext. Fix: require https for non-loopback; sign the manifest.

**B5. Second unauthenticated crash: `new URL(req.url,…)` at `hub/server.mjs:1085` unguarded. [agent, and `$ node -e new URL('//[','http://localhost')` → ERR_INVALID_URL]** Upgrade path has a try (2462), main path doesn't. Same fix as B1.

**B6. Team master secret in plaintext on disk. [agent]** `main.js:549-558` writes `{hub, secret, …}` to `~/.zevet/config.json` with `chmod 0600` — a no-op on Windows (`:555-557`). Other secrets use `safeStorage` (`masora.js:108`, `main.js:422,1744`). The master secret is the doc-encryption root. Fix: move `secret` into safeStorage like credentials (~25 lines + migration).

### MEDIUM
**B7. Renderer-supplied path to installer with no `knownRoot` check. [verified]** `main.js:1553` `ipcMain.handle("zevet:install", …installHooks(repo))` → `execFile(process.execPath,[installer, repo], ELECTRON_RUN_AS_NODE=1)` (`:1025`). Contrast `local:startAgent` which calls `knownRoot`. Fix: `knownRoot(repo)` guard (3 lines).

**B8. `shell.openExternal` with unvalidated URLs. [verified for :679; agent for the rest]** `will-navigate` opens any non-hub-origin target incl. `file:`, `smb:` (`main.js:675-684`); server-supplied `verificationUriComplete`/`authUrl` (`:1230,:1261`), `masora-connect.js:86-113`, `masora-link.js:64`. `masora.saveUrl` stores any string (`masora.js:98-101`) that later feeds `${url}/admin`. Fix: one `openSafe(url)` that requires `https:` (or loopback http) — ~8 lines, apply at all sites.

**B9. Email relay / phishing via `/auth/allow` after anonymous team creation. [agent]** `/team/create` unauth (`server.mjs:1617`), first GitHub sign-in becomes owner, then `/auth/allow` mails any address from `invites@usemasora.com` with attacker-chosen team name (`mailer.mjs:64-103`); limiter counts only auth failures. Fix: validate email, cap invites/team/day, require account age.

**B10. Team-name squat & enumeration. [agent]** unauth `/team/resolve` (`server.mjs:1638`), unclaimed teams live 24 h (`:731`); first sign-in wins (`:858-875`). Fix: one-time claim secret at create.

**B11. Resource DoS. [agent]** `MAX_TEAMS=200` fillable by anonymous `/team/create` (`:723`); room log keeps one 8 MiB message (`:2274,:1929`) × 512 rooms; `evictIdleRoom` (`:2211`) evicts across teams; `Buffer.concat` per chunk O(n²) at `:2371`.

**B12. No security headers on any hub response. [verified by grep]** `$ grep -n "Content-Security\|X-Frame\|nosniff\|Strict-Transport" hub/*.mjs hub/public/index.html` → nothing. Board is a token-bearing SPA served with only `no-store` **[agent]**. CSP also absent for the Electron windows (only `setup.html:6` has a meta CSP **[agent]**). Fix: central header set in `json()`/static responders (~12 lines).

**B13. Sessions & tokens plaintext at rest / in URL. [agent]** `accounts.mjs:717` stores session tokens and master secret unhashed (file 0600, tmp+rename). `?token=` (`server.mjs:573-595`, `main.js:701`) lands in Caddy logs/history. Fix: store SHA-256(session token); drop query token after first exchange.

**B14. `frameable()` strips X-Frame-Options/CSP frame-ancestors for usemasora.com/context* and /voice* (`family.js:109-118`, `main.js:3812`). [agent]**

### LOW
- B15. Compaction `writeFileSync` without tmp+rename → truncated event log on crash (`server.mjs:338`); `appendFileSync` per event blocks loop (`:380`); events.jsonl never rotated (`:329-330`). [agent]
- B16. `clientIp` trusts first X-Forwarded-For (`server.mjs:592-598`); `authFailures` uncapped (`:611`). Safe only while the port stays unpublished. [agent]
- B17. Embedder model weights verified by minimum size only, redirects followed (`embedder.js:117-131,428,487`). [agent]
- B18. `GET /healthz` unauthenticated leaks counts (`server.mjs:1678`). [agent]
- B19. Typecheck is red and un-gated: `$ npx tsc --noEmit -p board` → 11 errors (`composercontrols.tsx:129,336` type mismatch on `UsageReading`; unused locals `runmeters.tsx:22`, …). No script or CI runs it.
- B20. Fresh-clone `npm test` is red: `$ node scripts/run-tests.mjs` → `tests 2541 pass 2510 fail 6 cancelled 16 skipped 9` (29.4 s). Causes: `desktop/build/icon.png` gitignored → 4 icon tests fail; `editor` deps not installed → `MODULE_NOT_FOUND` (`test 315`, y-protocols); no Electron binary → 3 setup-window suites (GitHub/Google sign-in, fresh install) fail/cancel. `gate.sh:20-24` claims editor tests need no install — false for that test.

---

## 4. Inefficiencies

### Runtime
- **Global 1 Hz store tick**: `board.ts:2903` `setInterval(()=>bumpTick(),1000)` mutates the zustand store every second while open; `agentviews.tsx:120` and `tree.tsx:330` subscribe to the raw `tick` (`useBoard(s=>s.tick)`) → those trees re-render every second; `sessions.tsx:39` is bucketed by 60 (fine). Also independent 1 s/500 ms clocks: `people.tsx:368`, `conversation.tsx:82`, `task.ts:86`. Fix: one `useNow(res)` hook subscribed per component at needed granularity.
- **Polling**: status poll every 4 s (`constants.ts:56`, `board.ts:2899`); `people.tsx:376` polls console files every 5 s; `settings.tsx:476` whoami/30 s, `:1210` 2 s, `:1378` 4 s; main: `runDueSchedules` 60 s (`main.js:2486`), masora push 5 min (`:2527`); app-update interval (`app-update.js:357`); hub: sweeps 1 h/1 min (`server.mjs:759,1041`), 2 ping intervals per SSE/WS connection (`:1758,:2359`) — a timer per connection, not one shared.
- **Bundle**: `board.js` 1,518,868 B + `board.css` 251,169 B, single chunk; the only dynamic imports are `main.tsx:18,23,28` (fixture/App), i.e. no route/feature splitting. `editor.js` 835,220 B loaded from a script tag. `.map` files 7.3 MB + 3.2 MB committed.
- **Memo**: `memo(` appears in only ~10 files, all vendored assistant-ui elements (`grep -c` output, first 10 shown); `useBoard(` appears 246× — check for whole-store selectors (only per-call review possible; not measured).
- **Watchers**: `file-watch.js` is per-file `fs.watch` (OS handle per open file, `main.js:2691-2702` documents it). Hub reads whole event log at boot (`server.mjs:329`).
- **Sync I/O on hub hot path**: `appendFileSync` per event (`server.mjs:380`), synchronous `#save()` on session touch (`accounts.mjs`).

### Dev loop
| step | measured here |
|---|---|
| root `npm ci` | 1.2 s |
| `node scripts/run-tests.mjs` (2541 tests) | 29.4 s (6 fail, 16 cancelled: env, see B20) |
| `board: npm ci` | 11.2 s (595 pkgs, 357 MB) |
| `board: tsc --noEmit` | 2.4 s, 11 errors |
| `board: node build.mjs` | 3.4 s |
- No lint, no format, no typecheck in CI or `npm test` (`grep` of workflows/gate: none).
- CI runs only on tags/manual (`build.yml:11-14`); test step is inside the release build job (`build.yml:93-94`) → regressions surface at release time, on both mac+win runners (costly), not on PRs.
- Committed build output (`hub/public/*`, 13 MB) means every UI change carries a ~1.5 MB minified diff + 7 MB sourcemap churn (`git rev-list --count HEAD -- hub/public/board.js.map` = 6 commits already) → merge conflicts and review noise by construction.
- Hand-maintained packaging list: `desktop/package.json` `build.files` enumerates 40 files; `$ node` diff shows only `electron-builder.config.js` and `signing.js` are not listed (correct), so it is currently consistent, but every new module needs a manual edit (a test, `desktop-packaging.test.mjs`, guards it).
- Build config split across `package.json#build` + `electron-builder.config.js` + `signing.js` + 3 hooks + a runtime patch of `node_modules` (postinstall).

---

## 5. Linearity blockers — 20 largest source files (excl. lockfiles/tests/docs)

| # | lines | file | note |
|---|---|---|---|
| 1 | 3870 | desktop/main.js | 94 IPC handlers, 175 fn/arrow blocks, 42 requires, 17 top-level mutable `let` → everything imports/gets touched through here |
| 2 | 3225 | board/src/lib/board.ts | one zustand store, 159 fn blocks; imported by ~all views |
| 3 | 2552 | hub/server.mjs | routes + auth + SSE + WS + persistence + static in one file (51 fn blocks) |
| 4 | 1631 | board/src/components/settings.tsx | 89 fn blocks, 3 polling timers |
| 5 | 1508 | board/src/styles/masora.css | global CSS overriding assistant-ui via `data-slot` |
| 6 | 941 | desktop/agent-console.js | |
| 7 | 913 | desktop/code-index.js | |
| 8 | 857 | desktop/app-update.js | custom updater |
| 9 | 835 | board/src/index.css | |
| 10 | 822 | desktop/embedder.js | |
| 11 | 801 | desktop/local-fs.js | |
| 12 | 758 | …/elements/tool-fallback.aui.tsx | vendored registry code |
| 13 | 755 | hub/accounts.mjs | |
| 14 | 755 | desktop/agent-sessions.js | |
| 15 | 721 | board/src/components/ui/sidebar.tsx | **unreachable** (dead) |
| 16 | 721 | …/elements/model-selector.tsx | |
| 17 | 713 | …/elements/thread.aui.tsx | |
| 18 | 702 | hub/public/highlight.js | committed generated/vendored |
| 19 | 659 | …/elements/composer.tsx | **unreachable** (dead) |
| 20 | 621 | board/src/lib/transcript.mjs | |

Test files are large too (`test/hub-ws.test.mjs` 1207, `local-fs` 1074, `code-index` 1044, `app-update` 1040). Test:source ≈ 28.4k : 73.3k lines (0.39).

Numbers that say cost will not grow linearly:
- **Three 2.5–3.9k-line hubs of coupling** (main.js, board.ts, server.mjs) = 9,647 lines = 13 % of source; each new feature touches them (e.g. 94 IPC handlers all in one file; each also mirrored in `preload.js` — 93/93 name match **[agent]** — and in `board/src/lib/bridge.ts` 458 lines: every capability costs ≥3 file edits + a test).
- **Triple bridge duplication**: main.js handlers ↔ preload wrappers ↔ bridge.ts types, no schema/codegen.
- **ZEVET_HOME resolved by copy-paste 20×**: `const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet")` in `desktop/{chat,credentials,main,masora-push,masora}.js`, `client/{doctor,uninstall,updater}.mjs`, and 6 more times inline in `client/hook.mjs` and 5× in `opencode-plugin.mjs` (`$ grep -rn ZEVET_HOME`). Same pattern for atomic-write/read-JSON helpers: 12 `renameSync`/`atomicWrite`-style sites across desktop/hub/client.
- **Vendored registry code with a sync script**: `board/src/components/assistant-ui/elements` has 126 files; 8,824 lines (20 % of `board/src`) unreachable from `main.tsx`, yet they typecheck and are maintained (`sync-registry.mjs`, 516 lines, exists solely to un-flatten `shadcn add`).
- **Test env coupling**: 3 suites need a real Electron binary + Playwright and are cancelled otherwise; `scripts/run-tests.mjs` (60+ lines) exists to turn "cancelled" into red.
- **Generated files committed**: `agent-models.generated.mjs`, `models.generated.mjs`, three `sync-*.mjs` scripts (`board/scripts`), `.d.mts` shadows for 20+ `.mjs` in `board/src/lib` (hand-written type shims → drift risk).
- **Hand-maintained duplicates of constants across processes**: hub `MAX_*`, client `OUTBOX_MAX`, desktop feeds (`app-update.js:82` vs `hub-target.js:20` LEGACY_HUB with sslip.io IP) — no shared config module (hub/client/desktop share nothing but comments saying "same rule as …", e.g. `auto-title.js:40`).
- **Docs of intent inside code**: comment density is very high (`electron-builder.config.js` first 60 lines are essay); good for decisions, but comments have gone stale (`app-update.js:10-15` "unsigned").

---

## 6. Dead code / artifacts

**Board unreachable from `main.tsx` (BFS over relative + `@/` imports): 64 files, 8,824 lines** (vs 34,563 reachable). Largest: `ui/sidebar.tsx` 722, `elements/composer.tsx` 660, `mcp-config.aui.tsx` 460, `thread-list.aui.tsx` 412, `assistant-modal.aui.tsx` 405, `quote.aui.tsx` 290, `composer-trigger-popover.aui.tsx` 254, `readiness.tsx` 214, `voice-conversation.tsx` 196, `sources.aui.tsx` 193, `canvas-split.tsx` 192 … plus `ui/sheet.tsx`, `ui/badge.tsx`, `ui/resizable.tsx`, `ui/separator.tsx`, `ui/label.tsx`, `hooks/use-mobile.ts`, `components/marks.tsx`, `components/prose.tsx`, `icons/github.tsx`, `utils/task.ts`. Caveat: a Playwright/`index.html` string-based loader would not show in the graph; I saw none (only 3 `import()` in `main.tsx`).
Removing these also removes the deps listed REMOVE in §2.2.

**Committed generated artifacts (all intentional per .gitignore comments, but a cost):** `hub/public/board.js` 1.5 MB, `board.js.map` 7.3 MB, `editor.js` 835 KB, `editor.js.map` 3.2 MB, `board.css` 251 KB, `*.srchash`. 13 MB total. The "dist/" at repo root is NOT build output: it holds `dist/setup.sh` and `setup.ps1` served by the hub (`server.mjs:1803`), so keep.

**Scripts referenced from nowhere but themselves** (1 external reference only = its own doc/`package.json`): `scripts/check-mac-installer.py`, `check-mac-peers.cjs`, `prepare-dmg-background.py` (used by `build.cjs:244`, keep), `repro-registry-hijack.mjs`, `test-macos-autoupdate.mjs`, `repro-andrew-incident.mjs`, `dmg-bookmark.swift`, `desktop/make-dmg-background.swift`. The `repro-*` scripts are named for one-time incidents → candidates to archive under `scripts/archive/` (not verified as unused by a human).

**Stale/duplicate ops docs:** `codemagic.yaml` + `scripts/codemagic.mjs` duplicate the macOS leg of `build.yml` (its own header says so); `INSUFFICIENCIES.md` INSUF-001 (GitHub billing) is marked RESOLVED; `docs/KNOWN-FAILURES.md`, `DECISIONS.md` 1091 lines.

**Linux target defined, not supported:** `package.json` `build.linux` (AppImage) vs updater supports only win32-x64 and darwin-arm64 **[agent: app-update.js:88-91]**.

**Public repo:** INSUF-001 says the repo was made public to get free Actions minutes; it contains prod hostnames/ops runbooks (`README.md:57-72`, `docs/resend.md`, `hub-target.js:20` IP-in-hostname). Not a secret leak in what I read, but the ops detail (VM name, zone, Caddy layout, Resend key handling) is public.

---

## 7. Electron usage profile

**Version/packaging:** Electron 38.1.2, electron-builder 25.1.8 (`desktop/package.json`). Targets: NSIS x64 (`oneClick:false, perMachine:false`), DMG arm64, AppImage (unsupported by updater). `build.files` = 40 hand-listed files; `extraResources`: `../client/*.mjs`. Excludes onnxruntime-web and non-matching-arch onnxruntime-node binaries. Installer size: **not measured** (no build). Electron runtime alone is the dominant fixed cost; onnxruntime-node adds native binaries.

**Windows/entry:** `BrowserWindow` board: `preload.js`, `nodeIntegration:false`, `contextIsolation:true`, `sandbox:false` (`main.js:625-645`); loads `${hub}/?token=<derived>` (remote, `:701,:716`); error pages via `data:` URLs (`:699,:720`). Setup window: same preload, `loadFile('setup.html')` (`:836-842`), meta-CSP only in setup.html. `titleBarStyle:'hidden'` + `titleBarOverlay` on Win/Linux (`:620-623,:830-834`), runtime `setTitleBarOverlay` (`:270,:2106-2112`). Zoom handlers `:651-672`. **No native DWM code** — the "DWM caption hack" is just titleBarOverlay; comment `:145-148` says the Win11 1px border is not fixable this way. No `webviewTag`.

**IPC:** 94 `ipcMain.handle` (`grep -c` main.js), 0 `ipcMain.on/once`; preload: 3 `exposeInMainWorld` (`zevet` :45, `zevetLocal` :171, `zevetDoc` :465), 93 `ipcRenderer.invoke`, 6 `ipcRenderer.on`. No sender validation (B2).

**Not used (grep evidence, **[agent]**):** `Tray`, `globalShortcut`, `protocol.handle`/`registerSchemesAsPrivileged`, `setAsDefaultProtocolClient`, `open-url`, `session.setPermission*`, `will-redirect`, `utilityProcess`/`worker_threads`, `keytar`.

**Used:** `dialog` (openDirectory ×3, messageBox), `shell.openExternal` (≥10 sites), `Notification` (`:911`), `Menu.setApplicationMenu` (`:993`), `safeStorage` (masora token, credentials), `powerMonitor.resume` → update recheck (`:3811`), `session.webRequest.onHeadersReceived` (`:3812`), `requestSingleInstanceLock` (`:3859-3870`), `setAppUserModelId` (`:114`), `setWindowOpenHandler` (https only, `:727-730`), `will-navigate` (`:675-684`).

**Child processes (no `shell:true`):** `claude`/`codex`/`opencode` (`agent-console.js:677-735`; Windows `.cmd` shim via cmd.exe with metacharacter guard `:686-702`), `git` via execFile (agent-worktree, repo-stats, masora-push, local-fs), `process.execPath` with `ELECTRON_RUN_AS_NODE` for client installer (`main.js:1025`) and MCP server (`:3178-3180`), `powershell.exe -Command`/`osascript -e`/`screencapture` for computer-use (`computer.js:115-358`), `reg query` (`family.js:73`), login-shell `-ilc` PATH probe (`runtime.js:50`), Zevet Voice CLI (`zevet-voice.js:40,255`), `/bin/sh -c` for mac self-update (`app-update.js:820-830`).

**Native/ML:** `@huggingface/transformers` 4.3.0 optional, lazy `require` (`embedder.js:553`), model Xenova/all-MiniLM-L6-v2 downloaded from huggingface.co at runtime (`:136,:331-342`), `allowRemoteModels=false` afterwards (`:651`), runs in the **main process** (blocks event loop during inference; no worker). `onnxruntime-node` is the only native addon.

**Loopback servers:** `ask-server.js` 127.0.0.1 random port, 24-byte bearer, `timingSafeEqual`, Host/Origin checks, 64 KB cap (`:112-133,:192`) — solid **[agent]**. Doc-sync WebSocket client to hub (`doc-sync.js:163`), key stays in main.

**Keychain patch:** `patch-electron-builder-keychain.cjs` (postinstall) string-rewrites `app-builder-lib/out/codeSign/macCodeSign.js` because electron-builder 25.1.8 passes `CSC_KEY_PASSWORD` to `security set-key-partition-list -k` (needs keychain pw) — every `CSC_LINK` build failed with `SecKeychainUnlock` (`:3-8`). Silently no-ops with a warning if the upstream file changes (**[agent] :147-153**). Upstream-fixed (header `:8-12`) → bump electron-builder and delete.

**Signing pipeline (`electron-builder.config.js`, `signing.js`):**
- mac (needs 5 env: `CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY(_ID/_ISSUER)`) → hardenedRuntime + notarize (`:70-85`) → `staple-macos.cjs` (`afterSign`, `xcrun stapler staple`) → DMG → `notarize-dmg.cjs` (`afterAllArtifactBuild`: `notarytool submit --wait` + staple). Without creds: ad-hoc seal via `@electron/osx-sign` (`sign-macos.cjs:15-37`), not notarized; in-place auto-update impossible so the updater opens the DMG (`electron-builder.config.js` header, D-006).
- win: Azure Trusted Signing when 7 `AZURE_*` env present (`signing.js:217`); else unsigned. `build.yml` runs a Windows leg with `environment: signing` and OIDC (`:29-34`) and disables Defender realtime scanning on the CI runner (`:45-50`).
- `build.cjs` wraps electron-builder CLI and runs `python3 ../scripts/prepare-dmg-background.py` mid-build for the DMG Finder bookmark (**[agent] :244-247**) — Python + Swift in a JS build.

**What renders:** everything user-visible except setup: the hub-served React board (remote), 1.5 MB JS + 251 KB CSS, plus iframes to `usemasora.com/context` and `/voice` (`family.js:109`).

**Hard to port to Tauri (Rust + WebView2/WKWebView):**
1. *Privileged bridge to a remote origin* — 93 commands; Tauri v2 needs per-origin capability scoping; port must add sender-origin checks from day one (fixes B2). Cost: rewrite 94 handlers (~all of main.js + preload.js = 4,369 lines) in Rust or Node sidecar.
2. *Node-native features* — `ELECTRON_RUN_AS_NODE` for installer + MCP server → needs a bundled Node sidecar or Rust rewrite; agent spawning with process groups/`.cmd` shims/JSONL streaming (`agent-console.js` 941 lines) → `std::process`/plugin-shell + reimplement Windows shim logic.
3. *transformers.js + onnxruntime-node* → `ort` crate or sidecar; model download verification to add.
4. *safeStorage blobs* (masora token, credentials) are unreadable outside Electron → migration/re-pair flow (stronghold/keyring).
5. *Custom updater* — replace with `tauri-plugin-updater` (ed25519-signed) which fixes B3; existing installs need one last Electron release as a bridge.
6. *`titleBarOverlay` + zoom + runtime colour* (`main.js:2106-2119`) — no equivalent; needs custom titlebar (`decorations:false`) and Win32 calls for the 1px border.
7. *`webRequest.onHeadersReceived` header stripping for the Masora iframes* (`main.js:3812`) — no per-request header hook in WebView2/WKWebView; route through a custom protocol/proxy or serve embeddable pages.
8. *Signing/notarization hooks + keychain patch + Python/Swift DMG background* → replaced by `tauri build` env conventions; the pipeline (≈6 files) is rewritten, not ported.
9. *Computer-use* via PowerShell/osascript (`computer.js`) ports as-is via `Command`, but permission prompts (macOS Accessibility/Screen Recording) attach to the new binary identity → users re-grant.
10. *Behavior differences*: WKWebView/WebView2 ≠ Chromium — the board CSS (`masora.css` 1,508 lines targeting assistant-ui `data-slot`s), `fs.watch`-style file events, and the SSE/WS stack need cross-engine testing; the 2,541-test suite includes real-Electron driven tests (`scripts/drive/drive.mjs`, Playwright) that would need a WebDriver rewrite.
Portable with little change: hub, client hooks, board UI (mostly), editor bundle, test suites not tied to Electron.

---

## 8. Top 15 fix list (value ÷ effort)

Effort = estimated diff lines (my estimate, not measured). "Safe" = safe to apply without a human deciding product behaviour.

| # | fix | value | effort | safe w/o human |
|---|---|---|---|---|
| 1 | B1+B5: `safeDecode` for cookie, try/catch around handler + `new URL`, `unhandledRejection` logger (`server.mjs:584,1084-1085`) | stops anonymous 1-request DoS of prod hub | ~15 | **yes** (add a regression test) |
| 2 | B12: central security headers (CSP allowing self + fonts/ws, `nosniff`, `X-Frame-Options`, `Referrer-Policy`) | closes clickjacking/MIME; defense for B2 | ~15 + test | mostly yes — CSP could break inline styles; needs one browser check |
| 3 | B7: `knownRoot(repo)` guard on `zevet:install` | closes arbitrary-path exec | ~4 | **yes** |
| 4 | B8: one `openSafe()` (https/loopback only) at all `openExternal` sites | closes file:/smb: launch | ~15 | **yes** |
| 5 | B2: allowlist `mode` in `local:startAgent` vs stored setting + `senderFrame` origin check on all handlers via a wrapper `handle()` | closes remote-page→RCE path | ~40 | **no** — changes what the hub UI may do; product decision |
| 6 | Add PR/push CI: `npm ci` (root+editor) → `npm test` → board `tsc` → `node build.mjs && git diff --exit-code hub/public` on ubuntu (cheap) | linear-cost guardrail | ~30 YAML | yes |
| 7 | Fix red tests on fresh clone (generate icon in test setup or skip with reason; install editor deps in CI; skip Electron suites when binary absent instead of failing) (B20) | `npm test` honest on any machine | ~30 | yes |
| 8 | Delete 64 unreachable board files (8,824 lines) + remove 12 dead deps (`@ai-sdk/openai, ai, @fontsource…, react-syntax-highlighter, @assistant-ui/{ai-sdk,react-mcp,react-generative-ui,react-syntax-highlighter,store}, react-shiki, react-resizable-panels, @types/react-syntax-highlighter`), re-run `tsc`+build+tests | −20 % board code, faster install/typecheck | −8,900 lines | yes if build+tests stay green; keep `sync-registry` decision for human |
| 9 | Fix the 11 tsc errors and add `"typecheck"` script (B19) | catches type drift | ~15 | yes |
| 10 | B6: move master `secret` in `config.json` into safeStorage with migration | secret at rest on Windows | ~30 | no — migration of live installs |
| 11 | Replace `shadcn` dep with vendored `tailwind.css` (629 lines) | removes a CLI and its dependency tree (babel, ts-morph, MCP sdk…) from install | +629/−1 | yes (visual diff check) |
| 12 | Bump electron-builder ≥ 26.16, delete `patch-electron-builder-keychain.cjs` + postinstall | removes node_modules monkeypatch | ~−150 | no — needs a signed mac build to prove |
| 13 | Manifest signature (ed25519, pinned key) for app updater and client updater; refuse non-https remote hub (B3, B4) | closes supply-chain RCE | ~120 | no — key management + release process |
| 14 | Single `zevetHome()` module (20 call sites) + shared `atomicWriteJson`; replace 1 Hz global `tick` with per-component `useNow` | de-duplication, fewer re-renders | ~80 | yes |
| 15 | Stop committing build output: build `hub/public` in deploy (tar built on CI) or at minimum drop `*.map` from git (10.5 MB) and make the build reproducible (pin/verify toolchain; hash lockfile into `srchash`) | kills 1.5 MB+7 MB diff noise per UI change | ~40 | no — changes deploy flow (`git pull && docker restart`) |

Bottom line for the "linear cost" goal: (a) the three god-files (main.js, board.ts, server.mjs) plus the hand-mirrored 3-way IPC surface are the main super-linear drivers; (b) 20 % of board source and 1/3 of its direct deps are dead weight; (c) there is no PR-time CI, so cost lands at release; (d) B1 is an immediate, verified production availability bug.
