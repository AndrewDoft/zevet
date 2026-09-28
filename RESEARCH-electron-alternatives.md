# Decision memo: move off Electron?

Date: 2026-09-28. Scope: research only, no product code changed.
**Recommendation in one line: stay on Electron for all three shipping Electron/Node-shaped workloads, but upgrade off Electron 38 now (it is out of support). Do not migrate Voice to a webview shell; if Voice ever gets a UI refresh, pywebview is the only candidate worth a spike.**

## 0. Evidence quality (read first)
The egress proxy blocked most vendor sites (tauri.app, electronjs.org, electrobun.dev, neutralino.js.org, wails docs, onnxruntime.ai, GitHub API). Versions/dates below come from the npm registry, PyPI, crates index, raw GitHub docs and GitHub release pages that *were* fetched. **Size / RAM / startup numbers are secondary (blog) sources, never measured on our apps, and should be treated as order-of-magnitude.** Items marked `UNVERIFIED` could not be confirmed; I did not fill them from memory. Before any migration decision, run the spike in section 5 and replace these numbers with our own.

## 1. What the apps actually are (from this repo)
- `desktop/package.json`: `electron` 38.1.2, `electron-builder` 25.1.8, optional `@huggingface/transformers` 4.3.0. Targets: NSIS x64 (Windows), DMG arm64 (macOS).
- `desktop/main.js` is **3,870 lines with ~94 `ipcMain` handlers** (`grep -cE "ipcMain\.(handle|on)"`). It is not "mostly window + updater": it is a Node application host (repo watching, git worktrees, agent consoles, MCP server, hub sync, credential store, chat backends).
- Electron-only APIs used: `BrowserWindow`, `safeStorage` (credential + Masora token encryption, main.js:422,1575,1744), `powerMonitor` (main.js:3811), `setTitleBarOverlay` (main.js:270,2106), `Notification`, `Menu`, `session`, `dialog`. No `Tray` in zevet (grep found none).
- Child processes: `execFile(process.execPath, …, {ELECTRON_RUN_AS_NODE:"1"})` (main.js:1025, 3180) — the app relies on Electron *being* a Node runtime to run helper scripts. `desktop/auto-title.js:92` spawns CLIs.
- Updater: custom `desktop/app-update.js` (spawn + sha256 + installer), not electron-updater. It is already framework-independent in design.
- transformers.js: `desktop/embedder.js:553` `require("@huggingface/transformers")` in the main process via onnxruntime-node (native N-API). Optional, must never block startup.
- Masora and Voice are not in this repo; their descriptions are taken from the task brief only.

## 2. Electron itself: the real urgent finding
| Fact | Value | Source |
|---|---|---|
| Latest stable | 44.4.5 (2026-09-23); 44.0.0 on 2026-08-25 | https://registry.npmjs.org/electron |
| Electron 38 last release | 38.8.6 on 2026-03-11 (38.0.0 was 2025-09-02) | https://registry.npmjs.org/electron |
| Support policy | Latest 3 stable majors only, 8-week major cadence | https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/electron-timelines.md |
| Implication | Supported set is 44/43/42 today; **38 is ~6 majors behind and has had no release for ~6.5 months** (inference from the two rows above) | same |
| electron-updater | 6.8.9 (2026-06-05), still maintained | https://registry.npmjs.org/electron-updater |

Cheapest risk reduction available: bump to a supported major (43 or 44). This is a few days of work (see plan) and removes the security-patch gap regardless of any framework decision. electron-builder 25 should be re-checked for compatibility when bumping (not researched).

## 3. Comparison table
"Size/RAM" figures are for hello-world-class apps from secondary sources, NOT our apps. Our Electron installers already carry a Chromium (~80-150 MB typical, cited below) and, for Masora, a Python runtime on top.

