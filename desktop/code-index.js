// zevet desktop — a semantic index over the workspace the user has opened.
//
// WHERE THIS RUNS: the Electron MAIN process, over the teammate's own files,
// on their own machine. Nothing here reaches the network and nothing here is
// sent to the hub. The store it writes is a CACHE of the user's own source and
// lives wherever the caller says (`dir`), which is expected to be inside the
// app's userData, not inside the repo.
//
// ⚠️ THE EMBEDDING MODEL IS NOT IN THIS FILE AND MUST NEVER BE. `openIndex`
// takes an `embedder` — `{ dims: number, embed(texts): Promise<Float32Array[]> }`
// — as an injected dependency, and every test of this module runs against a
// twelve-line fake. That is deliberate and it is the most important structural
// fact here: a chunker, a store and a ranked scan are ordinary code with
// ordinary bugs (off-by-one line numbers, orphaned chunks after an edit, a
// store read back at the wrong dimensionality), and none of those bugs need a
// 90MB model on disk to reproduce. A suite that has to download a model is a
// suite that gets skipped in CI and then rots. See test/code-index.test.mjs.
//
// ⚠️ EVERY FILE READ GOES THROUGH `local-fs.js`'s `readTextFile`. Not through
// `fs` here. That function is where the workspace-containment check lives —
// the lexical check, the realpath re-check for in-workspace symlinks, the size
// cap and the binary sniff — and a second reader in this file would be a
// second place to get all of that wrong. The only `fs` calls below are against
// `dir`, the store's own directory, which is ours and not the user's source.
//
// CommonJS, because the Electron main process is and `main.js` requires this.
// No dependencies: no sqlite, no hnswlib, no vector database. See the store
// comment below for why that is a decision and not a limitation.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { listTree, readTextFile } = require("./local-fs.js");

/**
 * Bump this when the on-disk layout changes in a way an older reader would
 * misread. It is checked on open and a mismatch REBUILDS rather than reads —
 * the alternative, a best-effort migration, means every future version carries
 * code for every past one to save a rebuild the user never sees (it is a
 * background refresh over files that are already on their disk).
 */
const FORMAT_VERSION = 1;

/**
 * Chunk geometry, in LINES, because the answer this index gives is a line
 * range a person or an agent then opens.
 *
 * 40 lines with 10 of overlap (so the window advances 30 lines at a time).
 *
 * WHY 40: the small sentence-transformer class of models that will plausibly
 * sit behind `embedder` (MiniLM, bge-small, e5-small) have a 512-token window
 * and TRUNCATE SILENTLY past it. Source code runs roughly 8–14 tokens a line
 * once punctuation and identifier splitting are counted, so 40 lines is ~320–560
 * tokens: at the top of that range a chunk loses its tail, which is bad, and at
 * 80 lines it would lose half of every chunk, which is a wrong index that looks
 * like a working one. 40 is the largest size that mostly fits the smallest
 * plausible window.
 *
 * ⚠️ NOT MEASURED. That token-per-line figure is from reading code, not from
 * running a tokeniser over this repo, and the real embedder does not exist yet
 * (another task owns it). If it turns out to have a larger window, this number
 * should go up: more lines per chunk is fewer vectors and better context.
 *
 * WHY 10 OF OVERLAP: a function whose signature lands in the last lines of one
 * chunk and whose body is in the next is findable by neither unless the window
 * overlaps. 10 lines covers a signature plus a docstring's worth of body, which
 * is the common split. It costs 33% more vectors (30-line stride for a 40-line
 * window) and that is the price of not having a blind seam every 40 lines.
 *
 * REJECTED: chunking on syntax (functions, classes) with a parser. It is
 * better — a chunk that is exactly one function embeds far more cleanly — and
 * it needs a parser per language, which is a dependency per language, in a
 * process that runs with the user's full filesystem rights. Line windows are
 * language-agnostic and wrong in a boring, uniform way.
 */
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 10;

/**
 * How many chunks go to `embedder.embed` in one call. The embedder is free to
 * batch internally; this exists so that (a) cancellation has somewhere to be
 * noticed, (b) progress has something to report, and (c) a 12,000-chunk
 * workspace does not build one 12,000-element array of promises' worth of
 * intermediate Float32Arrays before a single one is written down.
 */
const EMBED_BATCH = 32;

