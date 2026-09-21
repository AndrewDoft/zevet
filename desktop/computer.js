"use strict";

// computer.js — the platform layer for computer use: screen capture, mouse
// clicks, keyboard input. Pure and testable on purpose: every export here
// BUILDS a { command, args } pair (or parses one back), and none of them
// spawns anything. zevet-mcp.js is the only thing that actually runs these.
//
// SECURITY POSTURE. `type_text` and `press_key` carry text and key names
// chosen by a model, i.e. UNTRUSTED input flowing into a command line. Two
// separate escaping problems stack here:
//
//   1. The OS argv/shell layer — the concern agent-console.js's
//      `unsafeForCmd` exists for. We avoid it by construction: every command
//      built here is run with an explicit argv array via execFile (no
//      shell), so there is no cmd.exe re-parsing step to get wrong. The one
//      place free text still lands inside a *script* (PowerShell's
//      -Command argument, an osascript -e argument) needs its own escaping —
//      see (2).
//   2. The scripting-language layer. PowerShell single-quoted strings are
//      literal (no $-interpolation), so the only escape needed is doubling
//      embedded `'`. AppleScript double-quoted strings need `\` and `"`
//      escaped. Windows SendKeys additionally treats +^%~(){} as syntax
//      *inside* the string it receives — escaped separately below, because
//      it is a THIRD layer on top of PowerShell's own quoting.
//
// Where escaping would have to guess (embedded control characters, an
// unrecognized key name, an out-of-range coordinate), this refuses instead —
// the same discipline unsafeForCmd uses: refuse rather than escape-and-hope.

const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

/** PowerShell single-quoted strings are literal; the only metacharacter is
 *  the quote itself, escaped by doubling. */
function escapePowerShellSingleQuoted(s) {
  return s.replace(/'/g, "''");
}

/** AppleScript double-quoted strings: backslash and quote need escaping. */
function escapeAppleScriptString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// SendKeys' own metacharacters. Left un-escaped, `+` `^` `%` `~` start a
// modifier chord (Shift/Ctrl/Alt/Enter), `(` `)` group keys, and `{` `}`
// open/close a special-key token like {ENTER} or {F4} — which is exactly how
// a model asking to type the four characters "%{F4}" would instead send
// Alt+F4 and close a window. Wrapping each one in its own braces is SendKeys'
// documented literal-escape: "{" -> "{{}", "}" -> "{}}", "+" -> "{+}", etc.
const SENDKEYS_SPECIAL = /[+^%~(){}]/g;
function escapeSendKeys(text) {
  return text.replace(SENDKEYS_SPECIAL, (c) => `{${c}}`);
}

/** Control characters have no safe SendKeys/AppleScript representation and
 *  no legitimate reason to be inside typed text — Enter/Tab/etc. go through
 *  press_key instead. Refusing beats guessing what a raw \x07 should do. */
function hasControlChars(text) {
  return /[\u0000-\u001f\u007f]/.test(text);
}

// ---------------------------------------------------------------------------
// Fixed PowerShell snippet for mouse control (P/Invoke). The C# source is a
// constant we wrote, not user input, and it lives in a single-quoted
// PowerShell string, so nothing here needs escaping for untrusted data — only
// the coordinates (validated integers) and flags (from our own allowlist
// below) are interpolated.
// ---------------------------------------------------------------------------

const WIN_MOUSE_SRC =
  "using System; using System.Runtime.InteropServices; " +
  "public class ZevetMouse { " +
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); ' +
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint data, UIntPtr extra); ' +
  "}";

const WIN_MOUSE_FLAGS = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

// ---------------------------------------------------------------------------
// captureCommand
// ---------------------------------------------------------------------------

/**
 * Build a full-screen PNG capture command.
 *
 * Linux is deliberately unimplemented, not defaulted: `scrot`,
 * `gnome-screenshot`, `grim` (Wayland) and ImageMagick's `import` are all
 * plausible, and none of them is reliably preinstalled across distros —
 * picking one would fail silently and unpredictably on whichever machine
 * lacks it. Refusing surfaces that choice instead of hiding it.
 */