| | Electron 44 | Tauri 2 | Electrobun | Wails 3 | Neutralinojs | pywebview |
|---|---|---|---|---|---|---|
| Latest version (source date) | 44.4.5, 2026-09-23 [1] | CLI 2.12.0, 2026-09-26; `tauri` crate 2.12.0; Tauri 3 is alpha only [2][3] | `latest` 2.0.1; beta 2.0.2-beta.35 on 2026-09-28 [4] | v3.0.0-beta.26 (Sept 25; year not shown on page); v3 is beta, v2 is stable line [5] | `neu` CLI 11.7.2 (2026-06-03); framework version UNVERIFIED [6] | 6.2.1, 2026-04-15 [7] |
| Maturity | Very high | High for 2.x (2.0.0 CLI 2024-10-02) [2] | Beta line, several betas per week [4]; README claims "dozens of production apps", none named [8] | Beta [5] | Small (8.7k stars), releases sparse [9] | Stable, niche [7] |
| Installer size (hello world) | 85 MB vs Tauri 3.2 MB [10]; typical 80-150 MB [11] | ~3 MB (same source) [10]; sources also cite 30-40 MB for real apps [11] | "minimal" with system webview, no number found [8] | No number found | No number found; uses OS webview, no Chromium [9] | Small, no renderer bundled [12] (+ Python interpreter) |
| Idle RAM | 168 MB vs Tauri 42 MB [10]; another source 200-300 MB vs 30-40 MB [11]; a Tauri issue disputes the saving [13] | see left | no number found | no number found | no number found | no number found |
| Startup | not measured (no credible source fetched) | not measured | not measured | not measured | not measured | not measured (PyInstaller onefile unpacks every run [14]) |
| Auto-update | electron-updater or custom (we have custom) | `tauri-plugin-updater` 2.13.0; signature mandatory, cannot be disabled; static JSON or server; Windows `passive`/`basicUi`/`quiet`; **Windows app is force-exited during install**; macOS uses `.app.tar.gz`+`.sig` [3][15] | Built-in binary-diff (bsdiff+zstd) updates, full-download fallback [8] | No built-in updater found (UNVERIFIED) | UNVERIFIED | None claimed [7] |
| Sidecar / Python | `child_process`, `extraResources`; we already ship Node-as-runtime | `bundle.externalBin`, one binary per target triple suffix (e.g. `-aarch64-apple-darwin`) [16]; official sidecar doc has no notarization guidance [16] | Bun/JSC-style TS main process; child-process story UNVERIFIED [8] | Go; sidecar story UNVERIFIED | UNVERIFIED | Python native (it is the app) [7] |
| Renderer | Bundled Chromium (identical everywhere) | WebView2 (Win) / WKWebView (mac) / WebKitGTK (Linux) [17] | System webview by default; optional bundled CEF [8] | Native OS webview [5] | OS webview, no Chromium [9] | OS webview (WinForms/Cocoa/GTK/Qt) [12] |
| Signing/notarization | Works today (our pipeline) | Supported (not re-verified for 2.12); sidecar binaries need separate signing (general knowledge, UNVERIFIED in official docs) | UNVERIFIED | UNVERIFIED | UNVERIFIED | Your PyInstaller/Nuitka problem [14] |
| Windows support | Mature | Mature | Windows 11+, macOS 14+, Ubuntu 24.04+ officially [8] (excludes Win10) | Beta | Yes | Yes |
| transformers.js in webview | N/A (runs in Node or renderer) | Possible only if WebGPU/WASM works in the OS webview (see 4) | same | same | same | same |
| Migration effort from our main.js | 0 (bump only) | High (Rust rewrite of ~3.9k lines + Node sidecar) | High (TS main; rewrite IPC) | Very high (Go rewrite, beta) | High + feature-poor | Not applicable to Node app |

