// The embedder: the one part of zevet that needs a native runtime it does not
// control, tested on the assumption that the runtime is NOT there.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY ALMOST EVERYTHING HERE USES A FAKE BACKEND
//
// The real path costs an 86MB download and a 28MB native DLL. A suite that
// needs either is a suite that is green on the machine it was written on and
// red or skipped everywhere else — which is not a gate, it is a souvenir. So
// `createEmbedder` takes two seams, `load` (returns the transformers module)
// and `fetchImpl`, and every test below drives the real code through fakes.
//
// What that buys, precisely: the failure MAPPING is tested — that a
// MODULE_NOT_FOUND becomes a sentence telling a person to run npm install,
// that a 503 leaves nothing on disk, that a batch of 40 is three forward passes
// and not forty. What it does NOT buy, and nothing here pretends otherwise:
//
//   ⚠️ NOT TESTED HERE — that onnxruntime-node actually loads under Electron's
//   ABI on any platform, that MiniLM produces good vectors, that the download
//   survives a real flaky connection. The first of those is unfalsifiable from
//   node --test; the second is the ZEVET_INDEX_E2E test at the bottom, which is
//   SKIPPED unless the env var is set because it downloads 86MB; the third has
//   no test anywhere and is called out in embedder.js's header.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, truncateSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "desktop", "embedder.js");
const E = require(MODULE_PATH);

let dir;
before(() => { dir = mkdtempSync(path.join(tmpdir(), "zevet-embed-")); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows holds handles */ } });