function captureCommand({ outputPath, platform = process.platform } = {}) {
  const dest = outputPath || path.join(os.tmpdir(), `zevet-capture-${randomUUID()}.png`);

  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; " +
      "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
      "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); " +
      `$bmp.Save('${escapePowerShellSingleQuoted(dest)}',[System.Drawing.Imaging.ImageFormat]::Png); ` +
      "$g.Dispose(); $bmp.Dispose()";
    return {
      ok: true,
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      outputPath: dest,
    };
  }

  if (platform === "darwin") {
    // -x: no camera shutter sound. -t png: force the format regardless of
    // the user's default screenshot type.
    return { ok: true, command: "screencapture", args: ["-x", "-t", "png", dest], outputPath: dest };
  }

  return {
    ok: false,
    error:
      'no default screenshot tool for Linux: "scrot", "gnome-screenshot", "grim" and ' +
      '"import" (ImageMagick) are all plausible depending on the desktop/display server, ' +
      "but none can be assumed installed. Refusing rather than guessing.",
  };
}

// ---------------------------------------------------------------------------
// screenSizeCommand / parseScreenSize
// ---------------------------------------------------------------------------

/** Same coordinate space captureCommand's screenshot is taken in, so a click
 *  computed against the screenshot lands where it looks like it should. */
function screenSizeCommand({ platform = process.platform } = {}) {
  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
      'Write-Output "$($b.Width)x$($b.Height)"';
    return { ok: true, command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }

  if (platform === "darwin") {
    return {
      ok: true,
      command: "osascript",
      args: ["-e", 'tell application "Finder" to get bounds of window of desktop'],
    };
  }

  return { ok: false, error: `no screenSize support for platform "${platform}"` };
}

function parseScreenSize(stdout, { platform = process.platform } = {}) {
  const text = String(stdout).trim();

  if (platform === "win32") {
    const m = /^(\d+)x(\d+)$/.exec(text);
    if (!m) return { ok: false, error: `could not parse screen size from "${text}"` };
    return { ok: true, width: Number(m[1]), height: Number(m[2]) };
  }

  if (platform === "darwin") {
    // Finder prints "0, 0, 1920, 1080" (left, top, right, bottom).
    const m = /^(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)$/.exec(text);
    if (!m) return { ok: false, error: `could not parse screen size from "${text}"` };
    return { ok: true, width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) };
  }

  return { ok: false, error: `no screenSize support for platform "${platform}"` };
}

// ---------------------------------------------------------------------------
// clickCommand
// ---------------------------------------------------------------------------

function clickCommand({ x, y, button = "left" } = {}, { platform = process.platform } = {}) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return { ok: false, error: "x and y must be integers" };
  }
  // A generous but finite bound: refuses NaN/Infinity/absurd values without
  // pretending to know every real display's extent.
  if (Math.abs(x) > 65535 || Math.abs(y) > 65535) {
    return { ok: false, error: "x/y out of range" };
  }
  if (!["left", "right", "middle"].includes(button)) {
    return { ok: false, error: `unsupported button "${button}"` };
  }

  if (platform === "win32") {
    const flags = WIN_MOUSE_FLAGS[button];
    const script =
      `$src = '${WIN_MOUSE_SRC}'; ` +
      "Add-Type -TypeDefinition $src -Language CSharp; " +
      `[ZevetMouse]::SetCursorPos(${x},${y}); ` +
      `[ZevetMouse]::mouse_event(${flags.down},0,0,0,[UIntPtr]::Zero); ` +
      `[ZevetMouse]::mouse_event(${flags.up},0,0,0,[UIntPtr]::Zero)`;
    return { ok: true, command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }

  if (platform === "darwin") {
    // System Events' "click at" is a plain left click; there is no reliable
    // System-Events-only right/middle click, so those are refused rather
    // than faked with a Ctrl-click that only sometimes behaves like one.
    if (button !== "left") {
      return { ok: false, error: `only "left" click is supported via System Events on macOS, got "${button}"` };
    }
    const script = `tell application "System Events" to click at {${x}, ${y}}`;
    return { ok: true, command: "osascript", args: ["-e", script] };
  }

  return { ok: false, error: `no click support for platform "${platform}"` };
}

// ---------------------------------------------------------------------------
// typeCommand
// ---------------------------------------------------------------------------

