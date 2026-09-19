// zevet desktop — text in, vectors out. The one part of the code index that
// needs a machine learning runtime.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CONSTRAINT THAT SHAPED EVERY LINE BELOW
//
// Andrew: "make sure it only runs on boxes that can handle it, otherwise zevet
// should still work". Until this file existed, `desktop/local-fs.js` could say
// truthfully that the app has no dependencies beyond Electron. This file adds
// a NATIVE one — ONNX Runtime, a 28MB C++ DLL loaded through N-API — and a
// native module has failure modes that pure JavaScript does not: a missing
// prebuild for the user's platform, a .node file built against a different
// ABI, a DLL whose own dependencies are absent, an antivirus product that
// quarantines it mid-load. Any of those throws from inside `require`.
//
// So the rule here is absolute and it is not negotiable by anything downstream:
//
//   ⚠️ NOTHING IN THIS FILE MAY PREVENT zevet FROM STARTING.
//
// Which cashes out as three mechanical properties, each of which has a test:
//
//   1. `require("./embedder.js")` costs nothing and cannot throw. The heavy
//      module is loaded INSIDE `createEmbedder`, inside a try/catch. This file
//      requires only node builtins at the top. If the runtime is not installed
//      at all — which is the NORMAL state, because it is an optional
//      dependency — you find that out when you call, not when you load.
//   2. `createEmbedder` never rejects and never throws. Every path returns
//      `{ok:false, error}` with an `error` written for a person to read, not
//      for a log. The caller's correct response to `ok:false` is always the
//      same: do not offer the index, carry on.
//   3. The model is not in the installer and a half-fetched model never looks
//      like a whole one. See `ensureModel`.
//
// This is the same fail-to-empty contract `repo-stats.js` has for git and
// `status-sources.js` has for the vault — a missing capability degrades the
// feature, never the app. The difference in degree is that git's absence costs
// you some badges and this thing's absence costs you a whole subsystem, which
// is exactly why the contract has to be written down rather than assumed.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE STACK, AND WHAT WAS REJECTED
//
// CHOSEN: `@huggingface/transformers` 4.3.0 (transformers.js v4), CPU only,
// model `Xenova/all-MiniLM-L6-v2` at fp32 — 384 dimensions, 86.2MB of ONNX.
//
// Why that package:
//   • It ships a real CommonJS build (`dist/transformers.node.cjs`, declared
//     under the `node`/`require` export condition). The Electron main process
//     is CommonJS and so is every other file in this directory. Verified by
//     requiring it: 68ms, no ESM interop dance, no `await import` at the top
//     of a CJS module.
//   • Its `onnxruntime-node` 1.30.0 dependency ships N-API (`napi-v6`)
//     prebuilds for win32/darwin/linux × x64/arm64. N-API is ABI-stable
//     across Node AND Electron versions, so there is no `electron-rebuild`
//     step and no node-gyp on the user's machine. That is the single biggest
//     reason to prefer this over anything using a raw V8 addon: a module that
//     needs rebuilding for Electron's ABI is a module that breaks on every
//     Electron upgrade, silently, in the installer only.
//
// Rejected, with reasons:
//   • `@xenova/transformers` 2.17.2 — the predecessor package, unmaintained
//     since the project moved to the @huggingface scope. It pins
//     onnxruntime-web 1.14 and treats onnxruntime-node as optional, so the
//     Node path is the less-travelled one. No reason to start on the old name.
//   • `@huggingface/transformers` 3.x — same shape, older ORT (1.21). Nothing
//     to gain from starting a version behind.
//   • onnxruntime-node ALONE, with a hand-written WordPiece tokenizer. It
//     would drop ~150MB of dependency (all of sharp and the bundled web
//     runtime) and was genuinely tempting. Rejected because a tokenizer that
//     is subtly wrong — one accent stripped differently, one CJK codepoint
//     split differently than BERT does — produces embeddings that are not
//     wrong enough to look broken, only wrong enough to make search worse, and
//     there is no cheap test that would catch it. Wrong place to be clever.
//   • Any GPU execution provider (DirectML, CUDA, WebGPU). `device: "cpu"` is
//     passed explicitly below. A 6-layer MiniLM is milliseconds per batch on a
//     CPU; the GPU paths add driver-shaped failure modes for no useful gain,
//     and "only runs on boxes that can handle it" means assuming the weakest
//     box, not probing for the strongest.
//   • `BAAI/bge-small-en-v1.5` — same 384 dims, a little stronger on retrieval
//     benchmarks, but its repo carries no pre-quantised ONNX variants and the
//     Xenova repo is the one transformers.js is tested against. Swappable: the
//     model id is a parameter, not a constant, and `MODEL_FILES` is the only
//     thing that would need revisiting.
//
// ⚠️ NOT VERIFIED, and say so before believing anything above: this module has
// been exercised under plain Node on Windows x64 only. The mac and Linux
// prebuilds are claimed by onnxruntime-node's own `os` field and have not been
// loaded here. Nor has a Windows-on-ARM box, where win32/arm64 prebuilds exist
// but nobody has run them. On any of those the failure is a caught `require`
// and a feature that stays off, which is the whole point of the structure.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