/**
 * The "this is not source code" heuristic, and the reason it is a heuristic.
 *
 * A minified bundle (`editor.js`, 800 KiB on three lines) and a machine-written
 * lockfile are the two files in a repo that cost the most to embed and return
 * the least: they are one enormous token soup that matches every query weakly
 * and no query well. The tempting fix is a filename list — `*.min.js`,
 * `package-lock.json`, `yarn.lock` — and it is the wrong fix, because the list
 * is never finished: `bundle.js`, `vendor.js`, `app.abc123.js`, `pnpm-lock.yaml`,
 * a checked-in `.map`, somebody's generated `schema.ts`. What all of them
 * actually share is a shape: very few newlines for their size.
 *
 * So: a file of at least HEURISTIC_MIN_BYTES whose mean line is longer than
 * MAX_MEAN_LINE, or which holds any single line longer than MAX_SINGLE_LINE, is
 * not indexed. Hand-written code averages 30–60 characters a line; prose and
 * markdown reach maybe 120 in a file with no hard wrapping. 160 leaves room
 * above both and is far below the thousands a minified file hits.
 *
 * ⚠️ WHAT THIS GETS WRONG, said out loud: a small pretty-printed
 * `package-lock.json` (short lines, under the byte floor or under the mean) IS
 * indexed. That is accepted — the heuristic is about COST, and a small lockfile
 * costs little. A hand-written file with one 10k-character embedded data URI is
 * rejected, which is a real false positive; it loses one file from the index
 * and nothing else. Neither has been measured against a corpus, only reasoned
 * about and tested against the two synthetic cases in the suite.
 */
const HEURISTIC_MIN_BYTES = 4 * 1024;
const MAX_MEAN_LINE = 160;
const MAX_SINGLE_LINE = 10000;

/**
 * Defaults for `budget`. The real numbers come from the capability module,
 * which owns what the user has agreed to; these exist so this module is usable
 * (and testable) on its own and so there is a documented ceiling if a caller
 * forgets to pass one.
 *
 * 1500 files / 12000 chunks is about a medium repo. The ceiling that matters is
 * memory: chunk text is held in RAM and written into the metadata JSON, so
 * 12000 chunks of ~40 lines is on the order of 20–30 MB of text. That is a lot
 * for a JSON file and it is the honest cost of the format chosen below.
 */
const DEFAULT_BUDGET = { maxFiles: 1500, maxChunks: 12000 };

/**
 * `listTree` walks with its own entry cap (4000). A budget larger than that
 * would be silently unreachable, so the walk is given room for the budget plus
 * the directories that hold it. Still capped: this is a synchronous walk on the
 * main process and `local-fs.js` says so.
 */
function treeCap(maxFiles) {
  return Math.min(40000, Math.max(4000, maxFiles * 4));
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Splits text into lines the way the rest of this file counts them, and the way
 * `repo-stats.js`'s `countLines` counts them: a trailing newline terminates the
 * last line rather than starting an empty one, and an empty file has no lines.
 *
 * CR IS STRIPPED. Line NUMBERS are unaffected either way, but the chunk text
 * that gets embedded is not: the same file checked out on Windows and on macOS
 * would otherwise produce different bytes, different vectors and different
 * rankings for the same code. A test that reads a file back to verify a chunk's
 * line range has to normalise the same way — see the note on `chunkText` in the
 * suite.
 */
function splitLines(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith("\r")) lines[i] = lines[i].slice(0, -1);
  }
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The chunks of one file: `{ path, startLine, endLine, text }`, line numbers
 * 1-BASED and INCLUSIVE, which is what an editor shows and what `file.ts:120`
 * means to a person.
 *
 * The invariant this function exists to hold: `text` is exactly
 * `splitLines(fileText).slice(startLine - 1, endLine).join("\n")`. An index
 * that returns a confident line range pointing at the wrong code is worse than
 * no index at all — a person opens the file, sees something unrelated, and
 * stops trusting every other answer. The suite asserts this by reading the file
 * back off the disk for every chunk of every fixture rather than by comparing
 * this function to itself.
 *
 * A chunk that is entirely blank is dropped: it embeds to noise (or to a zero
 * vector) and can only ever be a bad hit.
 */