let seq = 0;
/** A fresh, empty models root per test, so no test can see another's leftovers. */
function fresh(name) {
  const p = path.join(dir, `${name}-${seq++}`);
  mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Write a model directory that `modelState` will believe.
 *
 * The onnx file has to clear a 10MB floor, so it is made with `truncate` rather
 * than by writing ten million bytes: the size is what is checked and an
 * NTFS/APFS extend is instant. `opts.skip` omits a file, `opts.short` writes a
 * believable-but-tiny one, `opts.marker: false` leaves the completion marker
 * off — i.e. exactly what an interrupted download leaves behind.
 */
function writeModel(modelDir, opts = {}) {
  const id = opts.modelId || E.DEFAULT_MODEL_ID;
  const target = path.join(modelDir, ...id.split("/"));
  for (const f of E.MODEL_FILES) {
    if (opts.skip === f.rel) continue;
    const p = path.join(target, f.rel);
    mkdirSync(path.dirname(p), { recursive: true });
    if (f.rel === "config.json") {
      // Padded with spaces and never truncated: `truncate` fills with NULs,
      // which is still 100 bytes of "config.json" to modelState and no longer
      // parseable JSON to anything that reads hidden_size out of it.
      writeFileSync(p, JSON.stringify({ hidden_size: 384, model_type: "bert" }).padEnd(f.minBytes, " "));
      continue;
    }
    writeFileSync(p, "x");
    if (opts.short !== f.rel) truncateSync(p, Math.max(f.minBytes, statSync(p).size));
  }
  if (opts.marker !== false) {
    writeFileSync(path.join(target, E.MARKER), JSON.stringify({ modelId: id }));
  }
  return target;
}

/* ========================================================================
 * 1. Loading this file must cost nothing and risk nothing
 * ===================================================================== */

describe("requiring the embedder is free", () => {
  test("it loads with no runtime installed, and does not throw", () => {
    // This is THE assertion of the whole file. zevet's main process requires
    // this module at startup; if that require can throw — because a native
    // module is missing, or half-installed, or built for another ABI — then the
    // app does not start, and "the index feature is absent" has become "zevet
    // is broken". @huggingface/transformers is an OPTIONAL dependency and is
    // legitimately absent on most machines, including whatever runs this test.
    delete require.cache[MODULE_PATH];
    const again = require(MODULE_PATH);
    assert.equal(typeof again.createEmbedder, "function");
    assert.equal(typeof again.modelState, "function");
  });

  test("the heavy module is required inside a function, never at the top", () => {
    // Asserted against the source because the runtime check above passes just
    // as happily on a machine where transformers IS installed — which is the
    // machine this was written on, and would be the one place the regression
    // is invisible. The require must come after the function that owns it.
    const src = readFileSync(MODULE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const at = src.indexOf('require("@huggingface/transformers")');
    assert.ok(at > 0, "the runtime is not required anywhere — has the stack changed?");
    const owner = src.indexOf("function loadBackend");
    assert.ok(owner > 0 && owner < at, "the transformers require escaped loadBackend()");
  });

  test("nothing but node builtins is required at the top level", () => {
    // The generalisation of the test above: any future dependency that gets
    // hoisted to the top of this file reintroduces exactly the failure mode
    // this design exists to prevent, whether or not it is transformers.
    // Comments stripped first, because embedder.js's header TALKS about
    // requires — the first version of this test failed on a sentence.
    const src = readFileSync(MODULE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const top = src.split(/\n(?:function|class|async function)\s/)[0];
    for (const [, mod] of top.matchAll(/require\("([^"]+)"\)/g)) {
      assert.ok(mod.startsWith("node:"), `${mod} is required at the top level of embedder.js`);
    }
  });
});

/* ========================================================================
 * 2. modelState — absent, present, and the one in between
 * ===================================================================== */

describe("modelState tells present from partial", () => {
  test("nothing there at all", () => {
    const md = fresh("empty");
    const s = E.modelState({ modelDir: md });
    assert.equal(s.present, false);
    assert.equal(s.bytes, 0);
    assert.equal(s.path, path.join(md, "Xenova", "all-MiniLM-L6-v2"), "the owner/name split did not become directories");
  });

  test("a complete model is present, and reports its size", () => {
    const md = fresh("full");
    writeModel(md);
    const s = E.modelState({ modelDir: md });
    assert.equal(s.present, true);
    assert.ok(s.bytes > 10 * 1024 * 1024, `only counted ${s.bytes} bytes`);
  });

  test("⚠️ an interrupted download is NOT present, even with every file there", () => {
    // The whole reason the marker file exists. Every filename is in place and
    // the sizes look right, but the marker — written last, after the rename —
    // is not, so this is a download that was killed between the last byte and
    // the finish line. Treating it as present is how a truncated model.onnx
    // reaches ONNX Runtime and takes the main process down from a C++ frame.
    const md = fresh("nomarker");
    writeModel(md, { marker: false });
    const s = E.modelState({ modelDir: md });
    assert.equal(s.present, false);
    assert.ok(s.bytes > 0, "a partial download should still report the bytes it has, so the UI can say 'resume'");
  });

  test("a marker with a file deleted underneath it is not present either", () => {
    // A disk cleaner, or a person tidying ~/.zevet by hand. The marker is
    // necessary but never sufficient.
    const md = fresh("gutted");
    writeModel(md, { skip: "tokenizer.json" });
    assert.equal(E.modelState({ modelDir: md }).present, false);
  });

  test("a truncated model.onnx is not present, however confident the marker is", () => {
    const md = fresh("short");
    writeModel(md, { short: "onnx/model.onnx" });
    const s = E.modelState({ modelDir: md });
    assert.equal(s.present, false);
    assert.ok(s.bytes > 0);
  });

  test("a garbage model id answers rather than throwing", () => {
    // It can reach here from a settings file one day. `..` in a path segment
    // that later gets rm -rf'd is the difference between a feature and a
    // vulnerability, so it is rejected at the door — quietly, since this
    // function is called on a render path.
    for (const bad of ["../../etc", "a/b/c", "", "  ", null, 7]) {
      const s = E.modelState({ modelDir: fresh("bad"), modelId: bad });
      if (bad === "" || bad === "  " || bad == null || bad === 7) continue;   // these fall back to the default id
      assert.equal(s.present, false);
      assert.equal(s.path, "");
    }
  });

  test("no model directory at all is 'absent', not an exception", () => {
    assert.deepEqual(E.modelState({}), { present: false, bytes: 0, path: "" });
    assert.deepEqual(E.modelState(), { present: false, bytes: 0, path: "" });
  });
});

/* ========================================================================
 * 3. Every failure is a sentence, and nothing throws
 * ===================================================================== */

/**
 * A backend that behaves, so tests about OTHER things are not about this.
 *
 * It records the shape of every call — which is how "N texts are not N forward
 * passes" is provable without a runtime — and how many times it was disposed,
 * which is how a double free is provable without one either.
 */
function fakeBackend(hooks = {}) {
  const fake = { calls: [], disposes: 0, dims: 4, module: null };
  fake.module = {
    env: {},
    pipeline: async () => {
      const fn = async (texts, opts) => {
        fake.calls.push({ n: texts.length, texts, opts });
        if (hooks.onCall) await hooks.onCall(texts);
        const data = new Float32Array(texts.length * fake.dims);
        for (let i = 0; i < texts.length; i++) {
          for (let d = 0; d < fake.dims; d++) data[i * fake.dims + d] = i + d / 10;
        }
        return { data, dims: [texts.length, fake.dims] };
      };
      fn.dispose = async () => {
        fake.disposes++;
        if (hooks.onDispose) hooks.onDispose();
      };
      return fn;
    },
  };
  return fake;
}

describe("every failure returns {ok:false} with something a person can act on", () => {
  test("the runtime is not installed", async () => {
    const md = fresh("noruntime");
    writeModel(md);
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => { throw Object.assign(new Error("Cannot find module '@huggingface/transformers'"), { code: "MODULE_NOT_FOUND" }); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /npm install/i, "the message does not say what to do");
    assert.match(r.error, /optional/i, "it does not say that the rest of zevet is fine");
    assert.equal(r.embed, undefined);
  });

  test("the native module is there but will not load on this box", async () => {
    // The ABI / missing-DLL / quarantined-binary case, which is the one that
    // "only runs on boxes that can handle it" is actually about.
    const md = fresh("dlopen");
    writeModel(md);
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => { throw Object.assign(new Error("The specified module could not be found."), { code: "ERR_DLOPEN_FAILED" }); },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /ERR_DLOPEN_FAILED/);
    assert.match(r.error, /rest of zevet is unaffected/i);
  });

  test("a runtime of a shape we do not recognise", async () => {
    const md = fresh("weird");
    writeModel(md);
    const r = await E.createEmbedder({ modelDir: md, load: () => ({}) });
    assert.equal(r.ok, false);
    assert.match(r.error, /pipeline/);
  });

  test("the model directory cannot be written to", async () => {
    // A directory under a FILE, which fails on every platform. chmod would be
    // the obvious way and is useless here: Windows ignores the read-only bit
    // for the owner, so the negative test would pass by accident on CI.
    const blocker = path.join(fresh("blocked"), "afile");
    writeFileSync(blocker, "not a directory");
    const r = await E.createEmbedder({ modelDir: path.join(blocker, "models") });
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot write to/i);
    assert.ok(r.error.includes("models"), "the message does not name the directory it failed on");
  });

  test("the download fails", async () => {
    const md = fresh("http503");
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => fakeBackend().module,
      fetchImpl: async () => ({ ok: false, status: 503, headers: { get: () => null } }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /503/);
    assert.match(r.error, /try again/i);
  });

  test("...and leaves NOTHING behind that could look like a model", async () => {
    // The failure that matters most: a half-download that the next launch
    // believes. config.json and tokenizer.json land fine and model.onnx 404s.
    const md = fresh("halfway");
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => fakeBackend().module,
      fetchImpl: async (url, init) => serve(url, init, { "onnx/model.onnx": 404 }),
    });
    assert.equal(r.ok, false);
    assert.equal(E.modelState({ modelDir: md }).present, false);
    assert.equal(E.modelState({ modelDir: md }).bytes, 0, "part of a model was left on disk");
    assert.deepEqual(readdirSync(md), [], "the temp directory outlived the failed download");
  });

  test("a 200 that is really a captive portal's login page is not a model", async () => {
    // A proxy that answers 200 with 900 bytes of HTML for everything is the
    // most common "download succeeded but the file is wrong" in the wild.
    const md = fresh("portal");
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => fakeBackend().module,
      fetchImpl: async (url, init) => serve(url, init, {}, () => Buffer.from("<html>sign in to the wifi</html>")),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /captive portal|proxy/i);
    assert.equal(E.modelState({ modelDir: md }).present, false);
  });

  test("the model is present but corrupt", async () => {
    const md = fresh("corrupt");
    writeModel(md);
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => ({ env: {}, pipeline: async () => { throw new Error("Protobuf parsing failed"); } }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /Delete that folder/i, "the message does not tell anyone how to recover");
    assert.ok(r.error.includes(path.join(md, "Xenova", "all-MiniLM-L6-v2")), "it does not say WHICH folder");
  });

  test("download switched off, model absent", async () => {
    const r = await E.createEmbedder({ modelDir: fresh("nodl"), download: false, load: () => fakeBackend().module });
    assert.equal(r.ok, false);
    assert.match(r.error, /enable the code index/i);
    assert.match(r.error, /86MB/, "it does not say how big the download would be");
  });

  test("a model id that is not one", async () => {
    const r = await E.createEmbedder({ modelDir: fresh("badid"), modelId: "../../../etc/passwd" });
    assert.equal(r.ok, false);
    assert.match(r.error, /not a usable model id/);
  });

  test("no arguments at all", async () => {
    const r = await E.createEmbedder();
    assert.equal(r.ok, false);
    assert.match(r.error, /model directory/);
  });

  test("a loader that throws something that is not an Error still returns a string", async () => {
    // humanise() is the last line of defence and it is handed whatever a native
    // initialiser felt like throwing.
    const md = fresh("thrownonsense");
    writeModel(md);
    const r = await E.createEmbedder({ modelDir: md, load: () => { throw "boom"; } });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
    assert.ok(r.error.length > 10);
  });
});