/* ========================================================================
 * What we fetch, and from where
 * ===================================================================== */

/** 384 dims, 6 layers, ~22M parameters. Small enough that a laptop CPU indexes
 *  a repository in the time it takes to read the progress bar. */
const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/**
 * ⚠️ AN EXPLICIT FILE LIST, NOT A REPOSITORY CLONE. THIS IS THE WHOLE POINT.
 *
 * `Xenova/all-MiniLM-L6-v2` holds EIGHT ONNX variants — model.onnx,
 * model_fp16, model_int8, model_q4, model_q4f16, model_quantized, model_uint8,
 * model_bnb4 — plus safetensors in sibling repos. Anything that fetches "the
 * model" by cloning the repo turns an 86MB download into most of half a
 * gigabyte, on a laptop, on someone's tethered connection, to use one of the
 * eight. So the files are enumerated, and a file not on this list is not
 * fetched and is not required to be present.
 *
 * `minBytes` is a floor, not a checksum. It exists because the failure this
 * catches is not corruption, it is an HTML error page or a truncated stream
 * landing where 86MB of protobuf should be — and those are three orders of
 * magnitude too small. A real integrity check wants the sha256 from the HF
 * API's LFS metadata; that is a worthwhile upgrade and it is NOT done here.
 */
const MODEL_FILES = [
  { rel: "config.json", minBytes: 100 },
  { rel: "tokenizer.json", minBytes: 10000 },
  { rel: "tokenizer_config.json", minBytes: 50 },
  // fp32 rather than model_quantized.onnx (21.9MB). Quantised would be a
  // quarter of the download and is measurably worse at retrieval; for an
  // index built once and queried for weeks, the bytes are the cheaper side of
  // that trade. Revisit if the download turns out to be what people abandon.
  { rel: "onnx/model.onnx", minBytes: 10 * 1024 * 1024 },
];

/** Hugging Face's plain file endpoint. `resolve/main` redirects to a CDN for
 *  LFS objects, which `fetch` follows by default. */
const HF_BASE = "https://huggingface.co";

/**
 * Written LAST, inside the model directory, after every file has landed at its
 * expected size. Its presence is the ONLY thing that means "present": a
 * directory full of the right filenames proves nothing, because that is also
 * what an interrupted download leaves behind.
 */
const MARKER = ".zevet-model.json";

/** Texts per forward pass. The requirement is only that it is not 1 — a pass
 *  per string pays the session's fixed cost per string and is the difference
 *  between indexing a repo in a minute and in twenty. 16 short code chunks is
 *  a few MB of activations at 384 dims, which is nothing; it is kept modest
 *  because the padding in a batch is charged at the LONGEST member, so huge
 *  batches of uneven text waste more than they save. NOT TUNED — no benchmark
 *  was run to pick this number. */
const DEFAULT_BATCH = 16;

/** One HTTP request may stall this long before the download gives up. A
 *  progress bar frozen forever is worse than an error that says "try again". */
const FETCH_TIMEOUT_MS = 60000;

/* ========================================================================
 * Errors that are sentences
 * ===================================================================== */

/**
 * An error whose message is meant for the person using zevet.
 *
 * The distinction matters: `createEmbedder` catches EVERYTHING, and for an
 * unexpected failure all it can honestly do is quote the exception. When the
 * failure is one we predicted, the string should instead say what happened and
 * what to do about it — "the runtime is not installed, run npm install" is
 * actionable, "Cannot find module '@huggingface/transformers'" is a stack
 * trace with the stack removed.
 */