function chunkFile(relPath, text) {
  const lines = splitLines(text);
  const out = [];
  const stride = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const slice = lines.slice(start, end);
    // `.join("")` rather than `.join("\n")` for the emptiness test: cheaper and
    // the question is only whether there is any non-whitespace at all.
    if (slice.join("").trim() !== "") {
      out.push({
        path: relPath,
        startLine: start + 1,
        endLine: end,
        text: slice.join("\n"),
      });
    }
    // Without this, a file of 45 lines would emit 1–40, 31–45 and then 61–45,
    // i.e. nothing; with a shorter stride it would emit a final chunk wholly
    // contained in the one before it. Stop as soon as a chunk reaches the end.
    if (end >= lines.length) break;
  }
  return out;
}

/**
 * Is this text worth indexing? Returns `null` for yes, or a short reason.
 * See the HEURISTIC constants above for why the shape and not the filename.
 */
function rejectText(text) {
  if (text.trim() === "") return "empty";
  if (text.length < HEURISTIC_MIN_BYTES) return null;
  const lines = splitLines(text);
  if (lines.length === 0) return "empty";
  if (text.length / lines.length > MAX_MEAN_LINE) return "generated or minified";
  for (const line of lines) {
    if (line.length > MAX_SINGLE_LINE) return "generated or minified";
  }
  return null;
}

/**
 * Normalises a vector IN PLACE to unit length and returns it.
 *
 * ⚠️ THIS HAPPENS ONCE, AT WRITE TIME, AND NEVER AT QUERY TIME. Cosine
 * similarity is `dot(a,b) / (|a||b|)`; if both vectors are already unit length
 * it is just `dot(a,b)`. Normalising on read would mean computing a square root
 * and a division per stored chunk per query — for a 12,000-chunk index that is
 * 12,000 extra sqrt calls on every keystroke of a search-as-you-type box, to
 * recompute a number that cannot have changed since it was written. The stored
 * file is therefore defined as holding UNIT vectors, and `search` does a bare
 * dot product.
 *
 * A zero vector (a chunk of punctuation, or a fake embedder handed a word it
 * has never seen) has no direction. It is left as zeros, which scores 0 against
 * everything — the honest answer — rather than being turned into NaNs by a
 * division by zero, which would poison the sort.
 */
function normalise(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  if (sum === 0) return vec;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  return vec;
}

/** An index with nothing in it. Also what a rejected store load returns. */
function emptyState(dims) {
  return { dims, builtAt: null, bytes: 0, files: [], chunks: [], vectors: new Float32Array(0) };
}

/**
 * THE STORE FORMAT, and why it is two files and not a database.
 *
 *   dir/index.json           metadata: version, dims, the per-file (size,
 *                            mtimeMs) cache keys, and every chunk's line range
 *                            and text.
 *   dir/vectors-<stamp>.bin  one flat Float32Array, `chunkCount * dims` floats,
 *                            row `i` being chunk `i`, already unit-normalised.
 *
 * WHY NOT A DATABASE: sqlite (or any vector store worth the name) is a NATIVE
 * dependency, which in Electron means a binary compiled against the exact ABI
 * of the exact Electron version, rebuilt per platform, shipped in the installer
 * and re-broken by every Electron upgrade. The desktop app currently has zero
 * dependencies beyond Electron itself and every one of them would run with the
 * user's full filesystem rights. A brute-force scan over a flat array needs
 * none of that, and see `search` for the size at which that stops being true.
 *
 * WHY THE VECTORS ARE NOT IN THE JSON: 12,000 × 384 floats as JSON numbers is
 * ~40 MB of decimal text to parse on every open and it loses precision on the
 * way in and out. As raw little-endian f32 it is a 18 MB read straight into a
 * typed array.
 *
 * ⚠️ THE .bin IS PLATFORM-ENDIAN, so it is not portable between machines of
 * different endianness. Accepted without hesitation: it is a cache of the
 * user's own files, rebuilt from those files, and it never leaves the machine
 * that wrote it. (Every platform Electron ships on is little-endian anyway.)
 *
 * WHY THE CHUNK TEXT IS IN THE JSON rather than re-read from the source at
 * query time: the file may have changed or been deleted since it was indexed,
 * and re-reading it would return the CURRENT lines 120–160 under a line range
 * that was computed against the OLD file. That is the confident-wrong-answer
 * failure this module refuses to ship. It costs a copy of (an overlapping view
 * of) the indexed source on disk, which is the largest single cost of this
 * design and is stated here rather than discovered later.
 *
 * WHY THE .bin FILENAME CARRIES A RANDOM STAMP: the two files must agree, and a
 * crash between two renames must not leave a new vector file beside an old
 * metadata file that happens to describe the same NUMBER of chunks — the length
 * check would pass and every line range would be attached to the wrong vector.
 * With the vectors' name written inside the metadata, the metadata rename is
 * the single commit point: whatever `index.json` names is what it was written
 * against, and an interrupted write leaves an unreferenced `vectors-*.bin` that
 * the next successful write sweeps up.
 */