## 4. Cross-cutting questions
**transformers.js off Node.** v4.3.0 (Sept 16) has a rewritten C++ WebGPU runtime and runs in browsers, Node, Bun, Deno; ~4x speedup for BERT-style embedding models [18]. In a webview it therefore *can* run, but:
- Safari 26 ships WebGPU on macOS Tahoe 26 [19] (search-summary only; page not fetched). Whether an embedded WKWebView (what Tauri uses) enables it was **not verified**; one weakly sourced result says iOS WKWebView does not by default. A Safari 26 WebGPU device-loss issue with Emscripten output exists [20].
- WebView2 is evergreen Chromium [21] so WebGPU is plausible, but I could not confirm status. Fixed-runtime vs evergreen versioning means Windows behaviour depends on the user's runtime version.
- Model cache (Cache API vs IndexedDB) and WASM fallback details: not found.
- Net: moving embedding to the webview turns a deterministic Node/onnxruntime-node path into a per-OS-webview GPU matrix. With Electron, the same code runs on one pinned Chromium.

**Python bundling.** PyInstaller onefile unpacks every launch; signed onefile binaries have crashed on Apple Silicon with "mapped file has no Team ID" (issue closed "not planned") [14]. Fixes commonly reported: avoid onefile, sign every nested binary with hardened runtime. `python-build-standalone` (Astral, relocatable, Py 3.10-3.15) is the better bundling base [22]. None of this depends on Electron vs Tauri: the sidecar must be signed and notarized either way. Concrete sidecar sizes/Nuitka numbers: not found.

**WebKit rendering risk.** No credible fetched 2025-26 migration report on WKWebView/WebView2 bugs. Only anecdotal: Fluxzy's Electron→Tauri move cut the Windows installer ~190→~55 MB and reduced RAM on macOS/Linux (search snippet, post not fetched) [23]. Rendering divergence risk is real by construction (three engines, macOS-version-tied WebKit) but unquantified here.

**Windows DWM caption tweaks.** Tauri supports `decorations:false`, transparency, and macOS titlebar tweaks [24]; a specific DWM caption-colour API was not found. It would need Rust calls to `DwmSetWindowAttribute` (our current `setTitleBarOverlay` use, main.js:270,2106, is Electron-specific).

## 5. Recommendation per app
**Masora (Electron shell → bundled Python :8911 + Next.js :3210; window loads localhost).** Stay on Electron for now; bump to 43/44. Reasoning: the window is a thin shell over a localhost server, so the "shell" is where Tauri would save size (drop Chromium), but the bundle is dominated by Python + Next.js runtime, which Tauri does not shrink. Tauri would add: a sidecar per target triple [16], Windows force-exit during update [15], a new updater signing key regime, and the WKWebView/WebView2 rendering matrix for a Next.js UI that is today tested only in Chromium. **Best candidate for a later Tauri spike** because it has no Node main-process logic to port (only window, updater, process management, tray).
**zevet (this repo).** Stay on Electron. Reasoning: it is a Node host (3.9k-line main, ~94 IPC handlers, ELECTRON_RUN_AS_NODE helpers, safeStorage, native onnxruntime-node). Under Tauri you would ship a Node sidecar anyway (losing the size win), reimplement safeStorage on keyring, and move IPC to Rust commands. Electrobun keeps TypeScript but is beta and its Windows floor is Win 11 [8]. Wails 3 is a Go rewrite on beta [5].
**Zevet Voice (Python dictation, not Electron).** Do not adopt a Rust/Go/Bun shell; there is no Electron to leave. If a richer settings UI is wanted, spike pywebview (6.2.1) [7] since it embeds in the existing Python process with no sidecar. Otherwise keep the current UI.

