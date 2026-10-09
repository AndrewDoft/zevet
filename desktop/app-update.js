// Keeps the installed zevet app in step with the published one.
//
// Andrew: *"every machine should auto-update when you release a new version."*
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT electron-updater
//
// It was rejected when zevet was unsigned (Squirrel.Mac refuses an unsigned
// replacement bundle). zevet is signed now, but the hand-rolled updater stays:
// it shares its shape with client/updater.mjs, and the trust model below is
// its own.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS TRUSTED, AND WHY
//
// 1. The feed is signed (Ed25519, key pinned in ./update-signing.js, domain
//    "zevet-update-v1"). version / file / sha256 / size are read ONLY from the
//    signed payload; the legacy top-level fields exist for already-installed
//    clients and are ignored here. An unsigned, badly signed or untrusted-key
//    feed is rejected with no fallback. So a compromised download host can no
//    longer swap the .exe and the number next to it: it cannot sign.
// 2. The sha256 then binds the signed feed to the exact installer bytes.
// 3. Before an installer is offered, its publisher is checked (Authenticode
//    CN=Andrew Doft on Windows, Developer ID team 27C8FVB83B on macOS). That
//    check is enforced when THIS running app carries the same publisher and
//    is otherwise log-only, so unsigned dev builds and CI proofs still work.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT ACTUALLY DOES, PER PLATFORM
//
//   Windows  Downloads the NSIS installer, verifies it, and either on a click
//            ("Restart now": /S plus --force-run, then quits) or silently as
//            the app quits on its own (/S, no --force-run, no relaunch — see
//            installOnQuit()). The installer replaces the app in place.
//            SmartScreen is not consulted for a process the app spawned.
//
//   macOS    Downloads the .dmg and verifies it. If `bundlePath` was given and
//            its parent looks writable (canSelfReplaceMac()), it mounts the
//            image, `ditto`s the .app over the running bundle's own path, and
//            unmounts — the same idea as Windows, run as one detached shell
//            command so it survives this process quitting mid-swap. This is
//            NOT the quarantine-stripping move the header above warns against:
//            a file this app downloaded itself carries no quarantine
//            attribute in the first place. ⚠️ UNVERIFIED ON REAL HARDWARE —
//            there is no Mac to run it on; see _macReplaceSteps and its tests.
//            Whenever `bundlePath` is not set — every build before this one —
//            it falls back to the original behaviour: OPEN the .dmg and let
//            the person drag it to Applications, once, like every other
//            unsigned Mac app they have.
//
//   Linux    Only an AppImage that knows its own path ($APPIMAGE, set by the
//            AppImage runtime; electron-updater's AppImageUpdater reads the same
//            variable). Downloads the new .AppImage, verifies it like the others,
//            copies it beside the old one and renames it over it (atomic; the
//            running copy keeps its inode), then relaunches once this process has
//            exited. Anything else (deb, a tarball, a dev checkout) has no
//            $APPIMAGE and gets { ok: false } rather than a guess.
//            ⚠️ UNVERIFIED ON REAL HARDWARE: the swap is unit-tested against a
//            temp directory; no Linux desktop has run it.
//
// Nothing here is on the path of anything the user is doing: the check is on a
// timer, the download is a background stream, and the only blocking step is a
// button — except installOnQuit(), which runs with no button at all, on an
// app that was already leaving.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const kit = require("@masora/desktop-kit");
const { UPDATE_DOMAIN, PINNED_KEYS } = require("./update-signing.js");
const { STATE_FILE: ROLLBACK_FILE } = require("./update-rollback.js");
const { UpdaterCore, MAX_BYTES, EVERY_MS, compareVersions, platformKey, safeArtifactName, artifactUrl } = kit;

/** Where the manifest lives when nothing says otherwise.
 *
 *  ⚠️ THE PUBLIC DOWNLOAD HOST, NOT THE HUB, and that is deliberate. The
 *  artifacts are already there — it is what the landing page links to — and a
 *  machine that has zevet installed but has not been pointed at a hub yet
 *  still gets updates. Putting 100 MB installers on the team's hub would also
 *  make every team run a file server to stay current. */