function metaPath(dir) {
  return path.join(dir, "index.json");
}

function isVectorFile(name) {
  return /^vectors-[0-9a-f]+\.bin$/.test(name);
}

/**
 * Reads the store, or returns an empty state.
 *
 * EVERY failure here is "rebuild", never "throw" and never "use it anyway". The
 * store is a cache; the source of truth is the user's files, which are still
 * there. The failures that are actually checked for, each of which has a test:
 * no store at all, unparseable JSON, a format version we do not speak, a `dims`
 * that is not this embedder's (the fatal one — a 384-dim store read as 768-dim
 * rows is not an error, it is nonsense that scores confidently), a vectors file
 * whose length does not match `chunkCount * dims * 4` (the truncated-write
 * case), a missing vectors file, and file records whose offsets do not tile the
 * chunk array exactly.
 */
function loadStore(dir, dims) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath(dir), "utf8");
  } catch {
    return emptyState(dims);
  }

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return emptyState(dims);
  }

  if (!meta || typeof meta !== "object") return emptyState(dims);
  if (meta.version !== FORMAT_VERSION) return emptyState(dims);
  if (meta.dims !== dims) return emptyState(dims);
  if (!Array.isArray(meta.files) || !Array.isArray(meta.chunks)) return emptyState(dims);
  if (typeof meta.vectors !== "string" || !isVectorFile(meta.vectors)) return emptyState(dims);

  // The file records must tile the chunk array exactly: contiguous, in order,
  // ending at its length. Anything else and a "reuse this file's rows" copy
  // below would read somebody else's vectors.
  let cursor = 0;
  const files = [];
  for (const f of meta.files) {
    if (!f || typeof f.path !== "string") return emptyState(dims);
    if (!Number.isFinite(f.size) || !Number.isFinite(f.mtimeMs)) return emptyState(dims);
    if (!Number.isInteger(f.offset) || !Number.isInteger(f.count) || f.count < 0) return emptyState(dims);
    if (f.offset !== cursor) return emptyState(dims);
    cursor += f.count;
    files.push({
      path: f.path,
      size: f.size,
      mtimeMs: f.mtimeMs,
      offset: f.offset,
      count: f.count,
      skipped: f.skipped === true,
    });
  }
  if (cursor !== meta.chunks.length) return emptyState(dims);

  // Chunk rows are stored WITHOUT their path — it is the owning file record's,
  // and storing it twice is both bigger and a second spelling that can disagree
  // with the first. It is materialised here because `search` wants it per row.
  const chunks = [];
  for (const f of files) {
    for (let i = 0; i < f.count; i++) {
      const row = meta.chunks[f.offset + i];
      if (!Array.isArray(row) || row.length !== 3) return emptyState(dims);
      const [startLine, endLine, text] = row;
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return emptyState(dims);
      if (startLine < 1 || endLine < startLine || typeof text !== "string") return emptyState(dims);
      chunks.push({ path: f.path, startLine, endLine, text });
    }
  }

  let buf;
  try {
    buf = fs.readFileSync(path.join(dir, meta.vectors));
  } catch {
    return emptyState(dims);
  }
  // THE TRUNCATED-WRITE CHECK. A crash partway through writing the vectors
  // leaves a short file; reading it as rows would silently attach chunk N's
  // line range to chunk N-1's meaning for everything past the cut.
  if (buf.length !== chunks.length * dims * 4) return emptyState(dims);

  // Copied into a fresh ArrayBuffer rather than viewed in place: Node pools
  // small Buffers, so `buf.byteOffset` need not be a multiple of 4 and a
  // Float32Array view onto it would throw (or, worse, be right in testing and
  // throw on a user's machine).
  const ab = new ArrayBuffer(buf.length);
  Buffer.from(ab).set(buf);

  return {
    dims,
    builtAt: Number.isFinite(meta.builtAt) ? meta.builtAt : null,
    bytes: Number.isFinite(meta.bytes) ? meta.bytes : 0,
    files,
    chunks,
    vectors: new Float32Array(ab),
  };
}

