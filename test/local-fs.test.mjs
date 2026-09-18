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
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The module under test is CommonJS because the Electron main process is.
const require = createRequire(import.meta.url);
const localFs = require("../desktop/local-fs.js");
const { listTree, readTextFile, isProbablyRepo } = localFs;

const WIN = process.platform === "win32";

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
        "..\\outside\\secret.txt", // the Windows spelling of the same attack
        "../../etc/passwd",
        "..",
        "a/../../outside/secret.txt", // only survives after `..` collapse
        "/etc/passwd",
        "\\Windows\\win.ini",
        "\\\\server\\share\\file.txt", // UNC: path.resolve treats this as a root
        path.join(t.dir, "outside", "secret.txt"), // an absolute path, this platform
      ];
      if (WIN) escapes.push("C:\\Windows\\win.ini", "C:/Windows/win.ini", "C:win.ini");

      for (const bad of escapes) {
        const r = readTextFile(ws, bad);
        assert.equal(r.ok, false, `ACCEPTED ${JSON.stringify(bad)}`);
        assert.equal(r.error, "outside the workspace", `wrong refusal for ${JSON.stringify(bad)}`);
        assert.equal(r.text, undefined);
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