/* ========================================================================
 * 4. The download itself
 * ===================================================================== */

/** A fake huggingface.co. `codes` maps a file to an HTTP status to fail with. */
function serve(url, init, codes = {}, bodyFor = null) {
  const rel = String(url).split("/resolve/main/")[1];
  const status = codes[rel];
  if (status) return { ok: false, status, headers: { get: () => null } };
  const spec = E.MODEL_FILES.find((f) => f.rel === rel);
  const body = bodyFor
    ? bodyFor(rel)
    : rel === "config.json"
      ? Buffer.from(JSON.stringify({ hidden_size: 384 }).padEnd(spec.minBytes, " "))
      : Buffer.alloc(spec.minBytes, 7);
  const headers = { get: (k) => (k.toLowerCase() === "content-length" ? String(body.length) : null) };
  if (init && init.method === "HEAD") return { ok: true, status: 200, headers };
  return {
    ok: true,
    status: 200,
    headers,
    // Chunked, because the real one is: the streaming path and the buffered
    // fallback are different code and the streaming one is what ships.
    body: (async function* () {
      for (let i = 0; i < body.length; i += 65536) yield body.subarray(i, i + 65536);
    })(),
  };
}

describe("fetching a model", () => {
  test("a clean download lands, is marked complete, and leaves no temp directory", async () => {
    const md = fresh("dl");
    const r = await E.createEmbedder({ modelDir: md, load: () => fakeBackend().module, fetchImpl: serve });
    assert.equal(r.ok, true, r.error);
    const s = E.modelState({ modelDir: md });
    assert.equal(s.present, true);
    assert.ok(existsSync(path.join(s.path, E.MARKER)));
    assert.deepEqual(readdirSync(md), ["Xenova"], "something other than the model was left in the models root");
  });

  test("the model id becomes nested directories, not a file called Xenova%2F...", async () => {
    const md = fresh("nest");
    await E.createEmbedder({ modelDir: md, load: () => fakeBackend().module, fetchImpl: serve });
    assert.ok(existsSync(path.join(md, "Xenova", "all-MiniLM-L6-v2", "onnx", "model.onnx")));
  });

  test("progress is reported per file with a running total", async () => {
    const md = fresh("prog");
    const seen = [];
    await E.createEmbedder({
      modelDir: md,
      load: () => fakeBackend().module,
      fetchImpl: serve,
      onProgress: (p) => seen.push(p),
    });
    assert.ok(seen.length > 1, "one progress event for an 86MB download is a frozen bar");
    assert.ok(seen.every((p) => typeof p.file === "string" && p.loaded >= 0 && p.total > 0));
    // Monotonic across files, because `loaded` is the whole download and not
    // the current file — a bar that restarts four times reads as four failures.
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i].loaded >= seen[i - 1].loaded, "progress went backwards");
    assert.equal(seen[seen.length - 1].loaded, seen[seen.length - 1].total, "the bar never reaches the end");
    assert.ok(new Set(seen.map((p) => p.file)).size >= 2, "only one file ever reported progress");
  });

  test("a progress callback that throws does not break the download", async () => {
    // The callback belongs to the renderer-facing side, which is allowed to be
    // buggy. It must not be able to abort an 86MB download that is going fine.
    const md = fresh("badcb");
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => fakeBackend().module,
      fetchImpl: serve,
      onProgress: () => { throw new Error("the UI is on fire"); },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(E.modelState({ modelDir: md }).present, true);
  });

  test("a present model is not downloaded again", async () => {
    const md = fresh("cached");
    writeModel(md);
    let hits = 0;
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => fakeBackend().module,
      fetchImpl: async (...a) => { hits++; return serve(...a); },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(hits, 0, "it refetched a model it already had");
  });

  test("the leftovers of a killed download are cleared, not resumed into", async () => {
    // A process killed mid-download has no `finally`, so `.tmp-*` directories
    // outlive it. The next attempt removes them rather than accumulating a
    // gigabyte of abandoned halves in ~/.zevet.
    const md = fresh("ghost");
    mkdirSync(path.join(md, ".tmp-deadbeef", "onnx"), { recursive: true });
    writeFileSync(path.join(md, ".tmp-deadbeef", "onnx", "model.onnx"), "half a model");
    const r = await E.createEmbedder({ modelDir: md, load: () => fakeBackend().module, fetchImpl: serve });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(readdirSync(md), ["Xenova"]);
  });

  test("only the four files it needs are fetched, not the whole repository", async () => {
    // ⚠️ THE 86MB-BECOMES-500MB TEST. That repo holds eight ONNX variants. A
    // fetch that walks the repo listing instead of an explicit list downloads
    // all of them, on somebody's tethered connection, to use one.
    const md = fresh("scope");
    const asked = [];
    await E.createEmbedder({
      modelDir: md,
      load: () => fakeBackend().module,
      fetchImpl: async (url, init) => { asked.push(String(url).split("/resolve/main/")[1]); return serve(url, init); },
    });
    const unique = [...new Set(asked)];
    assert.deepEqual(unique.sort(), E.MODEL_FILES.map((f) => f.rel).sort());
    assert.ok(!unique.some((f) => /_q4|_int8|_fp16|_uint8|_bnb4|quantized/.test(f)), "a quantised variant was fetched too");
  });
});