const DEFAULT_FEED = "https://usemasora.com/download/zevet-latest.json";

/** The message check() turns back into "current": a withdrawn build is not an error to show. */
const WITHDRAWN = "this version was withdrawn after it failed to start";

/** Must agree with the artifact names generated by desktop/package.json. */
const ARTIFACT_SUFFIXES = {
  "win32-x64": "windows-x64-setup.exe",
  "darwin-arm64": "macos-arm64.dmg",
  "win32-arm64": "windows-arm64-setup.exe",
  "linux-x64": "linux-x64.AppImage",
};

/** What a feed's file names may end in: the kit's default (exe, dmg) plus the AppImage. */
const ARTIFACT_EXTS = /\.(exe|dmg|AppImage)$/i;

/**
 * Is this JSON a manifest, and does it describe THIS machine? Zevet's artifacts
 * are named `zevet-<version>-<suffix>` (ARTIFACT_SUFFIXES); the checks are the
 * kit's. Returns `{ error }` or `{ version, entry }`.
 */
function readManifest(json, key) {
  return kit.readManifest(json, key, {
    artifactName: (version, k) => (ARTIFACT_SUFFIXES[k] ? `zevet-${version}-${ARTIFACT_SUFFIXES[k]}` : null),
    exts: ARTIFACT_EXTS,
  });
}

/**
 * The updater.
 *
 * `fetchImpl` and `dir` are injected so the tests can drive the whole thing
 * against a real local HTTP server writing into a temp directory — including
 * the cases that matter, which are a feed that lies.
 */
/** What the Windows installer is run with. See install()'s header for why
 *  each one is there \u2014 `--force-run` in particular is load-bearing and its
 *  absence is silent. */
const INSTALL_ARGS = ["--updated", "/S", "--force-run"];

/** Same, for the quit path: silent, but deliberately WITHOUT --force-run.
 *  The app is already on its way out on its own; relaunching it would fight
 *  whatever the person or the OS just asked for (close the window, log off). */
const QUIT_INSTALL_ARGS = ["--updated", "/S"];

/**
 * Neither INSTALL_ARGS nor QUIT_INSTALL_ARGS names a scope or a directory,
 * which leaves NSIS's own multiUser.nsh to decide both from the registry --
 * and the registry is a claim about where zevet was last installed, not a
 * fact about where THIS running copy actually lives. A per-machine entry
 * registered anywhere else (masora2's sibling-install test harness did this
 * on Andrew's own machine, registering a per-machine copy in a temp
 * directory with `/allusers /D=<temp>`) makes multiUser.nsh land every
 * silent update THERE, while the app that is actually running --
 * `execPath`, always the real, currently-executing zevet.exe -- sits
 * untouched, forever offering the same "update ready" that never applies.
 *
 * `execPath`'s own directory is not a claim, it is where this process
 * loaded from, so it is the one thing here that cannot be stale. Passing it
 * explicitly, as its own scope and its own /D=, means multiUser.nsh has
 * nothing left to decide -- the update always lands in the copy that asked
 * for it.
 *
 * ponytail: "per-user" is detected by directory shape (under
 * %LOCALAPPDATA%\Programs), the same shape multiUser.nsh's own per-user
 * default and installer.nsh's customInit both already assume elsewhere in
 * this codebase -- not by reading back which registry hive this install
 * actually used. A real per-user install at a fully custom, interactively-
 * chosen directory (allowToChangeInstallationDirectory: true) would be
 * misread as per-machine here and asked to elevate; expand this to read the
 * HKCU uninstall entry for this app's own GUID if that combination is ever
 * actually seen in the wild.
 */
/**
 * Why this executable is NOT a place an installer may write to, or null if it is
 * a real install. A dev Electron (`...\node_modules\electron\dist\electron.exe`) or anything inside a
 * git checkout/worktree is somebody's working tree: an update "installed" there
 * turns the tree into the app (2026-10-08: a harness-launched dev Electron
 * installed 0.2.13x into C:\dev\...\electron\dist, rewrote the HKLM uninstall entry and
 * both Start Menu shortcuts, and every update since landed there).
 */
