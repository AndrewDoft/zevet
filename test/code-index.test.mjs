// desktop/code-index.js — the semantic index over the opened workspace.
//
// ⚠️ THERE IS NO MODEL IN THIS FILE AND THERE NEVER WILL BE. Every test below
// runs against `fakeEmbedder`, a bag-of-words hash into 128 dimensions. That is
// not a shortcut around testing the real thing — the real embedder is owned by
// another module and has its own suite — it is the reason `openIndex` takes an
// embedder as an injected dependency at all. What is under test here is
// arithmetic and bookkeeping: line ranges, overlap, an (size, mtimeMs) cache,
// a crash-safe store and a ranked scan. None of that needs 90MB of weights, and
// a suite that downloads weights is a suite that gets skipped in CI and rots.
//
// The fake is deterministic and its similarity is legible: two texts sharing
// the word `orbitalDecay` collide in the same dimension and score highly; two
// texts sharing nothing score 0. That makes "the chunk that actually contains
// the query terms ranks first" an assertion about the RANKER rather than about
// a model's taste.
//
// Everything runs against real temp directories and a real disk, matching
// test/local-fs.test.mjs and test/repo-stats.test.mjs. `fs` is never mocked:
// this module's whole job is to stay in step with files that change underneath
// it, and a faked filesystem agrees with whatever the code believes.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  truncateSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codeIndex = require(path.join(REPO, "desktop", "code-index.js"));
const {
  openIndex,
  chunkFile,
  splitLines,
  rejectText,
  normalise,
  FORMAT_VERSION,
  CHUNK_LINES,
  CHUNK_OVERLAP,
  HEURISTIC_MIN_BYTES,
  MAX_MEAN_LINE,
  MAX_SINGLE_LINE,
} = codeIndex;