/**
 * Writes the store. Temp file then rename, exactly as `local-fs.js` does, and
 * for the same reason: a crash mid-write must leave the previous store intact
 * rather than a half-written one, because a half-written store that still
 * parses is an index that lies.
 *
 * Order matters and is the whole design: vectors first under a name nothing
 * references yet, then the metadata that names it. Until that last rename lands
 * the store on disk is entirely the old one; after it, entirely the new one.
 *
 * ⚠️ NOT VERIFIED and not verifiable from a test suite: `fsyncSync` reaching
 * the platter is fsync's documented contract, not something observed here, and
 * the directory entry is not fsynced (Windows will not hand out a directory
 * fd). A crash in the microsecond after the rename can lose the rename on some
 * filesystems, which leaves the previous store — the acceptable half.
 */
function saveStore(dir, state) {
  const stamp = crypto.randomBytes(8).toString("hex");
  const vectorName = `vectors-${stamp}.bin`;

  const meta = {
    version: FORMAT_VERSION,
    dims: state.dims,
    builtAt: state.builtAt,
    bytes: state.bytes,
    vectors: vectorName,
    chunkCount: state.chunks.length,
    files: state.files,
    chunks: state.chunks.map((c) => [c.startLine, c.endLine, c.text]),
  };

  writeAtomic(
    path.join(dir, vectorName),
    Buffer.from(state.vectors.buffer, state.vectors.byteOffset, state.vectors.byteLength),
  );
  writeAtomic(metaPath(dir), Buffer.from(JSON.stringify(meta), "utf8"));

  // Sweep the vector files no metadata points at any more: the one this write
  // replaced, plus anything an interrupted earlier write left behind. Failures
  // are ignored — a leftover file costs disk, and refusing the write because a
  // stale file could not be deleted would cost the index.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === vectorName) continue;
      if (isVectorFile(name) || /^vectors-[0-9a-f]+\.bin\.tmp$/.test(name)) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          /* it is only disk */
        }
      }
    }
  } catch {
    /* the store still landed; the sweep is housekeeping */
  }
}

function writeAtomic(target, buf) {
  // Same directory as the target, always: a rename across devices is not atomic
  // and on most platforms is not even permitted.
  const tmp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already on the way down */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* it may never have been created */
    }
    throw err;
  }
}

/**
 * Is `rel` (a forward-slashed path relative to the workspace root) inside the
 * store's own directory?
 *
 * This exists because a caller is entitled to put `dir` inside the workspace —
 * `<root>/.zevet/index` is a reasonable place for it — and without this check
 * the first refresh would index its own metadata JSON, the second would index
 * the first one's copy of it, and the store would grow by roughly itself every
 * time. `listTree` cannot know: it skips by basename and `.zevet` is not on its
 * list.
 */
function underStore(relFromRoot, rel) {
  if (relFromRoot === null) return false;
  if (relFromRoot === "") return true; // dir IS the root: nothing is indexable
  return rel === relFromRoot || rel.startsWith(`${relFromRoot}/`);
}

/**
 * Opens (or creates) the index for one workspace.
 *
 * @param {object} opts
 * @param {string} opts.root       the workspace root, as `local-fs.js` means it
 * @param {string} opts.dir        where the store lives; created if absent
 * @param {{dims:number, embed:(texts:string[])=>Promise<Float32Array[]>}} opts.embedder
 * @param {{maxFiles?:number, maxChunks?:number}} [opts.budget]
 * @returns {Promise<object>} the Index
 */