/* ========================================================================
 * 5. Batching
 * ===================================================================== */

describe("embedding batches", () => {
  test("⚠️ N texts are NOT N forward passes", async () => {
    // The fake backend records the shape of every call it receives. 40 texts at
    // a batch size of 16 must arrive as 16/16/8 — three passes. Per-string
    // calls pay the session's fixed cost forty times and turn indexing a
    // repository from a minute into twenty.
    const md = fresh("batch");
    writeModel(md);
    const fake = fakeBackend();
    const r = await E.createEmbedder({ modelDir: md, load: () => fake.module, batchSize: 16 });
    assert.equal(r.ok, true, r.error);

    const texts = Array.from({ length: 40 }, (_, i) => `chunk ${i}`);
    const vecs = await r.embed(texts);
    assert.deepEqual(fake.calls.map((c) => c.n), [16, 16, 8]);
    assert.equal(vecs.length, 40);
    assert.ok(vecs[0] instanceof Float32Array);
    await r.close();
  });

  test("the batches are the texts, in order, unmangled", async () => {
    const md = fresh("order");
    writeModel(md);
    const fake = fakeBackend();
    const r = await E.createEmbedder({ modelDir: md, load: () => fake.module, batchSize: 2 });
    await r.embed(["a", "b", "c"]);
    assert.deepEqual(fake.calls.map((c) => c.texts), [["a", "b"], ["c"]]);
    await r.close();
  });

  test("mean pooling and L2 normalisation are asked for every time", async () => {
    // Without them the "vectors" are per-token and unnormalised, dot products
    // stop being cosines, and every similarity number downstream is wrong in a
    // way that still looks like a number.
    const md = fresh("pool");
    writeModel(md);
    const fake = fakeBackend();
    const r = await E.createEmbedder({ modelDir: md, load: () => fake.module });
    await r.embed(["x"]);
    assert.deepEqual(fake.calls[0].opts, { pooling: "mean", normalize: true });
    await r.close();
  });

  test("dims comes off config.json before anything is embedded", async () => {
    // The caller sizes a vector store with this, so it has to be knowable
    // without paying for a warm-up forward pass.
    const md = fresh("dims");
    writeModel(md);
    const r = await E.createEmbedder({ modelDir: md, load: () => fakeBackend().module });
    assert.equal(r.dims, 384);
    await r.close();
  });

  test("an empty array is not a forward pass", async () => {
    const md = fresh("emptyin");
    writeModel(md);
    const fake = fakeBackend();
    const r = await E.createEmbedder({ modelDir: md, load: () => fake.module });
    assert.deepEqual(await r.embed([]), []);
    assert.equal(fake.calls.length, 0);
    await r.close();
  });

  test("a runtime that returns nonsense is an error, not a wrong vector", async () => {
    const md = fresh("nonsense");
    writeModel(md);
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => ({ env: {}, pipeline: async () => async () => ({ data: new Float32Array(3), dims: [1, 3] }) }),
    });
    await assert.rejects(() => r.embed(["a", "b"]), /does not divide|not a tensor/);
    await r.close();
  });

  test("embed() rejects rather than hanging when handed something that is not an array", async () => {
    const md = fresh("notarray");
    writeModel(md);
    const r = await E.createEmbedder({ modelDir: md, load: () => fakeBackend().module });
    await assert.rejects(() => r.embed("one string"), /array of strings/);
    await r.close();
  });
});