function misplacedReason(execPath) {
  const w = path.win32;
  const dir = w.dirname(execPath);
  if (w.normalize(dir).toLowerCase().split(w.sep).includes("node_modules")) return `${dir} is inside node_modules`;
  for (let d = dir, i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(w.join(d, ".git"))) return `${dir} is inside a git checkout (${d})`;
    } catch {
      // unreadable ancestor: treat as not a checkout
    }
    const up = w.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** Where a misplaced copy's update goes instead: the installer's own default, per-machine. */
function defaultInstallDir(env = process.env) {
  return path.win32.join(env.ProgramFiles || "C:\Program Files", "zevet");
}

function winInstallLocation(execPath) {
  const bad = misplacedReason(execPath);
  if (bad) return { dir: defaultInstallDir(), scope: "/allusers", misplaced: bad };
  // path.win32, not the ambient `path`: this logic is Windows-only by
  // definition (NSIS, %LOCALAPPDATA%, backslashes), but the SAME test file
  // that exercises it runs on both the Windows and the macOS CI leg (see
  // build.yml's shared "Test" step) -- the ambient module is POSIX's on the
  // Mac runner, which does not know "C:\Users\..." is even absolute.
  const w = path.win32;
  const dir = w.dirname(execPath);
  const localAppData = process.env.LOCALAPPDATA || "";
  const norm = (p) => w.resolve(p).toLowerCase();
  const perUserRoot = localAppData ? w.join(localAppData, "Programs") : null;
  const isPerUser = perUserRoot !== null && (norm(dir) === norm(perUserRoot) || norm(dir).startsWith(norm(perUserRoot) + w.sep));
  return { dir, scope: isPerUser ? "/currentuser" : "/allusers" };
}

/**
 * Appends the running install's own scope and directory to a base NSIS
 * silent-install arg list. NSIS requires `/D=` to be UNQUOTED and the LAST
 * parameter on the command line (it takes everything after `=` to the end
 * of the line as the path, which is exactly why a switch after it, or
 * quotes around it, corrupts it) -- so nothing may be appended after this
 * call's result, and install()/installOnQuit() spawn it with
 * `windowsVerbatimArguments: true` so Node does not wrap the directory in
 * its own quotes the moment it contains a space (every other spawn call in
 * this codebase that needs `/D=` avoids it for exactly this reason; this one
 * cannot, so it takes the verbatim-arguments route instead).
 */
function winInstallArgs(baseArgs, execPath) {
  const { scope, dir } = winInstallLocation(execPath);
  return [...baseArgs, scope, `/D=${dir}`];
}

/**
 * The signed payload of a feed, or `{ error }`. `keys` is injectable for tests
 * and for loopback proofs; production uses the pinned set.
 */
function readSignedFeed(json, keys = PINNED_KEYS) {
  if (!json || typeof json !== "object") return { error: "the feed is not an object" };
  try {
    return { payload: kit.verifyFeed(json, UPDATE_DOMAIN, keys, "payload") };
  } catch (err) {
    return { error: `the feed is not validly signed: ${err.message}` };
  }
}

/**
 * Trust override for the loopback update proofs (scripts/test-macos-autoupdate
 * .mjs signs a throwaway feed with a throwaway key). Honoured ONLY when the
 * feed URL is loopback, so it can never redirect trust for the real feed.
 * `ZEVET_APP_FEED_TRUSTED_KEY` is `<key id>:<raw ed25519 key, base64>`.
 */
function loopbackProofKeys(feedUrl, env = process.env) {
  const spec = env.ZEVET_APP_FEED_TRUSTED_KEY;
  if (!spec || !feedUrl) return undefined;
  try {
    const u = new URL(feedUrl);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return undefined;
  } catch {
    return undefined;
  }
  const i = spec.indexOf(":");
  return i > 0 ? { [spec.slice(0, i)]: spec.slice(i + 1) } : undefined;
}

/** Who must have signed an installer. */
const PUBLISHER = {
  win32: { label: "Authenticode CN=Andrew Doft", test: (who) => /(^|, )CN=Andrew Doft(,|$)/.test(who || "") },
  darwin: { label: "Developer ID team 27C8FVB83B", test: (who) => who === "27C8FVB83B" },
};