class EmbedderError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmbedderError";
    this.forHumans = true;
  }
}

function humanise(err) {
  if (err && err.forHumans && err.message) return err.message;
  const raw = err && err.message ? String(err.message) : String(err);
  return `the code index could not start: ${raw}`;
}

/* ========================================================================
 * Where the model lives, and whether it is all there
 * ===================================================================== */

/**
 * The directory one model occupies inside `modelDir`.
 *
 * A model id is `owner/name`, and the slash becomes a real directory level so
 * two models from different owners with the same name cannot collide. The id
 * is validated rather than trusted: it reaches here from a caller that may one
 * day read it from a settings file, and `../../..` in a path segment that is
 * then used for `rm -rf` of a stale directory is how a feature becomes a
 * vulnerability.
 */
function modelPathFor(modelDir, modelId) {
  if (typeof modelDir !== "string" || !modelDir.trim()) {
    throw new EmbedderError("the code index was given no model directory, so there is nowhere to put the model");
  }
  const id = typeof modelId === "string" && modelId.trim() ? modelId.trim() : DEFAULT_MODEL_ID;
  const parts = id.split("/");
  const bad =
    parts.length < 1 ||
    parts.length > 2 ||
    parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === "." || p === "..");
  if (bad) {
    throw new EmbedderError(`"${id}" is not a usable model id — it should look like "Xenova/all-MiniLM-L6-v2"`);
  }
  return { dir: path.join(modelDir, ...parts), id };
}

/**
 * Is the model on disk, and how much of it?
 *
 * Three answers, not two, and the third is the one that matters: `present:
 * false, bytes: > 0` is a PARTIAL download. The caller shows "resume" rather
 * than "download 86MB" for it, and — more importantly — nothing anywhere
 * treats a directory with some files in it as a model it can load. Synchronous
 * because it is a handful of `stat` calls and every caller wants the answer
 * before it can draw anything.
 *
 * Never throws. A modelDir that does not exist, is a file, or is unreadable is
 * reported as "absent", because from the caller's point of view it is.
 */
function modelState(opts) {
  const o = opts || {};
  let dir;
  try {
    dir = modelPathFor(o.modelDir, o.modelId).dir;
  } catch {
    return { present: false, bytes: 0, path: "" };
  }

  let bytes = 0;
  let found = 0;
  for (const f of MODEL_FILES) {
    try {
      const st = fs.statSync(path.join(dir, f.rel));
      if (!st.isFile()) continue;
      bytes += st.size;
      if (st.size >= f.minBytes) found++;
    } catch {
      /* absent; counts as not found and contributes no bytes */
    }
  }

  // The marker is written last and only after every size check passed, so
  // "marker present" and "all files big enough" should agree. They are BOTH
  // required anyway: a marker with files deleted underneath it (a disk cleaner,
  // a user tidying ~/.zevet) must read as absent, not as present-and-broken.
  let marked = false;
  try {
    marked = fs.statSync(path.join(dir, MARKER)).isFile();
  } catch {
    /* no marker */
  }

  return { present: marked && found === MODEL_FILES.length, bytes, path: dir };
}

/* ========================================================================
 * Fetching it
 * ===================================================================== */

/**
 * Can we write here at all?
 *
 * Checked BEFORE the download rather than discovered 80MB in. `fs.access` with
 * W_OK is not enough on Windows, where a read-only directory reports writable
 * and fails on the write, so this actually creates and removes a file.
 */