/* ========================================================================
 * 6. close()
 * ===================================================================== */

describe("closing", () => {
  test("it is idempotent — the native session is disposed once", async () => {
    // Twice would be a double free inside ONNX Runtime, which is a crash of the
    // main process and not an exception anyone can catch.
    const md = fresh("close1");
    writeModel(md);
    const fake = fakeBackend();
    const r = await E.createEmbedder({ modelDir: md, load: () => fake.module });
    await r.embed(["a"]);
    await Promise.all([r.close(), r.close(), r.close()]);
    await r.close();
    assert.equal(fake.disposes, 1, `the session was disposed ${fake.disposes} times`);
  });

  test("⚠️ a close() during an in-flight embed waits for the pass to finish", async () => {
    // The dangling-handle case. If dispose runs while a forward pass is inside
    // the native session, the pass is using freed memory. The order recorded
    // here must be: pass starts, close is called, pass ends, THEN dispose.
    const md = fresh("close2");
    writeModel(md);
    const order = [];
    let release;
    const gate = new Promise((res) => { release = res; });

    const fake = fakeBackend({
      onCall: async () => { order.push("pass:start"); await gate; order.push("pass:end"); },
      onDispose: () => order.push("dispose"),
    });
    const r = await E.createEmbedder({ modelDir: md, load: () => fake.module });

    const inflight = r.embed(["a"]);
    await new Promise((res) => setTimeout(res, 10));   // let the pass get inside
    order.push("close:called");
    const closing = r.close();
    await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(order, ["pass:start", "close:called"], "dispose ran while a forward pass was still inside the session");
    release();

    await assert.doesNotReject(() => inflight);
    await closing;
    assert.deepEqual(order, ["pass:start", "close:called", "pass:end", "dispose"]);
    assert.equal(fake.disposes, 1);
  });

  test("an embed queued behind a close is refused, not run against a dead session", async () => {
    const md = fresh("close3");
    writeModel(md);
    const r = await E.createEmbedder({ modelDir: md, load: () => fakeBackend().module });
    await r.close();
    await assert.rejects(() => r.embed(["a"]), /closed/);
  });

  test("close() on a runtime whose dispose throws still resolves", async () => {
    // close() is called from shutdown paths where a rejection has nowhere to go.
    const md = fresh("close4");
    writeModel(md);
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => ({
        env: {},
        pipeline: async () => Object.assign(async () => ({ data: new Float32Array(4), dims: [1, 4] }), {
          dispose: async () => { throw new Error("the DLL is sulking"); },
        }),
      }),
    });
    await assert.doesNotReject(() => r.close());
  });

  test("a runtime with no dispose() at all is still closeable", async () => {
    const md = fresh("close5");
    writeModel(md);
    const r = await E.createEmbedder({
      modelDir: md,
      load: () => ({ env: {}, pipeline: async () => async () => ({ data: new Float32Array(4), dims: [1, 4] }) }),
    });
    await assert.doesNotReject(() => r.close());
  });
});