const run = (cmd, args, env) =>
  new Promise((resolve) =>
    execFile(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 60000, env }, (error, stdout, stderr) =>
      resolve({ error, out: `${stdout || ""}${stderr || ""}` }),
    ),
  );

/**
 * What signature does this file carry? `{ valid, publisher }`; publisher is
 * the Authenticode subject (Windows) or the Team ID (macOS), null if unsigned.
 * Windows reads an installer, macOS a .dmg (mounted read-only) or a .app.
 */
async function inspectSignature(platform, target) {
  if (platform === "win32") {
    const { PSModulePath, ...env } = process.env; // a leaked pwsh module path breaks 5.1
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      '$s = Get-AuthenticodeSignature -LiteralPath $env:ZEVET_SIG_TARGET; "$($s.Status)|$($s.SignerCertificate.Subject)"'],
    { ...env, ZEVET_SIG_TARGET: target });
    const [status, subject] = r.out.trim().split("|");
    return { valid: status === "Valid", publisher: subject || null };
  }
  if (platform === "darwin") {
    let app = target;
    let mount = null;
    try {
      if (/\.dmg$/i.test(target)) {
        mount = fs.mkdtempSync(path.join(os.tmpdir(), "zevet-sig-"));
        const at = await run("hdiutil", ["attach", target, "-nobrowse", "-readonly", "-mountpoint", mount]);
        if (at.error) return { valid: false, publisher: null };
        const found = fs.readdirSync(mount).find((n) => n.endsWith(".app"));
        if (!found) return { valid: false, publisher: null };
        app = path.join(mount, found);
      }
      const ver = await run("codesign", ["--verify", "--deep", "--strict", app]);
      const info = await run("codesign", ["-dv", "--verbose=2", app]);
      const team = /TeamIdentifier=(\S+)/.exec(info.out);
      return { valid: !ver.error, publisher: team && team[1] !== "not" ? team[1] : null };
    } finally {
      if (mount) {
        await run("hdiutil", ["detach", mount, "-force"]);
        try { fs.rmdirSync(mount); } catch { /* still mounted; the OS temp sweep gets it */ }
      }
    }
  }
  return { valid: false, publisher: null };
}