async function assertWritable(dir) {
  const probe = path.join(dir, `.zevet-write-probe-${crypto.randomBytes(4).toString("hex")}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probe, "z");
  } catch (err) {
    throw new EmbedderError(
      `the code index cannot write to ${dir} (${err && err.code ? err.code : "unknown error"}) — ` +
        `check the folder exists and is writable, or point ZEVET_MODEL_DIR somewhere else`,
    );
  } finally {
    try {
      await fsp.unlink(probe);
    } catch {
      /* the probe not existing is the state we wanted anyway */
    }
  }
}

/**
 * Download every file of one model into a temp directory, then move the whole
 * directory into place in one operation.
 *
 * ⚠️ THE TEMP-DIR-THEN-RENAME IS THE SAME DISCIPLINE `local-fs.js` USES FOR
 * FILE WRITES, FOR THE SAME REASON, ONE LEVEL UP. There it is "the bytes land
 * by rename or not at all"; here it is "the model appears by rename or not at
 * all". Downloading in place would mean that a laptop closed at 60MB leaves a
 * directory holding a truncated model.onnx — and the next launch either loads
 * it (ONNX Runtime throws somewhere deep in protobuf parsing, from a native
 * frame, which is the ugliest way this could fail) or has to guess how much of
 * it is real. With this, an interrupted download leaves a `.tmp-*` directory
 * that nothing looks at and `cleanupTemp` removes on the next attempt.
 *
 * The temp directory is INSIDE modelDir, not in os.tmpdir(), because a rename
 * across filesystems is not atomic and on many platforms is not even permitted
 * (EXDEV) — and `~/.zevet` on one volume with a temp dir on another is the
 * normal arrangement, not an exotic one.
 */
async function ensureModel(ctx) {
  const { dir, id, modelDir, onProgress, fetchImpl } = ctx;

  await assertWritable(modelDir);
  await cleanupTemp(modelDir);

  const tmp = path.join(modelDir, `.tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fsp.mkdir(tmp, { recursive: true });

    // Sizes first, so progress can be a fraction rather than a number that
    // counts upwards to no known end. A HEAD that fails is not fatal — the
    // download still works, the bar just has no total.
    let total = 0;
    const sizes = new Map();
    for (const f of MODEL_FILES) {
      const n = await headSize(ctx, `${HF_BASE}/${id}/resolve/main/${f.rel}`);
      if (n) {
        sizes.set(f.rel, n);
        total += n;
      }
    }

    let done = 0;
    for (const f of MODEL_FILES) {
      const dest = path.join(tmp, f.rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const written = await download(ctx, `${HF_BASE}/${id}/resolve/main/${f.rel}`, dest, (loaded) => {
        report(onProgress, { file: f.rel, loaded: done + loaded, total: total || 0 });
      });
      done += written;

      if (written < f.minBytes) {
        // Almost always an HTML error page or a captive portal's login page,
        // served with a 200 and a few KB of markup.
        throw new EmbedderError(
          `the download of ${f.rel} returned only ${written} bytes, which is not the model — ` +
            `something between here and huggingface.co is answering for it (a proxy or a captive portal?). Nothing was kept.`,
        );
      }
    }

    // Written last, and inside the temp directory, so it is renamed into place
    // with everything else and can never exist beside a missing file.
    await fsp.writeFile(
      path.join(tmp, MARKER),
      JSON.stringify({ modelId: id, files: MODEL_FILES.map((f) => f.rel), bytes: done, at: new Date().toISOString() }, null, 2),
    );

    // A previous attempt's carcass, or an older copy of the same model. Remove
    // before the rename: `fs.rename` onto a non-empty directory fails on both
    // Windows and POSIX.
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await fsp.rename(tmp, dir);
  } catch (err) {
    // A failed download must never outlive itself. Same rule as local-fs.js's
    // temp files: if the write did not finish, the leftovers go.
    try {
      await fsp.rm(tmp, { recursive: true, force: true });
    } catch {
      /* windows can hold a handle open briefly; cleanupTemp gets it next time */
    }
    if (err && err.forHumans) throw err;
    throw new EmbedderError(
      `downloading the index model failed: ${err && err.message ? err.message : String(err)} — ` +
        `check the network and enable the code index again. Nothing was left half-written.`,
    );
  }
}

/** Remove `.tmp-*` directories left by a download that was killed rather than
 *  failed — a process that dies has no `finally`. Best effort by definition. */
async function cleanupTemp(modelDir) {
  let names = [];
  try {
    names = await fsp.readdir(modelDir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(".tmp-")) continue;
    try {
      await fsp.rm(path.join(modelDir, n), { recursive: true, force: true });
    } catch {
      /* leave it; it is inert */
    }
  }
}

/** A progress callback belongs to the UI, and the UI is allowed to be buggy.
 *  A throw from it must not abort an 86MB download that is otherwise fine. */
function report(onProgress, payload) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(payload);
  } catch {
    /* the caller's problem, not the download's */
  }
}

function fetcher(ctx) {
  const f = ctx.fetchImpl || globalThis.fetch;
  if (typeof f !== "function") {
    throw new EmbedderError(
      "this build of Node has no fetch, so the index model cannot be downloaded — zevet needs Node 18 or newer",
    );
  }
  return f;
}