/* ========================================================================
 * 7. Packaging — the failure that only appears in an installer
 * ===================================================================== */

describe("the embedder reaches a packaged build", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "desktop", "package.json"), "utf8"));
  const files = pkg.build.files;

  test("embedder.js is in build.files", () => {
    // `files` is an ALLOWLIST. A module missing from it is simply not copied,
    // and the installed app dies on the require — a crash no test, no
    // `npm start` and no code review catches, because all three run from the
    // checkout where the file is right there. desktop-bridges.test.mjs makes
    // this assertion for everything main.js requires; embedder.js is reached
    // from the index rather than from main.js, so it needs its own.
    assert.ok(files.includes("embedder.js"), "embedder.js is not in build.files, so the packaged app cannot load it");
  });

  test("the runtime is an OPTIONAL dependency, pinned exactly", () => {
    // ⚠️ OPTIONAL IS THE POINT, NOT AN OVERSIGHT. In `dependencies`, an
    // onnxruntime-node prebuild that does not exist for somebody's platform
    // fails their `npm install` outright and they have no zevet at all. In
    // `optionalDependencies`, npm shrugs, the require in loadBackend throws
    // MODULE_NOT_FOUND, createEmbedder answers {ok:false} and every other part
    // of the app is untouched. That is the same fail-to-empty contract this
    // whole module is built on, applied one layer earlier.
    //
    // Pinned exactly, like electron and electron-builder above it: a caret on
    // a package that carries a 28MB native binary means the binary can change
    // under a fresh install with no commit to point at.
    const dep = (pkg.optionalDependencies || {})["@huggingface/transformers"];
    assert.ok(dep, "@huggingface/transformers is not declared as an optional dependency");
    assert.match(dep, /^\d+\.\d+\.\d+$/, `"${dep}" is a range, not a pin`);
    assert.ok(
      !(pkg.dependencies || {})["@huggingface/transformers"],
      "it is also a hard dependency, which defeats the point of the optional one",
    );
  });

  test("the installer is trimmed by NEGATIVE patterns, which are the only kind node_modules honours", () => {
    // ⚠️ electron-builder handles node_modules through a separate matcher that
    // (its own words) "grabs only excludes" from `files` — see
    // app-builder-lib/out/fileMatcher.js, getNodeModuleFileMatcher. A POSITIVE
    // "node_modules/**" entry does nothing at all, and writing one is how
    // somebody concludes the allowlist is broken. Production dependencies come
    // in automatically; the only lever over them is `!`.
    //
    // Without these two, the app directory carries 470MB of dependency:
    // onnxruntime-node ships prebuilds for win32/darwin/linux × x64/arm64
    // (288MB) and onnxruntime-web ships WASM bundles (141MB) that the Node
    // build never loads — transformers.node.cjs inlines the web runtime and
    // only ever requires onnxruntime-node.
    assert.ok(
      files.some((f) => f === "!node_modules/onnxruntime-web/**"),
      "onnxruntime-web (141MB, unused by the node build) is not excluded",
    );
    assert.ok(
      files.some((f) => f.includes("onnxruntime-node/bin/napi-v6") && f.startsWith("!")),
      "every platform's ONNX prebuilds are shipped in every installer",
    );
    assert.ok(
      !files.some((f) => !f.startsWith("!") && f.includes("node_modules")),
      "a positive node_modules pattern in build.files does nothing — electron-builder takes only the excludes",
    );
  });

  test("the arch exclusion uses electron-builder's ${arch} macro and not the build host's", () => {
    // `${arch}` expands to the TARGET arch. `${platform}` expands to
    // process.platform — the BUILD HOST — which is right whenever nobody
    // cross-builds and silently ships the wrong binaries the day somebody
    // does. So the pruning is by arch only, and the platform dirs stay.
    const arch = files.find((f) => f.includes("napi-v6") && f.includes("!("));
    assert.ok(arch, "the wrong-arch prebuilds are not pruned");
    assert.ok(arch.includes("${arch}"), "the arch pattern is hardcoded rather than expanded per target");
    assert.ok(!files.some((f) => f.includes("${platform}")), "${platform} is the build host, not the target");
  });
});