async function openIndex({ root, dir, embedder, budget } = {}) {
  if (typeof root !== "string" || root.length === 0) throw new Error("code-index: no root given");
  if (typeof dir !== "string" || dir.length === 0) throw new Error("code-index: no store dir given");
  if (!embedder || typeof embedder.embed !== "function") {
    throw new Error("code-index: no embedder given");
  }
  const dims = embedder.dims;
  if (!Number.isInteger(dims) || dims <= 0) throw new Error("code-index: embedder has no dims");

  const limits = {
    maxFiles: positiveInt(budget && budget.maxFiles, DEFAULT_BUDGET.maxFiles),
    maxChunks: positiveInt(budget && budget.maxChunks, DEFAULT_BUDGET.maxChunks),
  };

  fs.mkdirSync(dir, { recursive: true });

  // Where the store sits relative to the workspace, so the walk can step over
  // it. `path.relative` gives a `..`-leading path when `dir` is outside, which
  // is the normal case and means "nothing to skip".
  let relFromRoot = null;
  try {
    const absRoot = fs.realpathSync(path.resolve(root));
    const absDir = fs.realpathSync(path.resolve(dir));
    const rel = path.relative(absRoot, absDir);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) relFromRoot = rel.split(path.sep).join("/");
  } catch {
    relFromRoot = null;
  }

  let state = loadStore(dir, dims);
  let closed = false;
  let refreshing = false;

  function assertOpen() {
    if (closed) throw new Error("code-index: index is closed");
  }

  /**
   * Walks the workspace and brings the store up to date.
   *
   * THE INCREMENTAL RULE, keyed on (size, mtimeMs) per file exactly as
   * `repo-stats.js`'s `LineCounter` is keyed: a file whose size and mtime match
   * what the store recorded is not re-read and not re-embedded — its existing
   * chunks and its existing vector ROWS are copied straight across.
   *
   * The whole index is REBUILT INTO A NEW ARRAY each time rather than patched
   * in place, and that is the point: a deleted file is simply a file the walk
   * did not produce, a changed file's old chunks are not carried over so they
   * cannot be duplicated, and a file edited from 200 lines to 20 cannot leave
   * a chunk claiming lines 150–190 of a file that ends at 20. Patching in place
   * would need a free-list, a compaction pass and three chances to leave an
   * orphan; copying costs one pass over an array of small objects and a couple
   * of `TypedArray.set` calls, which is nothing next to the embedding it saves.
   *
   * ⚠️ mtime granularity is one second on some filesystems, so a file rewritten
   * to the SAME SIZE inside the same second reads as unchanged and keeps its
   * old chunks. This is `LineCounter`'s documented limitation and it is
   * inherited deliberately: the alternative is hashing every file on every
   * refresh, which is the cost the cache exists to avoid. The next real edit
   * fixes it.
   *
   * @param {{onProgress?:Function, signal?:AbortSignal}} [opts]
   */
  async function refresh(opts = {}) {
    assertOpen();
    if (refreshing) throw new Error("code-index: a refresh is already running");
    refreshing = true;
    const started = Date.now();
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const signal = opts.signal || null;

    const report = (phase, done, total, file) => {
      if (!onProgress) return;
      try {
        onProgress({ phase, done, total, path: file || null });
      } catch {
        // A progress callback that throws is the caller's problem, not a reason
        // to abandon a half-built index.
      }
    };

    try {
      const tree = listTree(root, { maxEntries: treeCap(limits.maxFiles) });
      if (!tree.ok) throw new Error(`code-index: ${tree.error}`);

      const previous = new Map(state.files.map((f) => [f.path, f]));
      const seen = new Set();
      const files = [];
      const chunks = [];
      /** Rows to copy from the old vectors: {from, to, count} in ROWS. */
      const copies = [];
      /** Chunks that need embedding: their index in `chunks`. */
      const pending = [];

      let indexed = 0;
      let skipped = 0;
      let embeddedFiles = 0;
      let reusedFiles = 0;
      let bytes = 0;
      let budgetExceeded = false;
      let limitHit = null;
      let aborted = false;

      const fileEntries = tree.entries.filter((e) => e.kind === "file");
      const total = fileEntries.length;
      if (tree.truncated) {
        budgetExceeded = true;
        limitHit = "tree";
      }

      let scanned = 0;
      for (const entry of fileEntries) {
        if (signal && signal.aborted) {
          aborted = true;
          break;
        }
        if (underStore(relFromRoot, entry.path)) continue;
        if (files.length >= limits.maxFiles) {
          budgetExceeded = true;
          limitHit = "files";
          break;
        }

        scanned++;
        report("scan", scanned, total, entry.path);

        const record = { path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs, offset: chunks.length, count: 0, skipped: false };
        const before = previous.get(entry.path);
        seen.add(entry.path);

        // ── unchanged ────────────────────────────────────────────────────────
        if (before && before.size === entry.size && before.mtimeMs === entry.mtimeMs) {
          if (before.skipped) {
            // A file we already decided not to index is not re-read either. It
            // keeps its record so the decision is remembered rather than
            // re-derived from a fresh read of a 400 KiB bundle every refresh.
            record.skipped = true;
            files.push(record);
            skipped++;
            continue;
          }
          if (chunks.length + before.count > limits.maxChunks) {
            budgetExceeded = true;
            limitHit = "chunks";
            break;
          }
          copies.push({ from: before.offset, to: chunks.length, count: before.count });
          for (let i = 0; i < before.count; i++) chunks.push(state.chunks[before.offset + i]);
          record.count = before.count;
          files.push(record);
          indexed++;
          reusedFiles++;
          bytes += entry.size;
          continue;
        }

        // ── new or changed ───────────────────────────────────────────────────
        // Through readTextFile, never through `fs` — it is the one place the
        // containment check, the size cap and the binary sniff live. Its
        // refusals (binary, too big, vanished mid-walk, unreadable) are all
        // "skip this file", which is why none of them are distinguished here.
        const read = readTextFile(root, entry.path);
        if (!read.ok) {
          record.skipped = true;
          files.push(record);
          skipped++;
          continue;
        }
        if (rejectText(read.text)) {
          record.skipped = true;
          files.push(record);
          skipped++;
          continue;
        }

        const made = chunkFile(entry.path, read.text);
        if (made.length === 0) {
          record.skipped = true;
          files.push(record);
          skipped++;
          continue;
        }
        if (chunks.length + made.length > limits.maxChunks) {
          // The whole file or none of it. Half a file's chunks would make the
          // record's `count` a lie the next refresh would reuse.
          budgetExceeded = true;
          limitHit = "chunks";
          break;
        }
        for (const c of made) {
          pending.push(chunks.length);
          chunks.push(c);
        }
        record.count = made.length;
        files.push(record);
        indexed++;
        embeddedFiles++;
        bytes += entry.size;
      }

      // ── embedding ──────────────────────────────────────────────────────────
      const vectors = new Float32Array(chunks.length * dims);
      if (!aborted) {
        for (let i = 0; i < pending.length; i += EMBED_BATCH) {
          if (signal && signal.aborted) {
            aborted = true;
            break;
          }
          const slice = pending.slice(i, i + EMBED_BATCH);
          const out = await embedder.embed(slice.map((idx) => chunks[idx].text));
          if (!Array.isArray(out) || out.length !== slice.length) {
            throw new Error("code-index: embedder returned the wrong number of vectors");
          }
          for (let j = 0; j < slice.length; j++) {
            const vec = out[j];
            if (!vec || typeof vec.length !== "number" || vec.length !== dims) {
              throw new Error(`code-index: embedder returned ${vec ? vec.length : "no"} dims, expected ${dims}`);
            }
            // Copied into our own row and normalised THERE, once. The embedder
            // is not trusted to have returned a unit vector and is not asked to
            // — see `normalise`.
            const at = slice[j] * dims;
            for (let d = 0; d < dims; d++) vectors[at + d] = vec[d];
            normalise(vectors.subarray(at, at + dims));
          }
          report("embed", Math.min(i + slice.length, pending.length), pending.length, null);
        }
      }

      // ── cancellation ───────────────────────────────────────────────────────
      // An aborted refresh throws the half-built arrays away and leaves the
      // previous index in place, in memory and on disk. The alternative — write
      // the partial — is also "consistent", but it would mean a user who hits
      // Escape ends up with a SMALLER index than before they started, and then
      // has to guess why searches stopped finding things. Nothing was written,
      // so nothing can be corrupt.
      if (aborted) {
        return {
          indexed: 0, embedded: 0, reused: 0, skipped: 0, removed: 0,
          chunks: state.chunks.length,
          tookMs: Date.now() - started,
          budgetExceeded: false, limitHit: null, aborted: true,
        };
      }

      // Rows carried over from the old store, in `TypedArray.set` blocks. Done
      // after the embedding loop so that a throw from the embedder leaves the
      // old `state.vectors` untouched (it is the source of these copies).
      for (const c of copies) {
        if (c.count === 0) continue;
        vectors.set(state.vectors.subarray(c.from * dims, (c.from + c.count) * dims), c.to * dims);
      }

      let removed = 0;
      for (const f of state.files) {
        if (!seen.has(f.path) && !f.skipped) removed++;
      }

      state = { dims, builtAt: Date.now(), bytes, files, chunks, vectors };
      saveStore(dir, state);

      return {
        indexed,
        embedded: embeddedFiles,
        reused: reusedFiles,
        skipped,
        removed,
        chunks: chunks.length,
        tookMs: Date.now() - started,
        budgetExceeded,
        limitHit,
        aborted: false,
      };
    } finally {
      refreshing = false;
    }
  }

  /**
   * The k nearest chunks to `query`.
   *
   * BRUTE FORCE, on purpose. One pass, one dot product of `dims` multiply-adds
   * per chunk, over a contiguous Float32Array. At the 12,000-chunk / 384-dim
   * default budget that is ~4.6M multiply-adds a query.
   *
   * ⚠️ NOT MEASURED — I have not benchmarked this, at any size, and the real
   * embedder does not exist yet to measure it against. The reasoning is that a
   * few million float operations over contiguous memory is single-digit
   * milliseconds on any machine that can run Electron, and that the embedding
   * of the QUERY (one forward pass of a transformer) dominates it by an order
   * of magnitude, which makes an ANN index (HNSW, IVF) pure cost here: a native
   * dependency and an approximate answer to make the cheap half of the query
   * cheaper. If the budget is ever raised into the hundreds of thousands of
   * chunks, measure before believing this paragraph.
   *
   * @param {string} query
   * @param {{k?:number, filter?:RegExp|string, brief?:boolean}} [opts]
   */
  async function search(query, opts = {}) {
    assertOpen();
    const k = positiveInt(opts.k, 6);
    // An empty index answers "nothing", not an exception. It is the state every
    // index is in before its first refresh finishes, and a UI that has to
    // try/catch its own startup is a UI that will swallow real errors too.
    if (state.chunks.length === 0) return [];
    if (typeof query !== "string" || query.trim() === "") return [];

    let filter = null;
    if (opts.filter instanceof RegExp) filter = opts.filter;
    else if (typeof opts.filter === "string" && opts.filter !== "") filter = new RegExp(opts.filter);

    const out = await embedder.embed([query]);
    if (!Array.isArray(out) || out.length !== 1 || !out[0] || out[0].length !== dims) {
      throw new Error("code-index: embedder returned an unusable query vector");
    }
    // A copy, because normalising in place would mutate whatever the embedder
    // handed over — which it may well be caching.
    const q = normalise(Float32Array.from(out[0]));

    // Top-k by insertion into a k-long array rather than sorting everything:
    // k is 6, so this is ~6 comparisons per surviving chunk against an O(n log
    // n) sort of 12,000 objects, and it never allocates per row.
    const best = [];
    for (let i = 0; i < state.chunks.length; i++) {
      const chunk = state.chunks[i];
      if (filter && !filter.test(chunk.path)) continue;
      let dot = 0;
      const at = i * dims;
      for (let d = 0; d < dims; d++) dot += q[d] * state.vectors[at + d];
      if (best.length === k && dot <= best[best.length - 1].score) continue;
      const row = { i, score: dot };
      let pos = best.length;
      while (pos > 0 && best[pos - 1].score < dot) pos--;
      best.splice(pos, 0, row);
      if (best.length > k) best.pop();
    }

    return best.map(({ i, score }) => {
      const chunk = state.chunks[i];
      const hit = {
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        // Both vectors are unit length, so the dot product IS the cosine.
        // Clamped because float error can put it a hair outside [-1, 1] and a
        // similarity of 1.0000001 in a UI reads as a bug.
        score: Math.max(-1, Math.min(1, score)),
      };
      if (!opts.brief) hit.text = chunk.text;
      return hit;
    });
  }

  /** What is in the index right now. `bytes` is of the SOURCE indexed, not of
   *  the store — it is the number a person can compare to their repo. */
  function stats() {
    return {
      files: state.files.filter((f) => f.count > 0).length,
      chunks: state.chunks.length,
      bytes: state.bytes,
      builtAt: state.builtAt,
      dims,
    };
  }

  /**
   * Drops the in-memory arrays. Nothing is flushed here because nothing is ever
   * left unflushed: `refresh` writes the store before it returns, so there is
   * no window in which closing could lose work.
   */
  async function close() {
    closed = true;
    state = emptyState(dims);
  }

  return { refresh, search, stats, close };
}

module.exports = {
  openIndex,
  // Exported for the tests and for whoever tunes them, so the suite asserts
  // against the real constants instead of copies that can drift.
  chunkFile,
  splitLines,
  rejectText,
  normalise,
  FORMAT_VERSION,
  CHUNK_LINES,
  CHUNK_OVERLAP,
  DEFAULT_BUDGET,
  MAX_MEAN_LINE,
  MAX_SINGLE_LINE,
  HEURISTIC_MIN_BYTES,
};