function typeCommand({ text } = {}, { platform = process.platform } = {}) {
  if (typeof text !== "string") return { ok: false, error: "text must be a string" };
  if (hasControlChars(text)) {
    return {
      ok: false,
      error: "refusing to type control characters — use press_key for Enter/Tab/etc. instead",
    };
  }

  if (platform === "win32") {
    const escaped = escapePowerShellSingleQuoted(escapeSendKeys(text));
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
    return { ok: true, command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }

  if (platform === "darwin") {
    const escaped = escapeAppleScriptString(text);
    const script = `tell application "System Events" to keystroke "${escaped}"`;
    return { ok: true, command: "osascript", args: ["-e", script] };
  }

  return { ok: false, error: `no type_text support for platform "${platform}"` };
}

// ---------------------------------------------------------------------------
// keyCommand
// ---------------------------------------------------------------------------

const WIN_KEY_MAP = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  esc: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  del: "{DELETE}",
  insert: "{INSERT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  space: " ",
  f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
  f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
};
// SendKeys cannot send the Windows key at all — there is no VK for it in this
// API — so "win"/"cmd" as a modifier is refused rather than silently dropped.
const WIN_MODIFIERS = { ctrl: "^", control: "^", alt: "%", shift: "+" };

const MAC_KEY_CODES = {
  enter: 36, return: 36,
  tab: 48,
  escape: 53, esc: 53,
  backspace: 51, delete: 51,
  insert: 114,
  home: 115, end: 119,
  pageup: 116, pagedown: 121,
  up: 126, down: 125, left: 123, right: 124,
  space: 49,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MAC_MODIFIERS = {
  ctrl: "control down", control: "control down",
  alt: "option down", option: "option down",
  shift: "shift down",
  cmd: "command down", command: "command down",
};

function splitKey(key) {
  const parts = String(key)
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  return { base: parts[parts.length - 1], mods: parts.slice(0, -1) };
}

function keyCommand({ key } = {}, { platform = process.platform } = {}) {
  if (typeof key !== "string" || !key.trim()) {
    return { ok: false, error: "key must be a non-empty string" };
  }
  const split = splitKey(key);
  if (!split) return { ok: false, error: "key must be a non-empty string" };
  const { base, mods } = split;

  if (platform === "win32") {
    let modPrefix = "";
    for (const m of mods) {
      const sym = WIN_MODIFIERS[m];
      if (!sym) {
        return {
          ok: false,
          error: `unsupported modifier "${m}" — SendKeys only knows ctrl/alt/shift (not the Windows key)`,
        };
      }
      modPrefix += sym;
    }
    let baseCode;
    if (WIN_KEY_MAP[base]) baseCode = WIN_KEY_MAP[base];
    else if (base.length === 1) baseCode = escapeSendKeys(base);
    else return { ok: false, error: `unrecognized key "${base}"` };

    const combo = modPrefix ? `${modPrefix}(${baseCode})` : baseCode;
    const escaped = escapePowerShellSingleQuoted(combo);
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
    return { ok: true, command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }

  if (platform === "darwin") {
    for (const m of mods) {
      if (!MAC_MODIFIERS[m]) return { ok: false, error: `unsupported modifier "${m}"` };
    }
    const modClause = mods.length ? ` using {${mods.map((m) => MAC_MODIFIERS[m]).join(", ")}}` : "";

    if (MAC_KEY_CODES[base] !== undefined) {
      const script = `tell application "System Events" to key code ${MAC_KEY_CODES[base]}${modClause}`;
      return { ok: true, command: "osascript", args: ["-e", script] };
    }
    if (base.length === 1) {
      const escaped = escapeAppleScriptString(base);
      const script = `tell application "System Events" to keystroke "${escaped}"${modClause}`;
      return { ok: true, command: "osascript", args: ["-e", script] };
    }
    return { ok: false, error: `unrecognized key "${base}"` };
  }

  return { ok: false, error: `no press_key support for platform "${platform}"` };
}

module.exports = {
  captureCommand,
  screenSizeCommand,
  parseScreenSize,
  clickCommand,
  typeCommand,
  keyCommand,
  _internals: {
    escapeSendKeys,
    escapePowerShellSingleQuoted,
    escapeAppleScriptString,
    hasControlChars,
    WIN_MOUSE_FLAGS,
    WIN_KEY_MAP,
    MAC_KEY_CODES,
  },
};
