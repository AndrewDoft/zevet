// desktop/local-fs.js — the local file tree, against a real disk.
//
// Everything below builds actual directories in the OS temp dir and reads them
// back. `fs` is never mocked: this module exists to tell the truth about a
// filesystem, and a filesystem faked to agree with it is not evidence. The
// platform-specific parts (backslashes, drive letters, symlink permissions)
// are the whole point of some of these cases, and a mock erases exactly those.
//
// THREAT MODEL for the `readTextFile` block: `relPath` arrives from a
// renderer. The board window loads a page served by the hub, so a spoofed or
// compromised hub can script that page. Every traversal case here is therefore
// something an attacker sends, not a typo a user makes — and each one asserts
// the SPECIFIC refusal, never merely `ok === false`. A path that escapes to a
// file that happens not to exist also returns `ok: false`, so a test that
// checked only the boolean would pass with the guard deleted. That was
// confirmed by deleting it; see the mutation note above the traversal test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  statSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The module under test is CommonJS because the Electron main process is.
const require = createRequire(import.meta.url);
const localFs = require("../desktop/local-fs.js");
const { listTree, readTextFile, writeTextFile, isProbablyRepo } = localFs;

const WIN = process.platform === "win32";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Anything the atomic write might have left lying around, by naming convention. */
function temps(dir) {
  return readdirSync(dir).filter((n) => n.includes(".zevet-") || n.endsWith(".tmp"));
}

/** A real temp directory, realpath'd so comparisons survive /tmp symlinks. */
function tempRoot(prefix = "zevet-fs-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes `files` ({ "a/b.txt": "body" }) under `root`, making parents. */
function build(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

describe("listTree", () => {
  test("relative paths use forward slashes, on this platform", () => {
    const t = tempRoot();
    try {
      build(t.dir, {
        "src/lib/deep/thing.ts": "x",
        "src/index.ts": "x",
        "README.md": "x",
      });

      const r = listTree(t.dir);
      assert.equal(r.ok, true);
      assert.equal(r.root, t.dir);

      // The load-bearing assertion. On Windows `path.join` would produce
      // `src\lib\deep\thing.ts`, which the hub and the UI would never match
      // against their own `src/lib/deep/thing.ts` — and it would fail by
      // showing nothing rather than by erroring.
      for (const e of r.entries) {
        assert.ok(!e.path.includes("\\"), `backslash in ${JSON.stringify(e.path)}`);
      }

      const paths = r.entries.map((e) => e.path);
      assert.ok(paths.includes("src/lib/deep/thing.ts"), paths.join(" "));

      const deep = r.entries.find((e) => e.path === "src/lib/deep/thing.ts");
      assert.equal(deep.name, "thing.ts");
      assert.equal(deep.kind, "file");
      assert.equal(deep.depth, 3);
      assert.equal(deep.size, 1);
      assert.ok(deep.mtimeMs > 0);

      // Pre-order: a directory is immediately followed by its own subtree, and
      // the subtree is complete before the next sibling starts. `src/lib` is
      // first inside `src` because directories lead; `src/index.ts` comes only
      // after everything under `src/lib`.
      assert.deepEqual(paths, [
        "src",
        "src/lib",
        "src/lib/deep",
        "src/lib/deep/thing.ts",
        "src/index.ts",
        "README.md",
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("directories sort before files, then case-insensitively", () => {
    const t = tempRoot();
    try {
      build(t.dir, {
        "zeta/keep.txt": "x",
        "Alpha/keep.txt": "x",
        "aaa.txt": "x",
        "Beta.txt": "x",
        "sub/zz.txt": "x",
        "sub/Mid/keep.txt": "x",
        "sub/aa.txt": "x",
      });

      const r = listTree(t.dir);
      assert.equal(r.ok, true);

      const topLevel = r.entries.filter((e) => e.depth === 0).map((e) => e.path);
      assert.deepEqual(topLevel, ["Alpha", "sub", "zeta", "aaa.txt", "Beta.txt"]);

      const inSub = r.entries.filter((e) => e.path.startsWith("sub/") && e.depth === 1).map((e) => e.path);
      assert.deepEqual(inSub, ["sub/Mid", "sub/aa.txt", "sub/zz.txt"]);
    } finally {
      t.cleanup();
    }
  });

  test("node_modules and .git are excluded, with everything else intact", () => {
    const t = tempRoot();
    try {
      build(t.dir, {
        "node_modules/left-pad/index.js": "x",
        "node_modules/keep-me-out.txt": "x",
        ".git/HEAD": "ref: refs/heads/main\n",
        "src/node_modules/nested/index.js": "x",
        "dist/bundle.js": "x",
        "src/app.ts": "x",
      });

      const r = listTree(t.dir);
      assert.equal(r.ok, true);
      const paths = r.entries.map((e) => e.path);

      assert.deepEqual(paths, ["src", "src/app.ts"]);
      for (const p of paths) {
        assert.ok(!p.includes("node_modules"), p);
        assert.ok(!p.includes(".git"), p);
      }
    } finally {
      t.cleanup();
    }
  });

  test("opts.exclude skips extra names on top of the defaults", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "keep/a.txt": "x", "coverage/lcov.info": "x", "notes.md": "x" });

      const r = listTree(t.dir, { exclude: ["coverage", "notes.md"] });
      assert.equal(r.ok, true);
      assert.deepEqual(r.entries.map((e) => e.path), ["keep", "keep/a.txt"]);
    } finally {
      t.cleanup();
    }
  });

  test("maxEntries stops the walk and says so", () => {
    const t = tempRoot();
    try {
      const files = {};
      for (let i = 0; i < 60; i++) files[`pkg${String(i).padStart(3, "0")}/file.txt`] = "x";
      build(t.dir, files);

      const capped = listTree(t.dir, { maxEntries: 7 });
      assert.equal(capped.ok, true);
      assert.equal(capped.entries.length, 7);
      assert.equal(capped.truncated, true);

      // And the flag is not just always on: the same tree read whole is false.
      const whole = listTree(t.dir);
      assert.equal(whole.truncated, false);
      assert.equal(whole.entries.length, 120);
    } finally {
      t.cleanup();
    }
  });

  test("maxDepth lists the deepest directory but does not open it", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "a/b/c/d/deep.txt": "x" });

      const r = listTree(t.dir, { maxDepth: 2 });
      assert.equal(r.ok, true);
      assert.deepEqual(r.entries.map((e) => e.path), ["a", "a/b", "a/b/c"]);
      assert.equal(r.truncated, false);
    } finally {
      t.cleanup();
    }
  });

  test("a symlinked directory is not followed", (t2) => {
    const t = tempRoot();
    try {
      build(t.dir, { "ws/real.txt": "x", "outside/secret.txt": "top secret" });
      const link = path.join(t.dir, "ws", "escape");
      try {
        symlinkSync(path.join(t.dir, "outside"), link, "junction");
      } catch (err) {
        // Windows needs Developer Mode or elevation for symlinks. Skipped
        // LOUDLY rather than quietly passing: an unrun case is not a green one.
        t2.skip(`cannot create a symlink here (${err.code}); symlink case NOT verified`);
        return;
      }

      const r = listTree(path.join(t.dir, "ws"));
      assert.equal(r.ok, true);
      const paths = r.entries.map((e) => e.path);
      assert.deepEqual(paths, ["real.txt"]);
      assert.ok(!paths.some((p) => p.includes("secret")), paths.join(" "));
    } finally {
      t.cleanup();
    }
  });

  test("a missing or non-directory root is an error, not a throw", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "file.txt": "x" });

      const missing = listTree(path.join(t.dir, "nope"));
      assert.equal(missing.ok, false);
      assert.match(missing.error, /no such folder/);

      const notDir = listTree(path.join(t.dir, "file.txt"));
      assert.equal(notDir.ok, false);
      assert.match(notDir.error, /not a folder/);

      assert.equal(listTree("").ok, false);
      assert.equal(listTree(undefined).ok, false);
    } finally {
      t.cleanup();
    }
  });
});