## 6. Migration/upgrade plan sketch (effort = engineer-days, my estimates, unmeasured)
1. **Now: Electron 38 → 43/44** for zevet and Masora (2-4 d each): check electron-builder 25 compatibility, `safeStorage`, `setTitleBarOverlay`, ELECTRON_RUN_AS_NODE behaviour, onnxruntime-node ABI, notarization run, updater smoke (`smoke:mac`, `smoke:win` scripts exist). Then keep within 3 majors (8-week cadence [1]).
2. **Optional Masora Tauri spike (5-8 d, timeboxed):** hello-world shell loading localhost, Python as `externalBin` for both triples, signed+notarized DMG and NSIS, updater with `passive` mode, tray, DWM caption. Measure: installer MB, idle RSS, cold start, WebView2/WKWebView rendering diffs on the real Next.js UI.
3. **Only if spike wins**, full Masora port: ~3-5 weeks (Rust window/tray/updater/process supervisor, CI signing changes, update-channel migration since Electron→Tauri users need a bridging release).
4. **zevet**: no migration planned. Revisit only if Node-in-main is removed (e.g. all logic moved to the hub server).
5. **Voice**: none; optional pywebview UI spike 2-3 d.

## 7. What would reverse the recommendation
- The spike shows Masora installer < ~50% of Electron's and idle RSS clearly lower on our real UI, with no WKWebView/WebView2 rendering regressions → migrate Masora.
- Electron upgrades prove painful (electron-builder 25 incompatibility, ABI breaks) making a rewrite comparable in cost.
- Customer complaints about installer size or RAM that are attributable to Chromium (we have no such data yet).
- Verified WebGPU in macOS WKWebView + WebView2 with transformers.js embedding parity → then zevet's embedding could leave Node, weakening the main reason zevet needs a Node host (the other reasons remain).
- Electrobun leaving beta with a documented signing/notarization and Windows 10 story, or Wails 3 reaching stable (both currently beta) [4][5].
- Tauri 3 (alpha now [3]) changing the updater/sidecar model materially, for better or worse.
- A supply-chain/security event in Chromium/Electron cadence we can't keep up with (we are already behind).

## Sources (all URLs were fetched by a research subagent or me on 2026-09-28 unless marked search-only)
[1] https://registry.npmjs.org/electron and https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/electron-timelines.md
[2] https://registry.npmjs.org/@tauri-apps%2Fcli and https://registry.npmjs.org/@tauri-apps%2Fapi
[3] https://index.crates.io/ta/ur/tauri and https://index.crates.io/ta/ur/tauri-plugin-updater
[4] https://github.com/blackboardsh/electrobun/releases and https://registry.npmjs.org/electrobun
[5] https://github.com/wailsapp/wails/releases/tag/v3.0.0-beta.26 and https://github.com/wailsapp/wails
[6] https://registry.npmjs.org/@neutralinojs%2Fneu (CLI package only)
[7] https://pypi.org/project/pywebview/ and https://pypi.org/pypi/pywebview/json
[8] https://github.com/blackboardsh/electrobun and https://raw.githubusercontent.com/blackboardsh/electrobun/main/README.md
[9] https://github.com/neutralinojs/neutralinojs
[10] https://tech-insider.org/tauri-vs-electron-2026/ (search snippet only, page not opened; hello-world benchmark)
[11] https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/ and https://rustify.rs/articles/rust-tauri-vs-electron-2026 (search snippets only)
[12] https://github.com/r0x0r/pywebview
[13] https://github.com/tauri-apps/tauri/issues/5889 (search-only)
[14] https://github.com/pyinstaller/pyinstaller/issues/7937 ; docs claims via search-only https://pyinstaller.org/en/stable/usage.html
[15] https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/plugin/updater.mdx
[16] https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/develop/sidecar.mdx
[17] https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/concept/architecture.mdx
[18] https://github.com/huggingface/transformers.js/releases
[19] https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ (search-only)
[20] https://github.com/ocornut/imgui/issues/9103 (search-only)
[21] https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version (search-only)
[22] https://github.com/astral-sh/python-build-standalone
[23] https://www.fluxzy.io/resources/blogs/electron-to-tauri-migration-fluxzy-desktop (search-only)
[24] https://raw.githubusercontent.com/tauri-apps/tauri-docs/v2/src/content/docs/learn/window-customization.mdx