async function headSize(ctx, url) {
  try {
    const res = await fetcher(ctx)(url, { method: "HEAD", redirect: "follow", signal: timeoutSignal() });
    if (!res || !res.ok) return 0;
    const n = Number(res.headers && res.headers.get ? res.headers.get("content-length") : 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;   // no total; the bar counts up instead of filling
  }
}

/** Node 18+ has AbortSignal.timeout. Absent (or in a test's fake fetch that
 *  ignores it) it is simply undefined, which `fetch` accepts. */
function timeoutSignal() {
  try {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

/**
 * One file, streamed to disk.
 *
 * Streamed and not `await res.arrayBuffer()` because the buffered version holds
 * the whole 86MB in the MAIN PROCESS heap, which is the process drawing the
 * window. `res.body` is a web ReadableStream and is async-iterable on Node 18+;
 * a body that is not (an injected test double, an odd polyfill) falls back to
 * the buffered path, which is fine for the small bodies a test uses.
 */
async function download(ctx, url, dest, onBytes) {
  const res = await fetcher(ctx)(url, { redirect: "follow", signal: timeoutSignal() });
  if (!res || !res.ok) {
    const code = res && res.status ? res.status : "no response";
    throw new EmbedderError(
      `huggingface.co answered ${code} for ${url} — if that is 404 the model id is wrong, ` +
        `otherwise wait and try again. Nothing was written.`,
    );
  }

  let loaded = 0;
  const body = res.body;
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const handle = await fsp.open(dest, "w");
    try {
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await handle.write(buf);
        loaded += buf.length;
        onBytes(loaded);
      }
    } finally {
      await handle.close();
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(dest, buf);
    loaded = buf.length;
    onBytes(loaded);
  }
  return loaded;
}

/* ========================================================================
 * The runtime itself
 * ===================================================================== */

/**
 * Load `@huggingface/transformers`, or explain why not.
 *
 * ⚠️ THIS `require` IS THE ENTIRE REASON THIS FILE IS SHAPED THE WAY IT IS. It
 * pulls in onnxruntime-node, which loads a 28MB native DLL through N-API on
 * the spot — the binding is a top-level `var` in the transformers bundle, so
 * there is no lazier place to put it than here. It can fail with
 * MODULE_NOT_FOUND (the optional dependency was never installed, which is the
 * ordinary case on a machine that has not enabled the index), ERR_DLOPEN_FAILED
 * (no prebuild for this platform, or a DLL it needs is missing), or anything
 * else a C++ initialiser feels like. All of it is caught.
 *
 * `load` is injectable so the failure paths can be tested on a machine with
 * nothing installed — which is most machines, and must include CI. A test suite
 * that only goes green where 400MB of model is already cached is not a gate.
 */
function loadBackend(load) {
  try {
    // The injected loader goes through the SAME try/catch as the real require,
    // so a test that simulates "not installed" exercises the message a user
    // would actually be shown rather than a parallel path that only looks like
    // it. A seam that bypasses the code it is standing in for tests nothing.
    // eslint-disable-next-line global-require
    return typeof load === "function" ? load() : require("@huggingface/transformers");
  } catch (err) {
    if (err && err.forHumans) throw err;
    const code = err && err.code ? err.code : "";
    if (code === "MODULE_NOT_FOUND") {
      throw new EmbedderError(
        "the code index needs @huggingface/transformers, which is not installed — " +
          "run `npm install` in zevet's desktop folder. It is an optional dependency, so an install that " +
          "skipped it (no prebuilt ONNX Runtime for this platform) leaves everything else in zevet working.",
      );
    }
    throw new EmbedderError(
      `the ONNX runtime would not load on this machine (${code || "unknown"}: ${err && err.message ? err.message : err}) — ` +
        "this box cannot run the code index; the rest of zevet is unaffected.",
    );
  }
}

/**
 * How many dimensions this model's vectors have, read from its own config.
 *
 * From the file rather than from a warm-up forward pass: the caller needs the
 * number to size a vector store before anything is embedded, and a pass costs
 * a second on a cold session. `hidden_size` is BERT's spelling of it and is
 * what MiniLM's config.json carries; anything else returns null and the number
 * gets filled in from the first real batch instead.
 */
function dimsFromConfig(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    for (const k of ["hidden_size", "dim", "d_model", "hidden_dim"]) {
      if (typeof cfg[k] === "number" && cfg[k] > 0) return cfg[k];
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ========================================================================
 * createEmbedder
 * ===================================================================== */

/**
 * @param {object} opts
 * @param {string} opts.modelDir   where models live, e.g. ~/.zevet/models
 * @param {string} [opts.modelId]  defaults to Xenova/all-MiniLM-L6-v2
 * @param {(p:{file:string,loaded:number,total:number}) => void} [opts.onProgress]
 * @param {boolean} [opts.download=true]  false = fail rather than fetch
 * @param {number} [opts.batchSize]
 * @param {() => any} [opts.load]       test seam: returns the transformers module
 * @param {typeof fetch} [opts.fetchImpl]  test seam
 * @returns {Promise<{ok:boolean, error?:string, dims?:number, path?:string,
 *                    embed?:(t:string[])=>Promise<Float32Array[]>, close?:()=>Promise<void>}>}
 *
 * Resolves, always. There is no path out of here that rejects — see the catch
 * at the bottom, which exists to cover bugs in this file as much as anything
 * else. A caller that writes `const e = await createEmbedder(...); if (!e.ok)
 * return;` has handled every case.
 */
async function createEmbedder(opts) {
  try {
    return await start(opts || {});
  } catch (err) {
    return { ok: false, error: humanise(err) };
  }
}

async function start(o) {
  const { dir, id } = modelPathFor(o.modelDir, o.modelId);
  const ctx = {
    dir,
    id,
    modelDir: o.modelDir,
    onProgress: o.onProgress,
    fetchImpl: o.fetchImpl,
  };

  if (!modelState({ modelDir: o.modelDir, modelId: id }).present) {
    if (o.download === false) {
      throw new EmbedderError(
        `the index model is not in ${dir} and downloading is switched off — enable the code index to fetch it (about 86MB)`,
      );
    }
    await ensureModel(ctx);
  }

  const backend = loadBackend(o.load);
  if (!backend || typeof backend.pipeline !== "function") {
    throw new EmbedderError("the embedding runtime loaded but has no pipeline() — this is not a version zevet understands");
  }

  // ⚠️ THE RUNTIME IS TOLD IT IS OFFLINE, ON PURPOSE. transformers.js will
  // otherwise reach for huggingface.co itself on a cache miss, with its own
  // cache layout, its own progress reporting and its own idea of what a
  // half-written file is — and then the careful download above is decoration.
  // Everything it needs is already on disk by the time this runs.
  if (backend.env) {
    backend.env.allowRemoteModels = false;
    backend.env.allowLocalModels = true;
    backend.env.localModelPath = o.modelDir;
  }

  let extractor;
  try {
    extractor = await backend.pipeline("feature-extraction", id, {
      // fp32 because that is the file MODEL_FILES fetches. Asking for a dtype
      // whose file was not downloaded is a confusing 404-shaped failure.
      dtype: "fp32",
      // Explicit, not defaulted. See the header: no GPU is assumed anywhere.
      device: "cpu",
    });
  } catch (err) {
    throw new EmbedderError(
      `the model in ${dir} could not be loaded (${err && err.message ? err.message : err}) — ` +
        `the files are most likely damaged or half-written. Delete that folder and enable the code index again to refetch it.`,
    );
  }

  return session(extractor, {
    dims: dimsFromConfig(dir),
    path: dir,
    batchSize: Number.isInteger(o.batchSize) && o.batchSize > 0 ? o.batchSize : DEFAULT_BATCH,
  });
}

/**
 * The live handle: `embed`, `close`, and the bookkeeping that keeps a `close()`
 * during an in-flight `embed()` from leaving a native session half-disposed.
 *
 * ⚠️ WHY THERE IS A QUEUE AT ALL. `extractor` wraps an ONNX InferenceSession,
 * which is a native handle. Disposing it while a forward pass is running is a
 * use-after-free in C++ — not an exception, a crash of the whole Electron main
 * process, which is exactly the "must not be able to break the app" failure
 * this file exists to prevent. Two overlapping `embed` calls have the same
 * problem in a milder form. So: one operation at a time, chained through
 * `tail`, and `close()` joins the same chain rather than racing it. It is not
 * concurrency, and it does not need to be — a forward pass on 16 short strings
 * is milliseconds, and the caller is indexing in the background.
 */
function session(extractor, meta) {
  let dims = meta.dims;
  let closed = false;
  let closing = null;
  /** The chain every operation appends itself to. Never rejects: each link
   *  swallows its own failure so one bad batch cannot poison the queue. */
  let tail = Promise.resolve();

  const enqueue = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function embed(texts) {
    if (!Array.isArray(texts)) throw new EmbedderError("embed() takes an array of strings");
    if (texts.length === 0) return [];
    if (closed) throw new EmbedderError("this embedder is closed");

    return enqueue(async () => {
      // Re-checked INSIDE the queue: close() may have been called while this
      // call was waiting its turn, and running a pass against a disposed
      // session is the crash described above.
      if (closed) throw new EmbedderError("this embedder was closed while the batch was waiting");

      const out = [];
      for (let i = 0; i < texts.length; i += meta.batchSize) {
        if (closed) throw new EmbedderError("this embedder was closed mid-batch");
        const slice = texts.slice(i, i + meta.batchSize).map((t) => (typeof t === "string" ? t : String(t)));

        // ⚠️ ONE CALL PER BATCH, NOT PER STRING. transformers.js pads a batch
        // to its longest member and runs it as a single forward pass; calling
        // it per string pays the fixed per-call cost N times over and is the
        // difference between indexing a repository and watching it index.
        // `pooling: "mean"` and `normalize: true` are what sentence-transformers
        // does for this model — mean over tokens, then L2 — so the vectors are
        // comparable with everybody else's for the same model, and a dot
        // product is a cosine similarity.
        const tensor = await extractor(slice, { pooling: "mean", normalize: true });
        for (const vec of rowsOf(tensor, slice.length)) {
          if (dims == null) dims = vec.length;
          out.push(vec);
        }
      }
      return out;
    });
  }

  /**
   * Split the [batch, dims] tensor into one Float32Array per input.
   *
   * `tensor.tolist()` would do it in one line and allocates a JS array of
   * arrays of boxed doubles — 384 of them per string, several megabytes per
   * thousand chunks, all of it garbage a moment later. A subarray-and-copy off
   * the flat `data` is the same numbers at a quarter of the memory.
   *
   * The shape is taken from the tensor when it has one, and derived from the
   * data length otherwise, because a test double is not obliged to carry dims.
   */
  function rowsOf(tensor, count) {
    const data = tensor && tensor.data ? tensor.data : tensor;
    if (!data || typeof data.length !== "number") {
      throw new EmbedderError("the embedding runtime returned something that is not a tensor");
    }
    const width = Array.isArray(tensor.dims) && tensor.dims.length
      ? tensor.dims[tensor.dims.length - 1]
      : Math.floor(data.length / Math.max(1, count));
    if (!width || data.length < width * count) {
      throw new EmbedderError(`the embedding runtime returned ${data.length} numbers for ${count} texts, which does not divide`);
    }
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push(Float32Array.from(data.subarray ? data.subarray(i * width, (i + 1) * width) : data.slice(i * width, (i + 1) * width)));
    }
    return rows;
  }

  /**
   * Release the native session.
   *
   * Idempotent, and safe to call while an `embed` is running: the flag stops
   * new work immediately (so a long batch loop gives up at its next chunk) and
   * the dispose itself is queued behind whatever pass is already inside the
   * runtime. Calling it twice returns the same promise rather than disposing
   * twice, because a double free is the same crash as a use-after-free.
   */
  function close() {
    if (closing) return closing;
    closed = true;
    closing = enqueue(async () => {
      try {
        if (extractor && typeof extractor.dispose === "function") await extractor.dispose();
      } catch {
        // A runtime that fails to dispose leaks until the process exits, which
        // is survivable; a throw out of close() is not, because callers close
        // in shutdown paths where nothing is left to catch it.
      }
      extractor = null;
    }).then(
      () => undefined,
      () => undefined,
    );
    return closing;
  }

  return {
    ok: true,
    get dims() {
      return dims;
    },
    path: meta.path,
    batchSize: meta.batchSize,
    embed,
    close,
  };
}

module.exports = {
  createEmbedder,
  modelState,
  modelPathFor,
  DEFAULT_MODEL_ID,
  MODEL_FILES,
  MARKER,
  DEFAULT_BATCH,
  EmbedderError,
};