/** POSIX single-quote a path for `/bin/sh -c`, so a space in the download
 *  directory or "Andrew's Mac" does not split the command in two. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class AppUpdater extends UpdaterCore {
  constructor(opts) {
    const o = opts || {};
    const platform = o.platform || process.platform;
    super({
      currentVersion: o.currentVersion,
      feedUrl: String(o.feedUrl || DEFAULT_FEED),
      domain: UPDATE_DOMAIN,
      // Keys a feed may be signed with. Only tests and loopback proofs pass their own; see main.js.
      trustedKeys: o.trustedKeys || PINNED_KEYS,
      feedField: "payload",
      platform,
      platformKey: o.platformKey,
      dir: o.dir,
      fetchImpl: o.fetchImpl,
      downloadTimeoutMs: o.downloadTimeoutMs,
      onStatus: o.onStatus,
      log: o.log,
      artifactName: (version, k) => (ARTIFACT_SUFFIXES[k] ? `zevet-${version}-${ARTIFACT_SUFFIXES[k]}` : null),
      exts: ARTIFACT_EXTS,
      state: { manual: platform === "darwin" },
      steps: {
        restart: () => this._restart(),
        onQuit: () => this._onQuit(),
        canOnQuit: () => this.platform === "win32" || (this.platform === "darwin" && this.canSelfReplaceMac()) || this.canSelfReplaceAppImage(),
        publisherProblem: (file) => this._publisherProblem(file),
      },
    });
    /** update-rollback.js: withdrawn versions, and the record an installer run leaves for the next launch. */
    this.rollback = o.rollback || null;
    this.spawnImpl = o.spawnImpl || spawn;
    /** The running app's own executable path -- ground truth for "where to
     *  update", independent of whatever the registry claims. See
     *  winInstallLocation()'s header. */
    this.execPath = o.execPath || process.execPath;
    /** app.isPackaged. An unpackaged run (`electron .`, every test harness) is a dev copy: it never installs. */
    this.isPackaged = o.isPackaged !== false;
    /** The running AppImage file ($APPIMAGE); only meaningful on linux. */
    this.appImagePath = o.appImagePath !== undefined ? o.appImagePath : process.env.APPIMAGE || null;
    this.openImpl = o.openImpl || null; // set by main.js to shell.openPath
    this.quitImpl = typeof o.quitImpl === "function" ? o.quitImpl : () => {};
    /** The running .app's own path, e.g. /Applications/zevet.app. Only meant
     *  for darwin; see canSelfReplaceMac(). Unset means "keep the manual
     *  drag-to-Applications flow", which is also what every existing caller
     *  that never heard of this option still gets. */
    this.bundlePath = o.bundlePath || null;
    this.inspectImpl = o.inspectImpl || inspectSignature;
  }

  /** winInstallArgs for this process, or a throw when it must not install at all (an unpackaged dev run). */
  _installArgs(base) {
    if (!this.isPackaged) throw new Error("this is an unpackaged dev run; it never installs an update");
    const loc = winInstallLocation(this.execPath);
    if (loc.misplaced) this.log(`running from a non-install location (${loc.misplaced}); installing to ${loc.dir} instead and relaunching from there`);
    return winInstallArgs(base, this.execPath);
  }

  /**
   * Is this installer from the publisher the running app came from? Returns a
   * message when it is not, null when it is or when the check is log-only.
   *
   * Enforced only when the RUNNING app carries the expected publisher: an
   * unsigned dev build (or a CI proof) has nothing to compare against, and
   * refusing there would only break testing. The expected publisher is
   * pinned in PUBLISHER, not read from the running app.
   */
  async _publisherProblem(file) {
    if (this.platform === "win32" && !this.isPackaged) {
      this.log("update skipped: unpackaged dev run");
      return "an unpackaged dev run never installs an update";
    }
    const want = PUBLISHER[this.platform];
    const selfPath = this.platform === "win32" ? this.execPath : this.bundlePath;
    if (!want || !selfPath) {
      this.log("publisher check skipped: no way to inspect this platform's signatures");
      return null;
    }
    const self = await this.inspectImpl(this.platform, selfPath);
    const got = await this.inspectImpl(this.platform, file);
    if (!self.valid || !want.test(self.publisher)) {
      this.log(`publisher check is log-only: the running app is not signed as ${want.label}; installer valid=${got.valid} publisher=${got.publisher}`);
      return null;
    }
    if (!got.valid || !want.test(got.publisher)) {
      return `the installer is not signed as ${want.label} (valid=${got.valid}, publisher=${got.publisher})`;
    }
    return null;
  }

  /** A version update-rollback.js withdrew is never offered again. Read from the artifact name (readManifest's). */
  _withdrawn(file) {
    const m = /^zevet-(.+?)-(?:windows|macos)-/.exec(path.basename(String(file)));
    return Boolean(this.rollback && m && !this.rollback.offerable(m[1]));
  }

  /** A withdrawn installer is never "already downloaded and verified": check() goes on to _download, which refuses
   *  it without fetching 100 MB hourly, and removes one left on disk. */
  _verified(file, entry) {
    return !this._withdrawn(entry.file) && super._verified(file, entry);
  }

  async _download(url, dest, entry) {
    if (this._withdrawn(entry.file)) {
      try { fs.rmSync(dest, { force: true }); } catch { /* the next prune gets it */ }
      throw new Error(WITHDRAWN);
    }
    return super._download(url, dest, entry);
  }

  /** A withdrawn version is not an error the person should see hourly: it is simply not an update. */
  async check() {
    const s = await super.check();
    if (s.error !== WITHDRAWN) return s;
    this._set({ phase: "current", version: null, error: null, canInstall: false });
    return this.status();
  }

  /** The rollback target and the state file outlive every prune. */
  _pruneOldInstallers(keep) {
    super._pruneOldInstallers([...keep, ROLLBACK_FILE, ...(this.rollback ? this.rollback.keepFiles() : [])]);
  }

  /** Right before the Windows installer runs (either path): what the next launch must prove. */
  _beginInstall() {
    if (this.rollback && this.platform === "win32") this.rollback.beginInstall({ to: this.state.version, entry: this._readyEntry });
  }

  /**
   * The platform step behind install() (the kit verifies the download first).
   * Called from a button, never on a timer.
   *
   * Windows quits FIRST and lets the installer relaunch: NSIS cannot replace
   * files a running process holds open, and an installer that succeeds at
   * everything except the .exe leaves a broken install. `detached` plus
   * unref'd stdio is what keeps the child alive across our own exit.
   *
   * \u26a0\ufe0f `--force-run` IS WHAT MAKES IT COME BACK, and it was missing.
   * Andrew: "when you download a new version and hit restart to install it
   * should reopen zevet when the new version installs." It did not - the app
   * vanished and stayed gone, after a button that said restart.
   *
   * The reason is in electron-builder's own NSIS template. zevet ships the
   * ASSISTED installer (`nsis.oneClick: false`), and installSection.nsh ends:
   *
   *     !ifdef ONE_CLICK
   *       ...
   *     !else
   *       # for assisted installer run only if silent, because assisted
   *       # installer has run after finish option
   *       ${if} ${isForceRun}
   *       ${andIf} ${Silent}
   *         !insertmacro doStartApp
   *       ${endIf}
   *     !endif
   *
   * `runAfterFinish: true` in the build config only drives the wizard's finish
   * -page checkbox, and `/S` is precisely the path that never shows it. So a
   * silent assisted install relaunches on `--force-run` and on nothing else.
   *
   * The three flags are electron-updater's own, in its order: `--updated`
   * tells the installer this replaces a running copy (StartApp passes it on
   * to the new process), `/S` is NSIS's silent switch, `--force-run` is the
   * relaunch. There is no race with the single-instance lock: NSIS cannot
   * replace the .exe until this process is gone, so by the time it reaches
   * doStartApp the lock is long released.
   *
   * Two more are appended by winInstallArgs (see its header): an explicit
   * scope and `/D=<this running install's own directory>`, so a stray
   * per-machine registry entry elsewhere can never steal the update away
   * from the copy that is actually running.
   */
  async _restart() {
    if (this.platform === "win32") {
      let child;
      try {
        this._beginInstall();
        child = this.spawnImpl(this.state.file, this._installArgs(INSTALL_ARGS), {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          // See winInstallArgs's header: /D= must reach NSIS unquoted.
          windowsVerbatimArguments: true,
        });
        if (child && typeof child.unref === "function") child.unref();
      } catch (err) {
        return { ok: false, error: `could not start the installer: ${err.message}` };
      }
      // A beat, so the installer is running before the app it replaces is not.
      const timer = setTimeout(() => this.quitImpl(), 600);
      /* ⚠️ THE ASYNCHRONOUS SPAWN FAILURE, which the try/catch above cannot
         see. On Windows the ordinary cause is antivirus quarantining or
         locking the freshly downloaded .exe between verification and this
         spawn. It arrives as an 'error' EVENT, and an EventEmitter with no
         'error' listener rethrows — in the main process that is fatal, and
         there is no uncaughtException handler anywhere in desktop/. So the
         person clicks "restart to install", is told {ok:true, restarting:true},
         and the app disappears with the update never applied.

         agent-console.js § startConsole handles this exact hazard for the
         agent it spawns, deliberately and with a comment. This call site did
         not. Cancelling the quit matters as much as catching the throw: there
         is no point closing the app to make way for an installer that is not
         going to run. */
      if (child && typeof child.on === "function") {
        child.on("error", (err) => {
          clearTimeout(timer);
          const error = `could not start the installer: ${err && err.message ? err.message : String(err)}`;
          this._set({ phase: "error", canInstall: true, error });
        });
      }
      return { ok: true, restarting: true };
    }

    if (this.platform === "darwin") {
      // Self-replace when the bundle looks writable (see canSelfReplaceMac);
      // otherwise fall back to the manual drag-to-Applications flow this
      // always did, and still does on every build that never set bundlePath.
      if (this.canSelfReplaceMac()) {
        try {
          this._spawnMacReplace(this.state.file, { relaunch: true });
        } catch (err) {
          return { ok: false, error: `could not start the update: ${err.message}` };
        }
        // Mirrors the Windows beat above: let the detached script get going
        // before the bundle it is about to overwrite stops running.
        setTimeout(() => this.quitImpl(), 600);
        return { ok: true, restarting: true };
      }

      // See the header: the image is opened, not applied. Saying `ok: true`
      // with `manual: true` rather than pretending the update is done.
      if (!this.openImpl) return { ok: false, error: "no disk image opener is available" };
      try {
        // Electron shell.openPath resolves with an error string on failure;
        // it does not reject the promise for every unsuccessful open.
        const error = await this.openImpl(this.state.file);
        if (error) return { ok: false, error: `could not open the disk image: ${error}` };
      } catch (err) {
        return { ok: false, error: `could not open the disk image: ${err.message}` };
      }
      return { ok: true, manual: true };
    }

    if (this.platform === "linux") {
      if (!this.canSelfReplaceAppImage()) return { ok: false, error: "not running from an AppImage; install the new one by hand" };
      try {
        this._swapAppImage(this.state.file);
        this._spawnAppImageRelaunch();
      } catch (err) {
        return { ok: false, error: `could not apply the update: ${err.message}` };
      }
      setTimeout(() => this.quitImpl(), 600);
      return { ok: true, restarting: true };
    }

    return { ok: false, error: `${this.platform} builds are not published` };
  }

  /** linux, and $APPIMAGE is an absolute path whose directory is writable. */
  canSelfReplaceAppImage() {
    const f = this.appImagePath;
    if (this.platform !== "linux" || typeof f !== "string" || !path.isAbsolute(f) || f.includes(String.fromCharCode(0))) return false;
    try {
      fs.accessSync(path.dirname(f), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Copy the verified download beside the AppImage, mark it executable, rename it over the old file. */
  _swapAppImage(downloaded) {
    const target = this.appImagePath;
    const staged = `${target}.update`;
    try {
      fs.copyFileSync(downloaded, staged);
      fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, target);
    } catch (err) {
      fs.rmSync(staged, { force: true });
      throw err;
    }
  }

  /** Detached: wait for this process to exit (the single-instance lock), then start the new AppImage. */
  _spawnAppImageRelaunch() {
    const script = `while kill -0 ${Number(process.pid)} 2>/dev/null; do sleep 0.2; done; exec ${shQuote(this.appImagePath)}`;
    const child = this.spawnImpl("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
    if (child && typeof child.unref === "function") child.unref();
    return child;
  }

  /**
   * The platform step behind installOnQuit() (the kit verifies the download and
   * writes the one-shot marker first). Applies the build with NO relaunch, meant to be called
   * once as the app is quitting (main.js's `before-quit`) so the next launch
   * is already the new version. Never on a timer, and never twice for the
   * same build: a marker is written to disk BEFORE the attempt, not after,
   * because a quitting process cannot reliably observe whether an installer
   * it just spawned went on to fail — writing the marker first still counts
   * that as the one try, so a failed silent install falls back to the in-app
   * bar instead of being retried at every future quit forever.
   */
  _onQuit() {
    try {
      if (this.platform === "win32") {
        this._beginInstall();
        const child = this.spawnImpl(this.state.file, this._installArgs(QUIT_INSTALL_ARGS), {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        if (child && typeof child.unref === "function") child.unref();
      } else if (this.platform === "linux") {
        this._swapAppImage(this.state.file);
      } else {
        this._spawnMacReplace(this.state.file, { relaunch: false });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `could not start the install: ${err.message}` };
    }
  }

  /**
   * Whether this build believes it can replace its own bundle in place:
   * darwin, a bundle path configured, and its parent directory writable.
   * False just means "keep the manual drag-to-Applications flow" — which is
   * also what happens whenever nothing ever set bundlePath, i.e. everywhere
   * this shipped before today.
   *
   * Verified on real Apple Silicon hardware (Codemagic mac_mini_m2,
   * codemagic.yaml's macos-autoupdate workflow, scripts/test-macos-autoupdate.mjs):
   * both the silent install-on-quit swap and the "Restart now" relaunch.
   */
  canSelfReplaceMac() {
    if (this.platform !== "darwin" || !this.bundlePath) return false;
    try {
      fs.accessSync(path.dirname(this.bundlePath), fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** The shell steps that swap the .app for the one inside a downloaded
   *  .dmg. They first wait for this process to exit, so nothing is copied
   *  under a live app and `open` can't just re-activate the old one. They
   *  stage the new bundle beside the old one and then swap it in, so no file
   *  from the old version survives and a failed copy leaves the old app
   *  intact. Returned as data so a test can pin them without a Mac. */
  _macReplaceSteps(dmgFile, bundlePath, pid = process.pid) {
    const appName = path.basename(bundlePath);
    const mount = path.join(os.tmpdir(), `zevet-update-${pid}-${Date.now()}`);
    const staged = `${bundlePath}.update`;
    return [
      `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.2; done`,
      `rm -rf ${shQuote(staged)}`,
      ["hdiutil", ["attach", dmgFile, "-nobrowse", "-mountpoint", mount]],
      ["ditto", [path.join(mount, appName), staged]],
      ["hdiutil", ["detach", mount]],
      `rm -rf ${shQuote(bundlePath)}`,
      ["mv", [staged, bundlePath]],
      // Andrew: "on mac when you download a new version it keeps the old. we
      // need it to only have the newest version." This swap only ever touches
      // `bundlePath` itself, so a bundle left somewhere ELSE survives it —
      // a Finder "keep both" from the old manual drag-to-Applications flow
      // ("zevet 2.app"), or a `.update` staging dir orphaned by a previous
      // run that never reached the `mv` above. Checked in both the app's own
      // folder and BOTH ~/Applications and /Applications, since the running
      // bundle can be in either. Never touches `bundlePath` itself — that is
      // the one just installed.
      // Every step here is chained with `&&` (see _spawnMacReplace), and a
      // `for` loop's exit status is whatever its last command's was -- so
      // when there is nothing stray to sweep, the trailing `[ -e "$f" ]`
      // test is false and the loop "fails", silently cancelling the `open`
      // (relaunch) chained after it. `true` pins this step's exit to 0.
      `for d in ${shQuote(path.dirname(bundlePath))} ${shQuote(path.join(os.homedir(), "Applications"))} /Applications; do ` +
        `for f in "$d"/zevet*.app "$d"/zevet*.app.update; do ` +
        `[ -e "$f" ] && [ "$f" != ${shQuote(bundlePath)} ] && rm -rf "$f"; done; done; true`,
    ];
  }

  /** Runs _macReplaceSteps as one detached shell command, the same reason the
   *  Windows installer above is spawned detached before this process exits:
   *  the swap has to survive this app quitting. */
  _spawnMacReplace(dmgFile, { relaunch }) {
    const steps = this._macReplaceSteps(dmgFile, this.bundlePath);
    const parts = steps.map((s) => (typeof s === "string" ? s : [s[0], ...s[1]].map(shQuote).join(" ")));
    if (relaunch) parts.push(["open", shQuote(this.bundlePath)].join(" "));
    const child = this.spawnImpl("/bin/sh", ["-c", parts.join(" && ")], {
      detached: true,
      stdio: "ignore",
    });
    if (child && typeof child.unref === "function") child.unref();
    return child;
  }

}

module.exports = {
  misplacedReason,
  defaultInstallDir,
  AppUpdater,
  INSTALL_ARGS,
  QUIT_INSTALL_ARGS,
  winInstallLocation,
  winInstallArgs,
  EVERY_MS,
  compareVersions,
  platformKey,
  safeArtifactName,
  artifactUrl,
  readManifest,
  readSignedFeed,
  loopbackProofKeys,
  PUBLISHER,
  DEFAULT_FEED,
  MAX_BYTES,
};