let TEMP;
before(() => {
  TEMP = realpathSync(mkdtempSync(path.join(tmpdir(), "zevet-cidx-")));
});
after(() => {
  try {
    rmSync(TEMP, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds a handle a moment longer than we do. Temp.
  }
});

let seq = 0;
/** A workspace root and a store directory, both fresh, both outside each other. */
function fixture() {
  const base = path.join(TEMP, `w${++seq}`);
  const root = path.join(base, "repo");
  const dir = path.join(base, "store");
  mkdirSync(root, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

// Every write gets a distinct, increasing mtime in whole seconds. Two reasons:
// filesystems with one-second mtime granularity would otherwise let a rewrite
// inside the same second read as unchanged (the documented limitation of the
// (size, mtimeMs) cache, and not what any of these tests is about), and whole
// seconds round-trip through JSON exactly, so a reopened store compares equal.
let clock = Math.floor(Date.now() / 1000) - 10000;
function write(root, rel, body) {
  const abs = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  clock += 2;
  utimesSync(abs, clock, clock);
  return abs;
}

/** FNV-1a. Any stable hash would do; this one is four lines and has no ties. */
function hashWord(word) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The fake. Bag of identifiers, hashed into `dims` buckets, unit-normalised —
 * so cosine similarity is (near enough) the fraction of shared vocabulary, and
 * a query shares vocabulary with exactly the chunk that contains its words.
 *
 * It counts its own calls and the number of texts it has been handed, which is
 * how "an unchanged file is not re-embedded" is asserted: not by timing, not by
 * a spy framework, by a number that must not move.
 */
function fakeEmbedder(dims = 128) {
  const e = {
    dims,
    calls: 0,
    texts: 0,
    async embed(list) {
      e.calls++;
      e.texts += list.length;
      return list.map((t) => {
        const v = new Float32Array(dims);
        const words = String(t).toLowerCase().match(/[a-z][a-z0-9_]+/g) || [];
        for (const w of words) v[hashWord(w) % dims] += 1;
        return normalise(v);
      });
    },
  };
  return e;
}

/** The store as it sits on disk, with chunk paths materialised back on. */
function readStore(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
  const chunks = [];
  for (const f of meta.files) {
    for (let i = 0; i < f.count; i++) {
      const [startLine, endLine, text] = meta.chunks[f.offset + i];
      chunks.push({ path: f.path, startLine, endLine, text });
    }
  }
  return { meta, chunks };
}

function vectorFiles(dir) {
  return readdirSync(dir).filter((n) => /^vectors-[0-9a-f]+\.bin$/.test(n));
}

/**
 * `n` lines of plausible-looking source, each one naming its own number.
 *
 * `tag` appears as a STANDALONE word as well as inside an identifier, which
 * matters more than it looks: the fake embedder tokenises on `[a-z][a-z0-9_]+`,
 * so `compute_alpha(1)` is the single token `compute_alpha` and a query for
 * "alpha" would match it not at all. An earlier version of this helper had only
 * the compound form, which made every ranking assertion below a test of hash
 * collisions rather than of similarity — they passed, and they were empty.
 */
function numbered(n, tag = "alpha") {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(`  const ${tag}_${i} = compute(${i}); // ${tag} at line ${i}`);
  }
  return out.join("\n") + "\n";
}

describe("splitting a file into lines", () => {
  test("a trailing newline terminates the last line rather than starting one", () => {
    // The same rule repo-stats.js's countLines uses. Off by one here and every
    // line number this module ever reports is off by one at the end of a file.
    assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
    assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
    assert.deepEqual(splitLines(""), []);
  });

  test("CR is stripped so a Windows checkout embeds as the same text", () => {
    assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
  });
});

describe("chunking", () => {
  test("line numbers are 1-based, inclusive, and cover the file", () => {
    const text = numbered(95);
    const chunks = chunkFile("src/a.js", text);
    assert.equal(chunks[0].startLine, 1);
    assert.equal(chunks[0].endLine, CHUNK_LINES);
    assert.equal(chunks[chunks.length - 1].endLine, 95);
    for (const c of chunks) assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
  });

  test("a file shorter than one window is a single chunk, not a padded one", () => {
    const chunks = chunkFile("src/small.js", numbered(7));
    assert.equal(chunks.length, 1);
    assert.deepEqual([chunks[0].startLine, chunks[0].endLine], [1, 7]);
  });

  test("the last chunk is never a duplicate of the one before it", () => {
    // A window that reaches the end must stop the loop. Without that, a stride
    // shorter than the window emits a final chunk wholly contained in its
    // predecessor — twice the vectors, and a duplicate hit in every result.
    for (let n = 1; n <= 200; n++) {
      const chunks = chunkFile("f.js", numbered(n));
      for (let i = 1; i < chunks.length; i++) {
        assert.ok(
          chunks[i].endLine > chunks[i - 1].endLine,
          `n=${n}: chunk ${i} ends at ${chunks[i].endLine}, no further than ${chunks[i - 1].endLine}`,
        );
      }
    }
  });

  test("a wholly blank chunk is dropped", () => {
    const text = `${numbered(5)}${"\n".repeat(120)}`;
    const chunks = chunkFile("f.js", text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].startLine, 1);
  });

  test("an empty file produces no chunks at all", () => {
    assert.deepEqual(chunkFile("f.js", ""), []);
    assert.deepEqual(chunkFile("f.js", "\n\n\n"), []);
  });

  test("a symbol on a chunk boundary is present in TWO chunks", () => {
    // The whole reason overlap exists: a function whose signature lands at the
    // end of one window and whose body is in the next is findable by neither
    // unless the windows overlap.
    const lines = [];
    for (let i = 1; i <= 120; i++) {
      lines.push(i === CHUNK_LINES - 2 ? "function orbitalDecayIntegrator(state) {" : `  step_${i}();`);
    }
    const chunks = chunkFile("src/orbit.js", lines.join("\n") + "\n");
    const holding = chunks.filter((c) => c.text.includes("orbitalDecayIntegrator"));
    assert.equal(holding.length, 2, "a symbol in the overlap belongs to two windows");
    assert.ok(holding[0].startLine < holding[1].startLine);
    assert.equal(holding[1].startLine, CHUNK_LINES - CHUNK_OVERLAP + 1);
  });
});

describe("the minified / generated heuristic", () => {
  test("a file of very long lines is rejected and a normal file of the SAME SIZE is not", () => {
    // Same byte count, different shape. A filename list would catch neither of
    // these (nothing here is called .min.js) — the shape is the signal.
    //
    // The long-lined file here is deliberately NOT one enormous line: every
    // line is 500 characters, under MAX_SINGLE_LINE, so only the MEAN rule can
    // reject it. An earlier version of this test used a single 76 KiB line,
    // which the single-line rule caught on its own — deleting the mean-line
    // check left the whole file green. Confirmed by mutation, and that is why
    // the two rules now have a case each.
    const wide = `${"payload(".repeat(62)}x${")".repeat(62)}`; // ~500 chars, no newline
    const dense = `${wide}\n`.repeat(200);
    const normal = [];
    while (normal.join("\n").length < dense.length) {
      normal.push("const someReasonableIdentifier = doSomething(withThis);");
    }
    const plain = normal.join("\n") + "\n";
    assert.ok(wide.length < MAX_SINGLE_LINE, "no single line here is long enough to be caught by itself");
    assert.ok(dense.length > HEURISTIC_MIN_BYTES && plain.length > HEURISTIC_MIN_BYTES);
    assert.ok(Math.abs(dense.length - plain.length) < dense.length * 0.1, "same size, different shape");
    assert.equal(rejectText(dense), "generated or minified");
    assert.equal(rejectText(plain), null);
  });

  test("a mostly-normal file holding one enormous line is rejected too", () => {
    // The other rule, and the one the mean cannot see: 1000 ordinary lines pull
    // the average down to ~50 while a single 12 KiB line sits in the middle.
    // That line alone is most of what the file would embed.
    const lines = [];
    for (let i = 0; i < 1000; i++) lines.push(`const value_${i} = lookup(${i});`);
    lines.splice(500, 0, `const blob = "${"A".repeat(MAX_SINGLE_LINE + 2000)}";`);
    const text = lines.join("\n") + "\n";
    assert.ok(text.length / splitLines(text).length < MAX_MEAN_LINE, "the mean cannot catch this one");
    assert.equal(rejectText(text), "generated or minified");
  });

  test("a small file with one long line is kept — the floor is about cost", () => {
    // Below the byte floor there is nothing to save by refusing, and refusing
    // would throw away a short file that happens to hold one long string.
    assert.equal(rejectText(`const url = "${"x".repeat(900)}";\n`), null);
  });

  test("an empty or whitespace-only file is rejected", () => {
    assert.equal(rejectText(""), "empty");
    assert.equal(rejectText("   \n\n\t\n"), "empty");
  });
});

describe("refreshing and searching", () => {
  test("every stored chunk's text matches those exact lines of the real file", async () => {
    // THE ASSERTION THIS MODULE EXISTS FOR. An index that returns a confident
    // line range pointing at the wrong code is worse than no index: somebody
    // opens the file, sees something unrelated, and stops trusting every other
    // answer. So the file is read BACK OFF THE DISK and sliced, rather than the
    // chunker being compared to itself.
    const { root, dir } = fixture();
    write(root, "src/long.js", numbered(187, "orbit"));
    write(root, "src/mid.js", numbered(45, "gamma"));
    write(root, "docs/readme.md", "# Title\n\nSome prose about the thing.\n");

    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const res = await idx.refresh();
    assert.equal(res.indexed, 3);
    assert.ok(res.chunks > 6);

    const { chunks } = readStore(dir);
    assert.equal(chunks.length, res.chunks);
    for (const c of chunks) {
      const lines = splitLines(readFileSync(path.join(root, ...c.path.split("/")), "utf8"));
      assert.ok(c.endLine <= lines.length, `${c.path}:${c.startLine}-${c.endLine} runs past line ${lines.length}`);
      assert.equal(
        c.text,
        lines.slice(c.startLine - 1, c.endLine).join("\n"),
        `${c.path}:${c.startLine}-${c.endLine} does not hold those lines`,
      );
    }
    await idx.close();
  });

  test("line numbers survive CRLF", async () => {
    const { root, dir } = fixture();
    write(root, "win.js", numbered(90, "crlf").replace(/\n/g, "\r\n"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const { chunks } = readStore(dir);
    const lines = splitLines(readFileSync(path.join(root, "win.js"), "utf8"));
    assert.equal(lines.length, 90);
    for (const c of chunks) {
      assert.ok(!c.text.includes("\r"), "CR must not reach the embedder");
      assert.equal(c.text, lines.slice(c.startLine - 1, c.endLine).join("\n"));
    }
    await idx.close();
  });

  test("the chunk that actually contains the query terms ranks first", async () => {
    const { root, dir } = fixture();
    // Three files of unrelated vocabulary, one of which holds the answer.
    write(root, "src/net.js", numbered(60, "socket"));
    write(root, "src/ui.js", numbered(60, "button"));
    write(
      root,
      "src/orbit.js",
      `${numbered(30, "filler")}function orbitalDecayIntegrator(state) {\n  return state.perigee * state.drag;\n}\n${numbered(30, "filler")}`,
    );

    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const hits = await idx.search("orbitalDecayIntegrator perigee drag");
    assert.ok(hits.length > 0);
    assert.equal(hits[0].path, "src/orbit.js");
    assert.ok(hits[0].text.includes("orbitalDecayIntegrator"));
    assert.ok(hits[0].score > 0);
    // Ranked, descending, and a cosine is never outside [-1, 1].
    for (let i = 1; i < hits.length; i++) assert.ok(hits[i].score <= hits[i - 1].score);
    for (const h of hits) assert.ok(h.score >= -1 && h.score <= 1);
    await idx.close();
  });

  test("k is respected and defaults to 6", async () => {
    const { root, dir } = fixture();
    for (let i = 0; i < 6; i++) write(root, `src/f${i}.js`, numbered(120, "shared"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const res = await idx.refresh();
    assert.ok(res.chunks > 12);
    assert.equal((await idx.search("shared compute")).length, 6);
    assert.equal((await idx.search("shared compute", { k: 3 })).length, 3);
    assert.equal((await idx.search("shared compute", { k: 1 })).length, 1);
    await idx.close();
  });

  test("filter restricts by path, as a RegExp or as a string", async () => {
    const { root, dir } = fixture();
    write(root, "src/alpha.js", numbered(60, "shared"));
    write(root, "vendor/beta.js", numbered(60, "shared"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();

    const all = await idx.search("shared compute", { k: 20 });
    assert.ok(all.some((h) => h.path.startsWith("src/")));
    assert.ok(all.some((h) => h.path.startsWith("vendor/")));

    for (const filter of [/^src\//, "^src/"]) {
      const some = await idx.search("shared compute", { k: 20, filter });
      assert.ok(some.length > 0);
      assert.ok(some.every((h) => h.path.startsWith("src/")));
    }
    await idx.close();
  });

  test("brief omits the chunk text and keeps the line range", async () => {
    const { root, dir } = fixture();
    write(root, "src/a.js", numbered(60, "shared"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const [hit] = await idx.search("shared compute", { brief: true });
    assert.equal(hit.text, undefined);
    assert.equal(typeof hit.startLine, "number");
    assert.equal(typeof hit.endLine, "number");
    assert.equal(typeof hit.score, "number");
    await idx.close();
  });

  test("an empty index returns [] rather than throwing", async () => {
    // The state every index is in before its first refresh finishes. A UI that
    // has to try/catch its own startup will swallow real errors too.
    const { root, dir } = fixture();
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    assert.deepEqual(await idx.search("anything at all"), []);
    assert.deepEqual(await idx.search(""), []);
    assert.deepEqual(idx.stats(), { files: 0, chunks: 0, bytes: 0, builtAt: null, dims: 128 });
    await idx.close();
  });

  test("searching an index whose files have since been deleted does not throw", async () => {
    // The store carries its own copy of the chunk text precisely so this works.
    // Re-reading the source at query time would either throw here or, worse,
    // return whatever now lives at those line numbers.
    const { root, dir } = fixture();
    write(root, "src/gone.js", numbered(60, "vanished"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    rmSync(path.join(root, "src"), { recursive: true, force: true });
    const hits = await idx.search("vanished compute");
    assert.ok(hits.length > 0);
    assert.ok(hits[0].text.includes("vanished"));
    await idx.close();
  });

  test("stats report what is in the index", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(50, "alpha"));
    write(root, "b.js", numbered(50, "beta"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder(64) });
    const before = idx.stats();
    assert.equal(before.builtAt, null);
    const res = await idx.refresh();
    const after = idx.stats();
    assert.equal(after.files, 2);
    assert.equal(after.chunks, res.chunks);
    assert.equal(after.dims, 64);
    assert.ok(after.bytes > 100);
    assert.ok(Number.isFinite(after.builtAt));
    await idx.close();
  });

  test("onProgress hears about scanning and embedding", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    const phases = new Set();
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh({ onProgress: (p) => phases.add(p.phase) });
    assert.ok(phases.has("scan"));
    assert.ok(phases.has("embed"));
    await idx.close();
  });

  test("a progress callback that throws does not lose the index", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const res = await idx.refresh({
      onProgress: () => {
        throw new Error("the UI blew up");
      },
    });
    assert.ok(res.chunks > 0);
    await idx.close();
  });
});

describe("what is not indexed", () => {
  test("binary files, oversized files and the skipped directories", async () => {
    const { root, dir } = fixture();
    write(root, "keep.js", numbered(40, "keep"));
    // A NUL in the first 8000 bytes: local-fs.js's sniff refuses it, and this
    // module never reads a file any other way.
    writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]));
    // Past local-fs.js's 512 KiB read cap.
    write(root, "huge.txt", `${"a line of perfectly ordinary text\n".repeat(20000)}`);
    write(root, "node_modules/dep/index.js", numbered(40, "dep"));
    write(root, ".git/COMMIT_EDITMSG", "a commit message\n");
    write(root, "dist/bundle.js", numbered(40, "bundled"));

    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const { meta } = readStore(dir);
    const indexedPaths = meta.files.filter((f) => f.count > 0).map((f) => f.path);
    assert.deepEqual(indexedPaths, ["keep.js"]);
    // The skipped directories are not even walked, so they leave no record;
    // the binary and the oversized file were looked at and refused.
    const byPath = new Map(meta.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("logo.png").skipped, true);
    assert.equal(byPath.get("huge.txt").skipped, true);
    assert.ok(!byPath.has("node_modules/dep/index.js"));
    assert.ok(!byPath.has(".git/COMMIT_EDITMSG"));
    await idx.close();
  });

  test("a minified file is skipped where a normal file of the same size is not", async () => {
    const { root, dir } = fixture();
    // 200 lines of 500 characters: long enough for the mean-line rule, short
    // enough that the single-line rule does not do the work for it.
    const wide = `${"payload(".repeat(62)}x${")".repeat(62)}`;
    const minified = `${wide}\n`.repeat(200);
    const plain = [];
    while (plain.join("\n").length < minified.length) {
      plain.push("const someReasonableIdentifier = doSomething(withThis);");
    }
    write(root, "bundle-3a91c.js", minified);
    write(root, "handwritten.js", plain.join("\n") + "\n");

    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const byPath = new Map(readStore(dir).meta.files.map((f) => [f.path, f]));
    assert.equal(byPath.get("bundle-3a91c.js").count, 0);
    assert.equal(byPath.get("bundle-3a91c.js").skipped, true);
    assert.ok(byPath.get("handwritten.js").count > 0);
    await idx.close();
  });

  test("a skipped file is not re-read on the next refresh", async () => {
    // The skip decision is cached on (size, mtimeMs) like everything else, so a
    // 400 KiB bundle is sniffed once rather than on every refresh.
    const { root, dir } = fixture();
    write(root, "bundle.js", "var a=1;".repeat(12000));
    const embedder = fakeEmbedder();
    const idx = await openIndex({ root, dir, embedder });
    await idx.refresh();
    const first = readStore(dir).meta.files[0];
    const res = await idx.refresh();
    assert.equal(res.skipped, 1);
    assert.deepEqual(readStore(dir).meta.files[0], first);
    await idx.close();
  });

  test("the store's own directory is not indexed when it sits inside the workspace", async () => {
    // A caller is entitled to put the store at <root>/.zevet — and without the
    // guard, refresh #2 indexes refresh #1's metadata, and so on.
    const base = path.join(TEMP, `nested${++seq}`);
    const root = path.join(base, "repo");
    const dir = path.join(root, ".zevet", "index");
    mkdirSync(dir, { recursive: true });
    write(root, "a.js", numbered(50, "alpha"));

    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const second = await idx.refresh();
    const { meta } = readStore(dir);
    assert.ok(meta.files.every((f) => !f.path.startsWith(".zevet")), JSON.stringify(meta.files.map((f) => f.path)));
    assert.equal(second.indexed, 1);
    await idx.close();
  });
});

describe("incremental refresh", () => {
  test("an unchanged file is not re-embedded", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    write(root, "b.js", numbered(120, "beta"));
    const embedder = fakeEmbedder();
    const idx = await openIndex({ root, dir, embedder });

    const first = await idx.refresh();
    const embeddedTexts = embedder.texts;
    assert.equal(embeddedTexts, first.chunks);

    const second = await idx.refresh();
    assert.equal(embedder.texts, embeddedTexts, "nothing changed, so nothing may be re-embedded");
    assert.equal(second.embedded, 0);
    assert.equal(second.reused, 2);
    assert.equal(second.chunks, first.chunks);
    await idx.close();
  });

  test("a changed file is replaced, not duplicated", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(100, "alpha"));
    write(root, "b.js", numbered(100, "beta"));
    const embedder = fakeEmbedder();
    const idx = await openIndex({ root, dir, embedder });
    const first = await idx.refresh();
    const afterFirst = embedder.texts;

    write(root, "a.js", numbered(100, "rewritten"));
    const second = await idx.refresh();

    assert.equal(second.embedded, 1, "only the changed file is embedded");
    assert.equal(second.reused, 1);
    assert.equal(second.chunks, first.chunks, "same shape of file, same number of chunks");
    assert.ok(embedder.texts > afterFirst);

    const { chunks } = readStore(dir);
    const mine = chunks.filter((c) => c.path === "a.js");
    // No duplicate line ranges, and none of the old content survives.
    const ranges = new Set(mine.map((c) => `${c.startLine}-${c.endLine}`));
    assert.equal(ranges.size, mine.length);
    assert.ok(mine.every((c) => !c.text.includes("alpha_")));
    assert.ok(mine.some((c) => c.text.includes("rewritten_")));
    // And the search agrees: the old vocabulary is gone from the index.
    assert.deepEqual(await idx.search("alpha_7 compute_alpha", { filter: /^a\.js$/, k: 5 }).then((h) => h.filter((x) => x.text.includes("alpha_"))), []);
    await idx.close();
  });

  test("a deleted file has its chunks removed", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(80, "alpha"));
    write(root, "b.js", numbered(80, "beta"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const first = await idx.refresh();

    rmSync(path.join(root, "b.js"));
    const second = await idx.refresh();

    assert.equal(second.removed, 1);
    assert.equal(second.indexed, 1);
    assert.ok(second.chunks < first.chunks);
    const { chunks, meta } = readStore(dir);
    assert.ok(chunks.every((c) => c.path !== "b.js"));
    assert.ok(meta.files.every((f) => f.path !== "b.js"));
    assert.deepEqual(await idx.search("beta compute", { filter: /^b\.js$/ }), []);
    await idx.close();
  });

  test("a file edited to be SHORTER leaves no orphaned chunks past its end", async () => {
    // The failure this guards against is the ugly one: chunks from the 200-line
    // version surviving into an index of a 20-line file, so a search answers
    // `short.js:150-190` for a file that ends at line 20.
    const { root, dir } = fixture();
    write(root, "short.js", numbered(200, "long"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const first = await idx.refresh();
    assert.ok(first.chunks >= 6);

    write(root, "short.js", numbered(20, "short"));
    const second = await idx.refresh();
    assert.equal(second.chunks, 1);

    const { chunks } = readStore(dir);
    const lines = splitLines(readFileSync(path.join(root, "short.js"), "utf8"));
    assert.equal(lines.length, 20);
    for (const c of chunks) {
      assert.ok(c.endLine <= lines.length, `orphan at ${c.startLine}-${c.endLine}`);
      assert.equal(c.text, lines.slice(c.startLine - 1, c.endLine).join("\n"));
    }
    // And every hit the index can now return is inside the file that exists.
    for (const h of await idx.search("short compute", { k: 20 })) {
      assert.ok(h.endLine <= lines.length);
    }
    await idx.close();
  });

  test("a reused file's VECTORS come across too, not just its chunk text", async () => {
    // Found by mutation, not by design: with the row-copy loop disabled, every
    // other test in this file still passed. Chunk text and line numbers were
    // carried over correctly and only the numbers in the .bin were zeros — so
    // an incremental refresh silently blanked every unchanged file out of the
    // rankings while reporting "reused: 2" and a full chunk count. The
    // searchable index, not the bookkeeping, is what has to be asserted.
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    write(root, "b.js", numbered(120, "beta"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    // Scoped to a.js: b.js is the file being rewritten, so its rows are
    // expected to move. a.js is the one that must come through untouched.
    const query = { filter: /^a\.js$/, brief: true, k: 10 };
    const before = await idx.search("alpha compute", query);
    assert.ok(before.length > 0 && before[0].score > 0.1, "the fixture must actually match the query");

    write(root, "b.js", numbered(120, "rewritten"));
    const res = await idx.refresh();
    assert.equal(res.reused, 1);

    const after = await idx.search("alpha compute", query);
    // Byte-identical vectors, so byte-identical scores. Anything else means the
    // rows moved without their contents.
    assert.deepEqual(after, before);
    await idx.close();
  });

  test("a new file is added without re-embedding the old ones", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const embedder = fakeEmbedder();
    const idx = await openIndex({ root, dir, embedder });
    await idx.refresh();
    const afterFirst = embedder.texts;

    write(root, "src/b.js", numbered(60, "beta"));
    const second = await idx.refresh();
    assert.equal(second.embedded, 1);
    assert.equal(second.reused, 1);
    assert.equal(embedder.texts - afterFirst, 2, "only the new file's two chunks");
    const hits = await idx.search("beta compute");
    assert.equal(hits[0].path, "src/b.js");
    await idx.close();
  });

  test("two refreshes at once is an error, not a race", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const running = idx.refresh();
    await assert.rejects(() => idx.refresh(), /already running/);
    await running;
    await idx.close();
  });
});

describe("the store on disk", () => {
  test("a reopened index is the same index, and re-embeds nothing", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    write(root, "b.js", numbered(45, "beta"));

    const first = fakeEmbedder();
    const idxA = await openIndex({ root, dir, embedder: first });
    const built = await idxA.refresh();
    const statsA = idxA.stats();
    const hitsA = await idxA.search("alpha compute", { brief: true });
    await idxA.close();

    const second = fakeEmbedder();
    const idxB = await openIndex({ root, dir, embedder: second });
    assert.deepEqual(idxB.stats(), statsA);
    const hitsB = await idxB.search("alpha compute", { brief: true });
    assert.deepEqual(hitsB, hitsA, "the same vectors must come back off the disk");

    const beforeRefresh = second.texts;
    const again = await idxB.refresh();
    assert.equal(second.texts - beforeRefresh, 0, "a reopened store re-embeds nothing unchanged");
    assert.equal(again.chunks, built.chunks);
    await idxB.close();
  });

  test("the metadata names one vectors file and old ones are swept", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const { meta } = readStore(dir);
    assert.equal(meta.version, FORMAT_VERSION);
    assert.equal(meta.dims, 128);
    assert.deepEqual(vectorFiles(dir), [meta.vectors]);
    assert.equal(
      readFileSync(path.join(dir, meta.vectors)).length,
      meta.chunkCount * meta.dims * 4,
    );

    write(root, "a.js", numbered(60, "second"));
    await idx.refresh();
    const after = readStore(dir).meta;
    assert.notEqual(after.vectors, meta.vectors, "each write lands under a fresh name");
    assert.deepEqual(vectorFiles(dir), [after.vectors], "and the old one is swept");
    assert.ok(readdirSync(dir).every((n) => !n.endsWith(".tmp")));
    await idx.close();
  });

  test("stored vectors are unit length — normalised once, at write time", async () => {
    // If this is ever false, `search`'s bare dot product stops being a cosine
    // and every score in the UI is wrong by an unknown factor.
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    const { meta } = readStore(dir);
    const buf = readFileSync(path.join(dir, meta.vectors));
    const ab = new ArrayBuffer(buf.length);
    Buffer.from(ab).set(buf);
    const vectors = new Float32Array(ab);
    for (let i = 0; i < meta.chunkCount; i++) {
      let sum = 0;
      for (let d = 0; d < meta.dims; d++) {
        const v = vectors[i * meta.dims + d];
        sum += v * v;
      }
      assert.ok(Math.abs(sum - 1) < 1e-5, `row ${i} has length ${Math.sqrt(sum)}`);
    }
    await idx.close();
  });

  test("a store written at another dimensionality is rebuilt, not misread", async () => {
    // The fatal one. 128-dim rows read as 64-dim rows are not an error, they
    // are nonsense that scores confidently.
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const wide = await openIndex({ root, dir, embedder: fakeEmbedder(128) });
    await wide.refresh();
    await wide.close();

    const narrowEmbedder = fakeEmbedder(64);
    const narrow = await openIndex({ root, dir, embedder: narrowEmbedder });
    assert.equal(narrow.stats().chunks, 0, "the 128-dim store must not be read as 64-dim");
    assert.deepEqual(await narrow.search("alpha compute"), []);
    const res = await narrow.refresh();
    assert.ok(res.chunks > 0);
    assert.equal(narrowEmbedder.texts, res.chunks, "everything is embedded afresh");
    assert.equal(readStore(dir).meta.dims, 64);
    await narrow.close();
  });

  test("the dims check catches a store whose vectors file is the RIGHT LENGTH for the wrong dims", async () => {
    // The previous test is passed by the byte-length check alone (a 128-dim
    // file is twice as long as a 64-dim one), so it does not prove the `dims`
    // comparison exists. This one does: the vectors file is cut to exactly the
    // length a 64-dim store of this many chunks would have, so every check but
    // `meta.dims !== dims` is satisfied and the rows are still 128-dim garbage.
    //
    // Confirmed by mutation: deleting the `meta.dims !== dims` line leaves this
    // the only red test in the file.
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    const wide = await openIndex({ root, dir, embedder: fakeEmbedder(128) });
    await wide.refresh();
    await wide.close();

    const { meta } = readStore(dir);
    truncateSync(path.join(dir, meta.vectors), meta.chunkCount * 64 * 4);

    const narrow = await openIndex({ root, dir, embedder: fakeEmbedder(64) });
    assert.equal(narrow.stats().chunks, 0);
    await narrow.close();
  });

  test("a store written by another format version is rebuilt", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    await idx.close();

    const meta = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    meta.version = FORMAT_VERSION + 99;
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(meta));

    const reopened = await openIndex({ root, dir, embedder: fakeEmbedder() });
    assert.equal(reopened.stats().chunks, 0);
    assert.ok((await reopened.refresh()).chunks > 0);
    assert.equal(readStore(dir).meta.version, FORMAT_VERSION);
    await reopened.close();
  });

  test("a truncated vectors file is detected on open and rebuilt", async () => {
    // What a crash partway through writing the vectors leaves behind. Reading
    // it as rows would attach every line range past the cut to the wrong
    // vector — a store that parses and lies.
    const { root, dir } = fixture();
    write(root, "a.js", numbered(180, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const built = await idx.refresh();
    await idx.close();

    const { meta } = readStore(dir);
    truncateSync(path.join(dir, meta.vectors), meta.dims * 4 * 2);

    const embedder = fakeEmbedder();
    const reopened = await openIndex({ root, dir, embedder });
    assert.equal(reopened.stats().chunks, 0, "a short vectors file is not half an index");
    const rebuilt = await reopened.refresh();
    assert.equal(rebuilt.chunks, built.chunks);
    assert.equal(embedder.texts, built.chunks);
    await reopened.close();
  });

  test("a missing vectors file, and unparseable metadata, are both rebuilt", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    await idx.close();

    const { meta } = readStore(dir);
    rmSync(path.join(dir, meta.vectors));
    const noVectors = await openIndex({ root, dir, embedder: fakeEmbedder() });
    assert.equal(noVectors.stats().chunks, 0);
    await noVectors.refresh();
    await noVectors.close();

    writeFileSync(path.join(dir, "index.json"), "{ this is not json");
    const badJson = await openIndex({ root, dir, embedder: fakeEmbedder() });
    assert.equal(badJson.stats().chunks, 0);
    assert.ok((await badJson.refresh()).chunks > 0);
    await badJson.close();
  });

  test("file records that do not tile the chunk array are rejected", async () => {
    // The check that makes "copy this file's rows across" safe: if the offsets
    // and counts do not exactly cover the chunks, a reuse would copy somebody
    // else's vectors under this file's line numbers.
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    await idx.close();

    const meta = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
    meta.files[0].count += 1;
    writeFileSync(path.join(dir, "index.json"), JSON.stringify(meta));

    const reopened = await openIndex({ root, dir, embedder: fakeEmbedder() });
    assert.equal(reopened.stats().chunks, 0);
    await reopened.close();
  });
});

describe("budget and cancellation", () => {
  test("hitting maxFiles is reported, not hidden", async () => {
    const { root, dir } = fixture();
    for (let i = 0; i < 6; i++) write(root, `f${i}.js`, numbered(30, `tag${i}`));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder(), budget: { maxFiles: 2 } });
    const res = await idx.refresh();
    assert.equal(res.budgetExceeded, true);
    assert.equal(res.limitHit, "files");
    assert.equal(res.indexed, 2);
    // Half an index is fine; half an index reported as a whole one is not.
    assert.equal(idx.stats().files, 2);
    await idx.close();
  });

  test("hitting maxChunks is reported, and no file is left half-indexed", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(200, "alpha")); // 7 chunks
    write(root, "b.js", numbered(200, "beta")); // 7 more, over the cap
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder(), budget: { maxChunks: 8 } });
    const res = await idx.refresh();
    assert.equal(res.budgetExceeded, true);
    assert.equal(res.limitHit, "chunks");
    assert.equal(res.indexed, 1);
    const { meta, chunks } = readStore(dir);
    assert.equal(chunks.length, res.chunks);
    assert.ok(res.chunks <= 8);
    // Whole files or none: a file recorded with a count it does not have would
    // be reused wholesale on the next refresh.
    const lines = splitLines(readFileSync(path.join(root, "a.js"), "utf8"));
    const mine = chunks.filter((c) => c.path === "a.js");
    assert.equal(mine.length, meta.files.find((f) => f.path === "a.js").count);
    assert.equal(mine[mine.length - 1].endLine, lines.length);
    await idx.close();
  });

  test("a refresh aborted before it starts leaves the previous index alone", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    const first = await idx.refresh();

    write(root, "b.js", numbered(60, "beta"));
    const ac = new AbortController();
    ac.abort();
    const res = await idx.refresh({ signal: ac.signal });
    assert.equal(res.aborted, true);
    assert.equal(res.chunks, first.chunks);
    assert.equal(idx.stats().chunks, first.chunks);
    assert.ok((await idx.search("alpha compute")).length > 0);
    await idx.close();
  });

  test("a refresh aborted mid-embedding leaves a readable store", async () => {
    // Nothing is written until the whole refresh succeeds, so "consistent"
    // here means the PREVIOUS index — intact, searchable, and still on disk for
    // the next process to open.
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const embedder = fakeEmbedder();
    const idx = await openIndex({ root, dir, embedder });
    const first = await idx.refresh();
    const beforeMeta = readStore(dir).meta;

    for (let i = 0; i < 5; i++) write(root, `big${i}.js`, numbered(200, `big${i}`));
    const ac = new AbortController();
    const realEmbed = embedder.embed.bind(embedder);
    embedder.embed = async (list) => {
      ac.abort(); // the user hits Escape while the first batch is in flight
      return realEmbed(list);
    };
    const res = await idx.refresh({ signal: ac.signal, onProgress: () => {} });
    embedder.embed = realEmbed;

    assert.equal(res.aborted, true);
    assert.equal(idx.stats().chunks, first.chunks);
    const hits = await idx.search("alpha compute");
    assert.ok(hits.length > 0);
    assert.deepEqual(readStore(dir).meta, beforeMeta, "an aborted refresh writes nothing");

    // And the next refresh, uncancelled, picks it all up.
    const done = await idx.refresh();
    assert.equal(done.aborted, false);
    assert.equal(done.indexed, 6);
    await idx.close();
  });
});