describe("readTextFile", () => {
  test("reads a file inside the workspace", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "src/a.ts": "const x = 1;\n" });
      const r = readTextFile(t.dir, "src/a.ts");
      assert.equal(r.ok, true);
      assert.equal(r.text, "const x = 1;\n");
      assert.equal(r.bytes, 13);
      assert.equal(r.truncated, false);
    } finally {
      t.cleanup();
    }
  });

  /**
   * MUTATION-PROVEN. Run once with the containment check in `insideRoot`
   * replaced by `return abs;`: this test goes red on the first case, because
   * `../outside/secret.txt` is a REAL readable file and the call returns
   * `ok: true` with its contents. That is why the escape target is built on
   * disk instead of pointing at `/etc/passwd` and nothing else — with a
   * non-existent target, a disabled guard still returns `ok: false` ("no such
   * file") and this test would have passed while the hole was wide open.
   *
   * Every case asserts the exact error string for the same reason.
   */
  test("refuses anything that escapes the workspace", () => {
    const t = tempRoot();
    try {
      build(t.dir, {
        "ws/inside.txt": "fine",
        "outside/secret.txt": "THE SECRET",
      });
      const ws = path.join(t.dir, "ws");

      const escapes = [
        "../outside/secret.txt", // resolves to a file that really exists
        "../../etc/passwd",
        "..",
        "a/../../outside/secret.txt", // only survives after `..` collapse
        "/etc/passwd",
        "\\Windows\\win.ini",
        "\\\\server\\share\\file.txt", // UNC: path.resolve treats this as a root
        path.join(t.dir, "outside", "secret.txt"), // an absolute path, this platform
      ];
      // The Windows spelling of the traversal is only a traversal ON Windows.
      // On POSIX a backslash is an ordinary character in a filename, so
      // "..\\outside\\secret.txt" is one odd-looking name INSIDE the workspace
      // and refusing it as an escape would be wrong. It gets its own assertion
      // below, because what matters either way is that it never reads the secret.
      if (WIN) {
        escapes.push(
          "..\\outside\\secret.txt",
          "C:\\Windows\\win.ini",
          "C:/Windows/win.ini",
          "C:win.ini",
        );
      }

      for (const bad of escapes) {
        const r = readTextFile(ws, bad);
        assert.equal(r.ok, false, `ACCEPTED ${JSON.stringify(bad)}`);
        assert.equal(r.error, "outside the workspace", `wrong refusal for ${JSON.stringify(bad)}`);
        assert.equal(r.text, undefined);
      }

      if (!WIN) {
        // Refused, and above all NOT the secret: on POSIX this is simply a file
        // that is not there. The security property is identical; only the
        // reason differs, so the reason is what is asserted per platform.
        const r = readTextFile(ws, "..\\outside\\secret.txt");
        assert.equal(r.ok, false, "a backslash name was accepted on POSIX");
        assert.notEqual(r.text, "THE SECRET", "the backslash spelling escaped the workspace on POSIX");
      }

      // The control: the guard refuses escapes, not everything.
      assert.equal(readTextFile(ws, "inside.txt").text, "fine");
    } finally {
      t.cleanup();
    }
  });

  test("refuses a symlink that points out of the workspace", (t2) => {
    const t = tempRoot();
    try {
      build(t.dir, { "ws/keep.txt": "x", "outside/secret.txt": "THE SECRET" });
      const link = path.join(t.dir, "ws", "secret.txt");
      try {
        symlinkSync(path.join(t.dir, "outside", "secret.txt"), link, "file");
      } catch (err) {
        t2.skip(`cannot create a symlink here (${err.code}); symlink case NOT verified`);
        return;
      }

      // Lexically this path is spotless — it is a plain name in the root. Only
      // resolving the link catches it.
      const r = readTextFile(path.join(t.dir, "ws"), "secret.txt");
      assert.equal(r.ok, false);
      assert.equal(r.error, "outside the workspace");
    } finally {
      t.cleanup();
    }
  });

  test("refuses a file holding a NUL byte", () => {
    const t = tempRoot();
    try {
      mkdirSync(path.join(t.dir, "b"), { recursive: true });
      writeFileSync(
        path.join(t.dir, "b", "thing.bin"),
        Buffer.concat([Buffer.from("MZ\x90\x00header"), Buffer.alloc(4), Buffer.from("tail")]),
      );
      // Text up front, NUL far past the sniff window: the heuristic's stated
      // blind spot, asserted so it stays a known limit and not a surprise.
      writeFileSync(
        path.join(t.dir, "b", "late.bin"),
        Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.alloc(1)]),
      );

      const r = readTextFile(t.dir, "b/thing.bin");
      assert.equal(r.ok, false);
      assert.equal(r.error, "looks binary");

      const late = readTextFile(t.dir, "b/late.bin");
      assert.equal(late.ok, true, "NUL past the sniff window is documented as undetected");
    } finally {
      t.cleanup();
    }
  });

  test("strips a UTF-8 BOM but still reports the file's real size", () => {
    const t = tempRoot();
    try {
      const body = '{"a":1}\n';
      writeFileSync(path.join(t.dir, "bom.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));

      const r = readTextFile(t.dir, "bom.json");
      assert.equal(r.ok, true);
      assert.equal(r.text, body);
      assert.equal(r.text.charCodeAt(0), 0x7b); // "{", not U+FEFF
      assert.doesNotThrow(() => JSON.parse(r.text));
      assert.equal(r.bytes, body.length + 3);
    } finally {
      t.cleanup();
    }
  });

  test("refuses a file over maxBytes", () => {
    const t = tempRoot();
    try {
      writeFileSync(path.join(t.dir, "big.log"), "a".repeat(5000));
      writeFileSync(path.join(t.dir, "small.log"), "a".repeat(999));

      const big = readTextFile(t.dir, "big.log", { maxBytes: 1000 });
      assert.equal(big.ok, false);
      assert.match(big.error, /too big/);
      assert.match(big.error, /5000/);
      assert.equal(big.text, undefined);

      // The boundary is a limit, not a fence one byte short of the file.
      const small = readTextFile(t.dir, "small.log", { maxBytes: 1000 });
      assert.equal(small.ok, true);
      assert.equal(small.bytes, 999);
      assert.equal(small.truncated, false);

      // And the default is what the module says it is.
      assert.equal(localFs.DEFAULT_MAX_BYTES, 512 * 1024);
    } finally {
      t.cleanup();
    }
  });

  test("a directory and a missing file get their own refusals", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "src/a.ts": "x" });

      const dir = readTextFile(t.dir, "src");
      assert.equal(dir.ok, false);
      assert.match(dir.error, /folder/);

      const gone = readTextFile(t.dir, "src/nope.ts");
      assert.equal(gone.ok, false);
      assert.equal(gone.error, "no such file");

      const empty = readTextFile(t.dir, "");
      assert.equal(empty.ok, false);
      assert.equal(empty.error, "outside the workspace");
    } finally {
      t.cleanup();
    }
  });
});

