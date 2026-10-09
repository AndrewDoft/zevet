// What Windows needs in order to treat zevet as a real installed application.
//
// Every assertion here corresponds to something that was actually wrong:
// the app never set an AppUserModelID (so the taskbar saw the running window
// and the installed shortcut as two different programs, and pinning did not
// stick), the installer was never told to make a Start Menu entry (so typing
// "zevet" into Search found nothing), and the icon was still the retired
// near-black-and-rust scheme long after the product moved to eggshell.
//
// These are cheap file assertions on purpose. The expensive version needs a
// Windows desktop session and a human looking at a taskbar, which no CI runner
// has -- but "the identity is set and matches" and "the shortcut is requested"
// are exactly the parts that silently regress.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "desktop");
const pkg = JSON.parse(readFileSync(path.join(DESKTOP, "package.json"), "utf8"));
const main = readFileSync(path.join(DESKTOP, "main.js"), "utf8");

describe("the app identifies itself to Windows", () => {
  test("setAppUserModelId is called, with the SAME id electron-builder installs under", () => {
    // If these two drift apart the symptom is not an error anywhere -- it is a
    // taskbar that will not pin, which looks like a broken build.
    const m = main.match(/setAppUserModelId\(([A-Z_]+|"[^"]+")\)/);
    assert.ok(m, "main.js never calls app.setAppUserModelId");

    let id = m[1];
    if (!id.startsWith('"')) {
      const c = main.match(new RegExp(`const ${id} = "([^"]+)"`));
      assert.ok(c, `setAppUserModelId(${id}) but ${id} is not a string constant in main.js`);
      id = `"${c[1]}"`;
    }
    assert.equal(
      JSON.parse(id),
      pkg.build.appId,
      "the runtime app id and the installed app id differ, so Windows sees two applications",
    );
  });

  test("it is set before any window exists", () => {
    // Electron applies the model ID to windows as they are created; setting it
    // after the first window leaves that window under the default identity.
    const setAt = main.indexOf("setAppUserModelId");
    const firstWindow = main.indexOf("new BrowserWindow(");
    assert.ok(setAt >= 0 && firstWindow >= 0);
    assert.ok(setAt < firstWindow, "setAppUserModelId runs after a window is already constructed");
  });
});

describe("the installer makes it findable", () => {
  const nsis = pkg.build.nsis || {};

  test("a Start Menu shortcut is requested", () => {
    // Windows Search indexes the Start Menu. Without an entry there, typing the
    // app's name finds nothing and there is no search result to pin from.
    assert.equal(nsis.createStartMenuShortcut, true, "no Start Menu shortcut, so Search cannot find zevet");
  });

  test("the shortcut has a name, and no vendor sub-folder to hide in", () => {
    assert.ok(nsis.shortcutName, "the shortcut has no explicit name");
    assert.notEqual(nsis.menuCategory, true, "a vendor sub-folder buries the entry");
  });

  test("a desktop shortcut too, and an uninstall entry that says what it is", () => {
    assert.equal(nsis.createDesktopShortcut, true);
    assert.ok(nsis.uninstallDisplayName, "Add/Remove Programs would show a raw product id");
  });
});

describe("the icon is the current masora theme", () => {
  const iconPath = path.join(DESKTOP, "build", "icon.png");
  // build/icon.png is gitignored (a build product). Generate it the way
  // `npm run icon` does rather than fail on every fresh clone.
  if (!existsSync(iconPath)) execFileSync(process.execPath, ["make-icon.mjs"], { cwd: DESKTOP });

  /** Decode enough of the PNG to read real pixels — no image dependency. */
  function decode(file) {
    const d = readFileSync(file);
    assert.deepEqual([...d.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "not a PNG");
    const w = d.readUInt32BE(16);
    const h = d.readUInt32BE(20);
    const colourType = d[25];
    let pos = 8;
    let idat = Buffer.alloc(0);
    while (pos < d.length) {
      const len = d.readUInt32BE(pos);
      const type = d.subarray(pos + 4, pos + 8).toString("ascii");
      if (type === "IDAT") idat = Buffer.concat([idat, d.subarray(pos + 8, pos + 8 + len)]);
      pos += 12 + len;
    }
    const raw = inflateSync(idat);
    const bpp = colourType === 6 ? 4 : 3;
    const stride = w * bpp;
    // Filter type 0 on every scanline, which is what the generator writes.
    const at = (x, y) => {
      const off = y * (stride + 1) + 1 + x * bpp;
      return [raw[off], raw[off + 1], raw[off + 2], bpp === 4 ? raw[off + 3] : 255];
    };
    return { w, h, colourType, at };
  }

  test("it exists, is 512px, and has an alpha channel", () => {
    assert.ok(existsSync(iconPath), "run `npm run icon` — build/icon.png is missing");
    const img = decode(iconPath);
    assert.equal(img.w, 512);
    assert.equal(img.h, 512);
    // Without alpha the rounded corners come out as opaque eggshell squares,
    // which reads as a rendering fault on a dark taskbar.
    assert.equal(img.colourType, 6, "the icon has no alpha channel, so its corners cannot be round");
  });

  test("the ground is --paper, and the retired dark scheme is gone", () => {
    const img = decode(iconPath);
    const [r, g, b] = img.at(256, 60);
    assert.deepEqual([r, g, b], [0xea, 0xe7, 0xe2], "the icon ground is not --paper #eae7e2");

    // The old icon's ground was #0d0a0a with a rust #e07a62 bar. Assert the
    // retired hues appear nowhere, so a revert cannot pass quietly.
    const banned = [
      [0x0d, 0x0a, 0x0a],
      [0xe0, 0x7a, 0x62],
      [0xd9, 0xa4, 0x30],
      [0xc2, 0x70, 0x8f],
    ];
    for (let y = 0; y < 512; y += 4) {
      for (let x = 0; x < 512; x += 4) {
        const [pr, pg, pb, pa] = img.at(x, y);
        if (pa === 0) continue;
        for (const [br, bg, bb] of banned) {
          assert.ok(
            !(pr === br && pg === bg && pb === bb),
            `retired theme colour #${br.toString(16)}${bg.toString(16)}${bb.toString(16)} at ${x},${y}`,
          );
        }
      }
    }
  });

  test("the corners are actually transparent", () => {
    const img = decode(iconPath);
    assert.equal(img.at(2, 2)[3], 0, "the top-left corner is opaque, so the tile is a square");
    assert.equal(img.at(509, 509)[3], 0, "the bottom-right corner is opaque");
    assert.equal(img.at(256, 256)[3], 255, "the middle of the tile is transparent");
  });

  test("both platforms are pointed at it, and it is packaged", () => {
    assert.equal(pkg.build.win.icon, "build/icon.ico", "Windows takes the multi-size .ico, not a 512px PNG");
    assert.equal(pkg.build.mac.icon, "build/icon.png");
    assert.ok(pkg.payload.files.includes("build/icon.png"), "the icon is not in build.files");
  });
});

describe("the Windows taskbar icon", () => {
  const icoPath = path.join(DESKTOP, "build", "icon.ico");
  if (!existsSync(icoPath)) execFileSync(process.execPath, ["make-icon.mjs"], { cwd: DESKTOP });
  const ico = readFileSync(icoPath);
  const frames = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const e = 6 + i * 16;
    const size = ico[e] || 256;
    const off = ico.readUInt32LE(e + 12);
    return { size, h: ico[e + 1] || 256, bpp: ico.readUInt16LE(e + 6), png: ico.subarray(off, off + ico.readUInt32LE(e + 8)) };
  });

  test("build/icon.ico is an icon with a frame at every size Windows draws", () => {
    assert.equal(ico.readUInt16LE(0), 0, "reserved");
    assert.equal(ico.readUInt16LE(2), 1, "not an icon resource");
    for (const need of [16, 24, 32, 48, 64, 128, 256]) assert.ok(frames.some((f) => f.size === need), `no ${need}px frame`);
  });

  test("every frame is a real PNG of the size it claims, with alpha", () => {
    for (const f of frames) {
      assert.deepEqual([...f.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${f.size}px frame is not a PNG`);
      assert.equal(f.png.readUInt32BE(16), f.size);
      assert.equal(f.png.readUInt32BE(20), f.h);
      assert.equal(f.png[25], 6, `${f.size}px frame has no alpha`);
    }
  });

  test("the small frames are drawn for their size: the apex dot is ink at 16px", () => {
    const f = frames.find((x) => x.size === 16);
    const data = [];
    let pos = 8;
    while (pos < f.png.length) {
      const len = f.png.readUInt32BE(pos);
      if (f.png.subarray(pos + 4, pos + 8).toString("ascii") === "IDAT") data.push(f.png.subarray(pos + 8, pos + 8 + len));
      pos += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(data));
    const at = (x, y) => raw.subarray(y * (16 * 4 + 1) + 1 + x * 4, y * (16 * 4 + 1) + 1 + x * 4 + 3);
    assert.deepEqual([...at(8, 5)], [0x2c, 0x2f, 0x44], "no ink where the apex dot is");
    assert.deepEqual([...at(8, 1)], [0xea, 0xe7, 0xe2], "no paper above it");
  });

  test("electron-builder is given the .ico, and the payload carries both icons to where main.js looks", () => {
    assert.equal(pkg.build.win.icon, "build/icon.ico");
    const stage = mkdtempSync(path.join(tmpdir(), "zevet-payload-"));
    try {
      // The packaged layout: main.js sits in resources/app-core and reads ./build/<icon> beside itself.
      const { stage: stagePayload } = createRequire(import.meta.url)(path.join(DESKTOP, "payload-tree.cjs"));
      stagePayload(stage);
      for (const f of ["icon.ico", "icon.png"]) assert.ok(existsSync(path.join(stage, "build", f)), `payload is missing build/${f}`);
      assert.ok(existsSync(path.join(stage, "main.js")));
      assert.match(main, /path\.join\(__dirname, "build", process\.platform === "win32" \? "icon\.ico" : "icon\.png"\)/);
      assert.match(main, /const iconOption = fs\.existsSync\(ICON\) \? \{ icon: ICON \} : \{\};/);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