describe("refusals", () => {
  test("openIndex insists on a root, a store dir and an embedder with dims", async () => {
    const { root, dir } = fixture();
    await assert.rejects(() => openIndex({ dir, embedder: fakeEmbedder() }), /no root/);
    await assert.rejects(() => openIndex({ root, embedder: fakeEmbedder() }), /no store dir/);
    await assert.rejects(() => openIndex({ root, dir }), /no embedder/);
    await assert.rejects(() => openIndex({ root, dir, embedder: { embed: async () => [] } }), /no dims/);
    await assert.rejects(
      () => openIndex({ root, dir, embedder: { dims: 0, embed: async () => [] } }),
      /no dims/,
    );
  });

  test("an embedder returning the wrong dimensionality is refused, and nothing is written", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const liar = { dims: 128, embed: async (list) => list.map(() => new Float32Array(64)) };
    const idx = await openIndex({ root, dir, embedder: liar });
    await assert.rejects(() => idx.refresh(), /64 dims, expected 128/);
    assert.equal(idx.stats().chunks, 0);
    assert.ok(!readdirSync(dir).includes("index.json"), "a refused refresh writes no store");
    await idx.close();
  });

  test("an embedder returning the wrong NUMBER of vectors is refused", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(120, "alpha"));
    const liar = { dims: 8, embed: async () => [new Float32Array(8)] };
    const idx = await openIndex({ root, dir, embedder: liar });
    await assert.rejects(() => idx.refresh(), /wrong number of vectors/);
    await idx.close();
  });

  test("a refresh of a folder that is not there says so", async () => {
    const { dir } = fixture();
    const idx = await openIndex({ root: path.join(TEMP, "no-such-workspace"), dir, embedder: fakeEmbedder() });
    await assert.rejects(() => idx.refresh(), /no such folder/);
    await idx.close();
  });

  test("a closed index refuses to search or refresh", async () => {
    const { root, dir } = fixture();
    write(root, "a.js", numbered(60, "alpha"));
    const idx = await openIndex({ root, dir, embedder: fakeEmbedder() });
    await idx.refresh();
    await idx.close();
    await assert.rejects(() => idx.search("alpha"), /closed/);
    await assert.rejects(() => idx.refresh(), /closed/);
  });
});