// THREAT MODEL for the `writeTextFile` block, which is the read block's and
// then some. `relPath` still arrives from a renderer that a compromised hub can
// script — but a write that escapes does not leak a file, it takes the machine:
// an in-workspace symlink to ~/.ssh/authorized_keys, or a rewritten
// .git/hooks/pre-commit that the user's next commit runs. So every escape case
// below builds a REAL file outside the root and asserts, after the refusal,
// that its bytes are untouched. A test that checked only `ok === false` would
// pass with the guard deleted, because a refusal and a successful escape are
// both "not ok" to anybody who does not go and look at the disk.
//
// MUTATION-PROVEN, run rather than reasoned. Each of these five was disabled in
// writeTextFile in turn and the suite re-run; each one turned it red:
//
//   * the `within(root, realParent)` check after realpath  -> the symlinked
//     parent test writes into the directory outside the root
//   * the `isSymbolicLink()` refusal                       -> the write follows
//     the link and rewrites authorized_keys outside the root
//   * the DEFAULT_SKIP segment check                       -> .git/hooks/pre-commit
//     is rewritten
//   * `insideRoot` replaced by a bare `path.resolve`       -> ../outside/secret.txt
//     is overwritten
//   * the missing-parent refusal replaced by `mkdir -p`    -> src/new/deep appears
//
// What was NOT mutation-tested: the fsync and the temp-file cleanup, neither of
// which any test can observe without crashing the process mid-write.
describe("writeTextFile", () => {
  test("a symlinked directory cannot smuggle a write into .git", (t2) => {
    /* ⚠️ THE SKIP LIST USED TO BE CHECKED ON THE SPELLING HANDED IN,
       while the bytes land on the path resolved through symlinks. A repository
       can carry `ws/docs -> .git/hooks` and git will check it out, so a write
       to "docs/pre-commit" reached `.git/hooks/pre-commit` with a mode and an
       execute bit, to run on the next commit: the segments are "docs" and
       "pre-commit", neither in the skip list, and the resolved parent really
       is inside the root so containment had nothing to object to. */
    const t = tempRoot();
    try {
      mkdirSync(path.join(t.dir, ".git", "hooks"), { recursive: true });
      const link = path.join(t.dir, "docs");
      try {
        symlinkSync(path.join(t.dir, ".git", "hooks"), link, "junction");
      } catch (err) {
        // Windows needs Developer Mode or elevation. Skipped LOUDLY: an unrun
        // case is not a green one.
        t2.skip(`cannot create a symlink here (${err.code}); the .git smuggling case is NOT verified`);
        return;
      }

      const r = writeTextFile(t.dir, "docs/pre-commit", "#!/bin/sh\nexit 1\n");
      assert.equal(r.ok, false, "a write through a symlink into .git was allowed");
      assert.match(r.error, /not a file this app will write/);
      assert.equal(
        existsSync(path.join(t.dir, ".git", "hooks", "pre-commit")),
        false,
        "the hook was written despite the refusal",
      );
    } finally {
      t.cleanup();
    }
  });

  test("writes a new file, and reads back exactly what went in", () => {
    const t = tempRoot();
    try {
      mkdirSync(path.join(t.dir, "src"), { recursive: true });

      const made = writeTextFile(t.dir, "src/a.ts", "const x = 1;\n");
      assert.equal(made.ok, true, made.error);
      assert.equal(made.created, true);
      assert.equal(made.bytes, 13);
      assert.equal(made.bom, false);
      assert.equal(made.eol, "lf");

      // The round trip is the point: the read path is the only consumer, so a
      // write that only agrees with itself has proved nothing.
      const back = readTextFile(t.dir, "src/a.ts");
      assert.equal(back.ok, true);
      assert.equal(back.text, "const x = 1;\n");
      assert.equal(back.bytes, 13);

      const again = writeTextFile(t.dir, "src/a.ts", "const x = 2;\n");
      assert.equal(again.ok, true);
      assert.equal(again.created, false, "an overwrite reported itself as a creation");
      assert.equal(readTextFile(t.dir, "src/a.ts").text, "const x = 2;\n");

      // Nothing else appeared in the directory: one file, no leftovers.
      assert.deepEqual(readdirSync(path.join(t.dir, "src")), ["a.ts"]);
    } finally {
      t.cleanup();
    }
  });

  test("refuses anything that escapes the workspace, and the file outside stays untouched", () => {
    const t = tempRoot();
    try {
      build(t.dir, {
        "ws/inside.txt": "fine",
        "outside/secret.txt": "THE SECRET",
      });
      const ws = path.join(t.dir, "ws");
      const secret = path.join(t.dir, "outside", "secret.txt");

      const escapes = [
        "../outside/secret.txt", // resolves onto a file that really exists
        "../../etc/hosts",
        "..",
        ".",
        "a/../../outside/secret.txt", // only survives after the `..` collapse
        "/etc/hosts",
        "\\Windows\\win.ini",
        "\\\\server\\share\\file.txt", // UNC: path.resolve treats this as a root
        secret, // an absolute path, spelled for this platform
      ];
      if (WIN) {
        escapes.push("..\\outside\\secret.txt", "C:\\Windows\\win.ini", "C:/Windows/win.ini", "C:win.ini");
      }

      for (const bad of escapes) {
        const r = writeTextFile(ws, bad, "PWNED");
        assert.equal(r.ok, false, `ACCEPTED ${JSON.stringify(bad)}`);
        assert.ok(
          r.error === "outside the workspace" || r.error === "that is a folder",
          `wrong refusal for ${JSON.stringify(bad)}: ${r.error}`,
        );
      }

      // The assertion that would have caught a deleted guard.
      assert.equal(readFileSync(secret, "utf8"), "THE SECRET", "a refused write reached the file anyway");
      if (!WIN) {
        // On POSIX a backslash is an ordinary filename character, so this is one
        // oddly named file INSIDE the workspace rather than a traversal. It may
        // legitimately be written; what must never happen is the secret moving.
        writeTextFile(ws, "..\\outside\\secret.txt", "PWNED");
        assert.equal(readFileSync(secret, "utf8"), "THE SECRET");
      }

      // The control: the guard refuses escapes, not everything.
      const good = writeTextFile(ws, "inside.txt", "edited");
      assert.equal(good.ok, true, good.error);
      assert.equal(readFileSync(path.join(ws, "inside.txt"), "utf8"), "edited");
    } finally {
      t.cleanup();
    }
  });

  test("refuses a symlink AT the target, wherever it points", (t2) => {
    const t = tempRoot();
    try {
      build(t.dir, {
        "ws/real.txt": "a real file",
        "outside/authorized_keys": "THE ORIGINAL KEYS",
      });
      const ws = path.join(t.dir, "ws");
      const outward = path.join(ws, "keys.txt");
      const inward = path.join(ws, "alias.txt");
      try {
        symlinkSync(path.join(t.dir, "outside", "authorized_keys"), outward, "file");
        symlinkSync(path.join(ws, "real.txt"), inward, "file");
      } catch (err) {
        // Windows needs Developer Mode or elevation. Skipped LOUDLY: an unrun
        // case is not a green one, and this is the case that matters most.
        t2.skip(`cannot create a symlink here (${err.code}); the symlink-target case is NOT verified`);
        return;
      }

      // Lexically spotless — a plain name in the root. Only the lstat catches it.
      const out = writeTextFile(ws, "keys.txt", "ssh-rsa AAAA-attacker");
      assert.equal(out.ok, false);
      assert.equal(out.error, "that is a symlink");
      assert.equal(
        readFileSync(path.join(t.dir, "outside", "authorized_keys"), "utf8"),
        "THE ORIGINAL KEYS",
        "the write followed a symlink out of the workspace",
      );

      // And a link pointing back INSIDE is refused too. It would be safe today,
      // but the target of a link can be repointed between the check and the
      // write, and one rule ("never a symlink") has no such window.
      const inn = writeTextFile(ws, "alias.txt", "via the link");
      assert.equal(inn.ok, false);
      assert.equal(inn.error, "that is a symlink");
      assert.equal(readFileSync(path.join(ws, "real.txt"), "utf8"), "a real file");

      assert.deepEqual(temps(ws), []);
    } finally {
      t.cleanup();
    }
  });

  test("refuses a symlinked parent directory that leaves the workspace", (t2) => {
    const t = tempRoot();
    try {
      build(t.dir, { "ws/keep.txt": "x", "outside/marker.txt": "still here" });
      const ws = path.join(t.dir, "ws");
      const link = path.join(ws, "escape");
      try {
        symlinkSync(path.join(t.dir, "outside"), link, "junction");
      } catch (err) {
        t2.skip(`cannot create a symlink here (${err.code}); the symlinked-parent case is NOT verified`);
        return;
      }

      // `escape/pwned.txt` is lexically inside the root and resolves outside it.
      // This is the case the POST-realpath check on the PARENT exists for: the
      // target does not exist yet, so resolving the target itself would only
      // ever say ENOENT.
      const r = writeTextFile(ws, "escape/pwned.txt", "PWNED");
      assert.equal(r.ok, false, "a symlinked directory became a write escape");
      assert.equal(r.error, "outside the workspace");
      assert.equal(existsSync(path.join(t.dir, "outside", "pwned.txt")), false);
      assert.deepEqual(readdirSync(path.join(t.dir, "outside")), ["marker.txt"]);

      // The same through an existing file behind the link, for good measure.
      const over = writeTextFile(ws, "escape/marker.txt", "PWNED");
      assert.equal(over.ok, false);
      assert.equal(over.error, "outside the workspace");
      assert.equal(readFileSync(path.join(t.dir, "outside", "marker.txt"), "utf8"), "still here");
    } finally {
      t.cleanup();
    }
  });

  test("refuses to invent the folders a path names", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "src/a.ts": "x" });

      const r = writeTextFile(t.dir, "src/new/deep/thing.ts", "x");
      assert.equal(r.ok, false);
      assert.equal(r.error, "no such folder to write into");
      // The load-bearing half: not merely refused, but nothing was created on
      // the way to refusing. `mkdir -p` on an untrusted string is a capability
      // with no use case, and this is what asserts it is absent.
      assert.equal(existsSync(path.join(t.dir, "src", "new")), false);
      assert.deepEqual(readdirSync(path.join(t.dir, "src")), ["a.ts"]);

      // A parent that exists but is a FILE is the same refusal, not a crash.
      const throughFile = writeTextFile(t.dir, "src/a.ts/child.ts", "x");
      assert.equal(throughFile.ok, false);
      assert.match(throughFile.error, /no such folder to write into|cannot open that folder/);
      assert.equal(readTextFile(t.dir, "src/a.ts").text, "x");
    } finally {
      t.cleanup();
    }
  });

  test("refuses to write inside .git, node_modules or any other skipped name", () => {
    const t = tempRoot();
    try {
      // The directories are built first ON PURPOSE. If they were missing, the
      // refusal would be "no such folder to write into" and this test would
      // pass with the skip-list guard deleted.
      build(t.dir, {
        ".git/hooks/pre-commit": "#!/bin/sh\nexit 0\n",
        "node_modules/left-pad/index.js": "module.exports = 1;\n",
        "dist/bundle.js": "built\n",
        "src/a.ts": "x",
      });

      assert.ok(localFs.DEFAULT_SKIP.includes(".git"), "the skip list stopped containing .git");
      assert.ok(localFs.DEFAULT_SKIP.includes("node_modules"));

      const refused = [
        ".git/hooks/pre-commit", // the one that gets executed on the next commit
        ".git/config",
        "node_modules/left-pad/index.js",
        "dist/bundle.js",
      ];
      for (const bad of refused) {
        const r = writeTextFile(t.dir, bad, "PWNED");
        assert.equal(r.ok, false, `ACCEPTED ${bad}`);
        assert.equal(r.error, "not a file this app will write", `wrong refusal for ${bad}`);
      }
      assert.equal(readFileSync(path.join(t.dir, ".git", "hooks", "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
      assert.equal(readFileSync(path.join(t.dir, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1;\n");

      if (WIN) {
        // NTFS says `.GIT` and `.git` are the same directory, so a guard that
        // compares case-sensitively is a guard you walk around by holding shift.
        const shouty = writeTextFile(t.dir, ".GIT/hooks/pre-commit", "PWNED");
        assert.equal(shouty.ok, false);
        assert.equal(shouty.error, "not a file this app will write");
        assert.equal(readFileSync(path.join(t.dir, ".git", "hooks", "pre-commit"), "utf8"), "#!/bin/sh\nexit 0\n");
      }

      // Not a blanket refusal of everything nearby.
      assert.equal(writeTextFile(t.dir, "src/a.ts", "y").ok, true);
    } finally {
      t.cleanup();
    }
  });

  test("refuses content over maxBytes, and refuses it before touching the disk", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "big.log": "ORIGINAL" });

      const big = writeTextFile(t.dir, "big.log", "a".repeat(5000), { maxBytes: 1000 });
      assert.equal(big.ok, false);
      assert.match(big.error, /too big/);
      assert.match(big.error, /5000/);
      assert.equal(readFileSync(path.join(t.dir, "big.log"), "utf8"), "ORIGINAL", "a refused write still truncated the file");
      assert.deepEqual(temps(t.dir), [], "a refused write left a temp file behind");

      // The boundary is a limit, not a fence one byte short of it.
      const small = writeTextFile(t.dir, "big.log", "a".repeat(1000), { maxBytes: 1000 });
      assert.equal(small.ok, true, small.error);
      assert.equal(small.bytes, 1000);

      // Measured in BYTES, not characters: the limit that matters is the one
      // the disk sees, and a page of emoji is four bytes each.
      const wide = writeTextFile(t.dir, "big.log", "\u{1f600}".repeat(300), { maxBytes: 1000 });
      assert.equal(wide.ok, false, "1200 bytes of astral plane passed a 1000-byte limit");
      assert.match(wide.error, /1200/);

      assert.equal(localFs.DEFAULT_MAX_BYTES, 512 * 1024);
    } finally {
      t.cleanup();
    }
  });

  test("puts a BOM and CRLF back exactly as it found them", () => {
    const t = tempRoot();
    try {
      const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
      const original = Buffer.concat([BOM, Buffer.from("line one\r\nline two\r\n")]);
      writeFileSync(path.join(t.dir, "win.txt"), original);
      writeFileSync(path.join(t.dir, "copy.txt"), original);
      writeFileSync(path.join(t.dir, "unix.txt"), "line one\nline two\n");

      const read = readTextFile(t.dir, "win.txt");
      assert.equal(read.ok, true);
      assert.equal(read.bom, true, "the BOM was stripped without saying so");
      assert.equal(read.eol, "crlf");
      assert.equal(read.text, "line one\r\nline two\r\n"); // still unchanged in `text`

      // Handing the two reported facts back reproduces the file byte for byte.
      const w = writeTextFile(t.dir, "win.txt", read.text, { bom: read.bom, eol: read.eol });
      assert.equal(w.ok, true, w.error);
      assert.equal(w.bom, true);
      assert.equal(w.eol, "crlf");
      assert.deepEqual(readFileSync(path.join(t.dir, "win.txt")), original, "a round trip changed the bytes");

      // And the real case: an editor that normalised everything to LF and threw
      // the BOM away still saves a file git shows no diff for.
      const normalised = writeTextFile(t.dir, "copy.txt", "line one\nline two\n", { bom: true, eol: "crlf" });
      assert.equal(normalised.ok, true, normalised.error);
      assert.deepEqual(readFileSync(path.join(t.dir, "copy.txt")), original);

      // An LF file reports LF and no BOM, and stays that way.
      const plain = readTextFile(t.dir, "unix.txt");
      assert.equal(plain.bom, false);
      assert.equal(plain.eol, "lf");
      writeTextFile(t.dir, "unix.txt", plain.text, { bom: plain.bom, eol: plain.eol });
      assert.deepEqual(readFileSync(path.join(t.dir, "unix.txt")), Buffer.from("line one\nline two\n"));

      // The damage the options exist to prevent, demonstrated rather than
      // asserted about: without them the BOM and the CRLFs are simply gone, and
      // git blames whoever saved the file for a diff they did not make.
      const naive = writeTextFile(t.dir, "win.txt", "line one\nline two\n");
      assert.equal(naive.ok, true);
      assert.notDeepEqual(readFileSync(path.join(t.dir, "win.txt")), original);
      assert.equal(naive.bom, false);
      assert.equal(naive.eol, "lf");
    } finally {
      t.cleanup();
    }
  });

  test("reports the dominant line ending, not the first one it sees", () => {
    const t = tempRoot();
    try {
      // A genuinely mixed file, as two teammates on two platforms produce. The
      // majority spelling is the one whose restoration makes the smallest diff.
      writeFileSync(path.join(t.dir, "mixed.txt"), "a\nb\r\nc\r\nd\r\n");
      assert.equal(readTextFile(t.dir, "mixed.txt").eol, "crlf");

      writeFileSync(path.join(t.dir, "mostly-unix.txt"), "a\r\nb\nc\nd\n");
      assert.equal(readTextFile(t.dir, "mostly-unix.txt").eol, "lf");

      // No newlines at all: "lf" is the documented DEFAULT, not an observation.
      writeFileSync(path.join(t.dir, "oneline.txt"), "no newline here");
      assert.equal(readTextFile(t.dir, "oneline.txt").eol, "lf");
    } finally {
      t.cleanup();
    }
  });

  test("a successful write leaves no temp file, and a refused one changes nothing", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "notes/a.md": "ORIGINAL\n" });
      const dir = path.join(t.dir, "notes");
      mkdirSync(path.join(dir, "sub"), { recursive: true });

      assert.equal(writeTextFile(t.dir, "notes/a.md", "REPLACED\n").ok, true);
      assert.equal(readFileSync(path.join(dir, "a.md"), "utf8"), "REPLACED\n");
      assert.deepEqual(temps(dir), [], "the temp file outlived a successful write");
      assert.deepEqual(readdirSync(dir).sort(), ["a.md", "sub"]);

      // Every refusal that happens after the bytes are in hand must also leave
      // the directory exactly as it was.
      for (const attempt of [
        () => writeTextFile(t.dir, "notes/sub", "PWNED"), // a directory
        () => writeTextFile(t.dir, "notes/a.md", "x".repeat(50), { maxBytes: 10 }),
        () => writeTextFile(t.dir, "notes/a.md", 42), // not a string
        () => writeTextFile(t.dir, "notes/missing/a.md", "x"),
      ]) {
        const r = attempt();
        assert.equal(r.ok, false);
        assert.equal(readFileSync(path.join(dir, "a.md"), "utf8"), "REPLACED\n");
        assert.deepEqual(temps(dir), []);
        assert.deepEqual(readdirSync(dir).sort(), ["a.md", "sub"]);
      }

      assert.equal(writeTextFile(t.dir, "notes/sub", "PWNED").error, "that is a folder");
      assert.equal(writeTextFile(t.dir, "notes/a.md", 42).error, "nothing to write");
      assert.equal(writeTextFile(t.dir, "notes/a.md", null).error, "nothing to write");
    } finally {
      t.cleanup();
    }
  });

  test("a write that fails mid-flight leaves the original intact and no temp behind", (t2) => {
    const t = tempRoot();
    try {
      build(t.dir, { "ro/a.txt": "ORIGINAL\n" });
      const dir = path.join(t.dir, "ro");

      if (WIN) {
        // A read-only DIRECTORY is a POSIX mode, and chmod on Windows only moves
        // the read-only bit on files. Said out loud: on Windows the "the open
        // failed, now clean up" branch is NOT exercised by this suite. What is
        // covered here on every platform is the refusal paths above, which is a
        // strictly weaker claim and is all that should be read into a green run.
        t2.skip("a read-only directory is not a POSIX mode on Windows; the failed-write cleanup is NOT verified here");
        return;
      }

      chmodSync(dir, 0o500); // r-x: readable and listable, not writable
      try {
        const r = writeTextFile(t.dir, "ro/a.txt", "REPLACED\n");
        if (r.ok) {
          // Running as root defeats the mode. Skipped rather than passed.
          t2.skip("the directory was writable anyway (running as root?); the failed-write path is NOT verified");
          return;
        }
        assert.equal(r.error, "not allowed to write that file");
        assert.equal(readFileSync(path.join(dir, "a.txt"), "utf8"), "ORIGINAL\n", "a failed write damaged the original");
        assert.deepEqual(temps(dir), [], "a failed write left its temp file behind");
        assert.deepEqual(readdirSync(dir), ["a.txt"]);
      } finally {
        chmodSync(dir, 0o700);
      }
    } finally {
      t.cleanup();
    }
  });

  test("keeps the existing file's mode", (t2) => {
    const t = tempRoot();
    try {
      build(t.dir, { "run.sh": "#!/bin/sh\necho old\n" });
      const abs = path.join(t.dir, "run.sh");

      if (WIN) {
        t2.skip("POSIX modes do not survive on Windows; mode preservation is NOT verified here");
        return;
      }

      chmodSync(abs, 0o755);
      const r = writeTextFile(t.dir, "run.sh", "#!/bin/sh\necho new\n");
      assert.equal(r.ok, true, r.error);
      // A script that comes back 0644 after one save is a broken repo, and
      // nobody connects that to having edited a file in an editor pane.
      assert.equal(statSync(abs).mode & 0o777, 0o755, "the executable bit was lost by the rename");
      assert.equal(readFileSync(abs, "utf8"), "#!/bin/sh\necho new\n");
    } finally {
      t.cleanup();
    }
  });

  test("a bad root is an error, not a throw", () => {
    const t = tempRoot();
    try {
      build(t.dir, { "file.txt": "x" });

      assert.equal(writeTextFile(path.join(t.dir, "nope"), "a.txt", "x").error, "no such folder");
      assert.equal(writeTextFile(path.join(t.dir, "file.txt"), "a.txt", "x").error, "not a folder");
      assert.equal(writeTextFile("", "a.txt", "x").ok, false);
      assert.equal(writeTextFile(undefined, "a.txt", "x").ok, false);
      assert.equal(writeTextFile(t.dir, "", "x").error, "outside the workspace");
      assert.equal(writeTextFile(t.dir, undefined, "x").error, "outside the workspace");
      assert.equal(writeTextFile(t.dir, "a\0b.txt", "x").error, "outside the workspace");
    } finally {
      t.cleanup();
    }
  });
});