/* ========================================================================
 * 8. The real thing, only when asked
 * ===================================================================== */

describe("end to end against the real runtime", () => {
  // SKIPPED unless ZEVET_INDEX_E2E=1. It downloads 86MB on a cold cache and
  // loads a 28MB native DLL, neither of which belongs in a gate that has to run
  // on any machine. Run it by hand after touching anything in this file:
  //   ZEVET_INDEX_E2E=1 node --test test/embedder.test.mjs
  const on = process.env.ZEVET_INDEX_E2E === "1";

  test("it embeds two strings and puts the similar pair closer", { skip: on ? false : "set ZEVET_INDEX_E2E=1" }, async (t) => {
    const md = process.env.ZEVET_MODEL_DIR || path.join(homedir(), ".zevet", "models");
    const r = await E.createEmbedder({
      modelDir: md,
      onProgress: (p) => { if (p.total && p.loaded === p.total) t.diagnostic(`fetched ${p.file}`); },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.dims, 384, "MiniLM-L6-v2 is a 384-dimension model");

    const [a, b, c] = await r.embed([
      "function readFile(path) { return fs.readFileSync(path, 'utf8'); }",
      "function loadFile(name) { return fs.readFileSync(name, 'utf8'); }",
      "the quick brown fox jumps over the lazy dog",
    ]);
    for (const v of [a, b, c]) {
      assert.ok(v instanceof Float32Array);
      assert.equal(v.length, 384);
      // normalize: true was asked for, so every vector is unit length. If this
      // fails the pooling options are not reaching the runtime and every
      // similarity downstream is off.
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(norm - 1) < 1e-3, `vector is not normalised (|v| = ${norm})`);
    }
    const dot = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
    const near = dot(a, b);
    const far = dot(a, c);
    t.diagnostic(`similar ${near.toFixed(3)} vs dissimilar ${far.toFixed(3)}`);
    assert.ok(near > far, `two file-reading functions (${near}) should score above a pangram (${far})`);
    await r.close();
  });
});
