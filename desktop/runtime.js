// The small differences between a shell launch and an installed desktop app.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");

/** Finder gives applications a minimal PATH. Restore only PATH from the user's
 * login shell: importing its entire environment would also change which team
 * or credentials the desktop uses. The fallback covers Homebrew and native
 * Claude installs even when a shell profile is broken or waits for input. */
function preparePath({ platform = process.platform, env = process.env, home = os.homedir(),
  execFileImpl = execFile, timeoutMs = 3000 } = {}) {
  if (platform !== "darwin") return Promise.resolve();
  const inherited = env.PATH || "";
  const fallback = [path.posix.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const merge = (...lists) => [...new Set(lists.flatMap((s) => s.split(":"))
    // Relative/empty entries would execute a program from the opened repo.
    .filter((s) => path.posix.isAbsolute(s)))].join(":");
  env.PATH = merge(inherited, fallback.join(":"));

  let loginShell = env.SHELL;
  if (!loginShell) {
    try { loginShell = os.userInfo().shell; } catch { /* Use the macOS default. */ }
  }
  if (!loginShell || !path.posix.isAbsolute(loginShell)) loginShell = "/bin/zsh";

  return new Promise((resolve) => {
    let finished = false;
    let child;
    const finish = (stdout) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const framed = typeof stdout === "string" ? stdout.split("\0") : [];
      if (framed.length >= 3) env.PATH = merge(framed[1].replace(/\r?\n$/, ""), inherited, fallback.join(":"));
      resolve();
    };
    // Bound the startup even if a profile launches a child that keeps stdout
    // open after the shell is killed. A late callback must not change PATH.
    const timer = setTimeout(() => {
      finish();
      try { child?.kill("SIGKILL"); } catch { /* Already gone. */ }
    }, timeoutMs);
    try {
      // printenv keeps this compatible with fish's list-valued PATH as well as
      // zsh/bash. NUL framing ignores banners printed by a shell profile.
      child = execFileImpl(loginShell, ["-ilc", "/usr/bin/printf '\\0'; /usr/bin/printenv PATH; /usr/bin/printf '\\0'"], {
        env: { ...env }, cwd: home, encoding: "utf8", timeout: timeoutMs,
        killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      }, (err, stdout) => finish(err ? undefined : stdout));
    } catch {
      finish();
    }
  });
}

/** Client modules live OUTSIDE app.asar in a packaged app. A checkout has a
 * different layout; neither is the hub's installed update directory. */
function clientFile(name, { clientDir, resourcesPath = process.resourcesPath, desktopDir = __dirname } = {}) {
  const candidates = [
    clientDir && path.join(clientDir, name),
    resourcesPath && path.join(resourcesPath, "client", name),
    path.join(desktopDir, "..", "client", name),
  ];
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

/** First desktop install needs the bundled client without a separate setup
 * script. Copy it to the normal update directory so hook paths survive moving
 * the app out of a disk image. Existing updated clients stay in place. */
function installerPath(options) {
  const installed = path.join(options.clientDir, "install.mjs");
  if (fs.existsSync(installed)) return installed;
  const source = clientFile("install.mjs", options);
  if (!source) return null;
  const sourceDir = path.dirname(source);
  fs.mkdirSync(options.clientDir, { recursive: true });
  // Install the entry point last; an interrupted copy can be retried next time.
  const names = fs.readdirSync(sourceDir).filter((name) => name.endsWith(".mjs") && name !== "install.mjs");
  names.push("install.mjs");
  for (const name of names) {
    const dest = path.join(options.clientDir, name);
    const temp = `${dest}.${randomUUID()}.tmp`;
    try {
      fs.copyFileSync(path.join(sourceDir, name), temp);
      fs.renameSync(temp, dest);
    } finally {
      try { fs.unlinkSync(temp); } catch { /* Renamed or never created. */ }
    }
  }
  return installed;
}

module.exports = { preparePath, clientFile, installerPath };