// The IPC surface, checked as SOURCE TEXT and not by running it.
//
// Stated plainly because it is a real limitation: this suite has no harness
// that executes an `ipcMain.handle` callback. It cannot easily have one —
// `require("electron")` outside an Electron process returns a path string, not
// the module — and inventing a fake `ipcMain` would test the fake. The existing
// precedent in this repo is test/desktop-packaging.test.mjs, which asserts
// against the text of main.js for exactly the same reason, so this follows it.
//
// What these two tests prove: the guard is WRITTEN, in the right order, and the
// renderer's options object is rebuilt rather than forwarded. What they do not
// prove: that Electron dispatches to it. That gap is covered by nothing here.
describe("the local:write IPC surface", () => {
  const main = readFileSync(path.join(REPO, "desktop", "main.js"), "utf8");
  const preload = readFileSync(path.join(REPO, "desktop", "preload.js"), "utf8");

  test("the handler goes through knownRoot, like every other local: handler", () => {
    const start = main.indexOf('ipcMain.handle("local:write"');
    assert.ok(start > 0, "main.js registers no local:write handler");
    const body = main.slice(start, main.indexOf("\n});", start));

    assert.ok(body.includes("knownRoot(root)"), "local:write does not consult the workspace allowlist");
    assert.ok(body.includes('"not an opened workspace"'), "local:write does not refuse an unknown root");
    assert.ok(
      body.indexOf("knownRoot") < body.indexOf("writeTextFile"),
      "the allowlist check runs after the write",
    );
    // The root handed on must be knownRoot's return value, not the string the
    // renderer sent: passing `root` through would make the check decorative.
    assert.match(body, /writeTextFile\(\s*dir\s*,/, "local:write passes the renderer's root, not the allowlisted one");

    // And the same guard is on the two handlers this one was modelled on, so a
    // refactor that drops it from any of them fails here.
    for (const channel of ["local:tree", "local:read", "local:write"]) {
      const at = main.indexOf(`ipcMain.handle("${channel}"`);
      assert.ok(at > 0, `no handler for ${channel}`);
      assert.ok(main.slice(at, main.indexOf("\n});", at)).includes("knownRoot"), `${channel} skips knownRoot`);
    }
  });

  test("the renderer's options are rebuilt, never spread", () => {
    const start = main.indexOf('ipcMain.handle("local:write"');
    const body = main.slice(start, main.indexOf("\n});", start));

    // `maxBytes` from a renderer is a renderer setting its own size limit;
    // `exclude` is a renderer shortening its own skip list, which is a road to
    // .git/hooks. Neither name may appear in what gets forwarded.
    assert.ok(!/\.\.\./.test(body), "local:write spreads the renderer's options object");
    assert.ok(!body.includes("maxBytes"), "local:write forwards maxBytes from the renderer");
    assert.ok(!body.includes("exclude"), "local:write forwards exclude from the renderer");

    // The bridge exposes the write and nothing wider around it.
    assert.match(
      preload,
      /write:\s*\(root, relPath, text, opts\) =>\s*ipcRenderer\.invoke\("local:write", \{ root, relPath, text, opts \}\)/,
      "preload.js does not expose the write exactly as agreed",
    );
    assert.ok(!preload.includes("exposeInMainWorld(\"ipcRenderer\""), "preload.js exposes ipcRenderer itself");
  });
});

describe("isProbablyRepo", () => {
  test("is true when .git is a FILE, as in a git worktree", () => {
    const t = tempRoot();
    try {
      const wt = path.join(t.dir, "worktree");
      mkdirSync(wt, { recursive: true });
      // Verbatim shape of what `git worktree add` writes.
      writeFileSync(path.join(wt, ".git"), "gitdir: /home/me/proj/.git/worktrees/wt\n");

      assert.equal(isProbablyRepo(wt), true);
    } finally {
      t.cleanup();
    }
  });

  test("is true for an ordinary checkout and false for a plain folder", () => {
    const t = tempRoot();
    try {
      const repo = path.join(t.dir, "repo");
      mkdirSync(path.join(repo, ".git"), { recursive: true });
      const plain = path.join(t.dir, "plain");
      mkdirSync(plain, { recursive: true });

      assert.equal(isProbablyRepo(repo), true);
      assert.equal(isProbablyRepo(plain), false);
      assert.equal(isProbablyRepo(path.join(t.dir, "does-not-exist")), false);
      assert.equal(isProbablyRepo(""), false);
      assert.equal(isProbablyRepo(undefined), false);
    } finally {
      t.cleanup();
    }
  });
});
