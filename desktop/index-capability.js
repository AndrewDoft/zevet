// Can this machine carry zevet's own semantic code index? One answer, taken
// before anything is downloaded, loaded or started.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE EXISTS AT ALL
//
// Andrew's requirement, verbatim: "make sure it only runs on boxes that can
// handle it, otherwise zevet should still work". Everything else about the
// built-in index — the ONNX embedding model, the vector store, incremental
// reindexing — is optional. This file is not. It is the thing that decides
// whether any of it runs, and when it says no, zevet must behave exactly as it
// does today: no index, no model download, no background CPU, and above all no
// crash.
//
// So the contract is FAIL CLOSED, and it is stricter than the fail-to-empty
// contract in repo-stats.js. There, a failed measurement means a tree row loses
// a badge. Here, a failed measurement means we do not know whether loading
// several hundred megabytes of model weights will take this machine down with
// it — and "we do not know" must resolve to "do not run", never to "probably
// fine". Every measurement that cannot be taken is a denial with a reason
// naming the measurement, not a silently-assumed default.
//
// ⚠️ NOTHING HERE HAS BEEN BENCHMARKED. The thresholds below are reasoned
// defaults, not measurements. No embedding model has been loaded and no
// resident-set size has been read off a running process by anyone who wrote
// this file. They are sized against the stated envelope for the feature — an
// ONNX embedding model in the ~100–400 MB range held in RAM, plus a vector
// store — with margin, and they are deliberately conservative because the cost
// of being wrong in the generous direction (a swapping, unusable desktop) is
// far worse than the cost of being wrong in the strict direction (no index on a
// machine that could have run one, which ZEVET_INDEX_FORCE exists to fix).
// When someone does benchmark the real model, these numbers should be replaced
// with measured ones and this paragraph should be replaced with the results.
//
// ⚠️ THIS IS NOT status-sources.js's `probePort`. That probe asks whether the
// EXTERNAL code index — a separate process Andrew runs — is listening on a TCP
// port. This module is about zevet's OWN in-process index, which does not exist
// yet. The two must not be confused: a machine can fail this assessment while
// the external index is up, and vice versa.
"use strict";

const nodeFs = require("node:fs");
const nodeOs = require("node:os");
const path = require("node:path");

/* ========================================================================
 * The thresholds
 *
 * Each one says what it is protecting against. All four are REASONED, NOT
 * MEASURED — see the header. They are exported so the tests and the UI can
 * quote the same numbers this file gates on, rather than restating them and
 * drifting.
 * ===================================================================== */

/**
 * Total physical RAM, 8 GB.
 *
 * Protects against: the whole desktop swapping. This is not sized against the
 * model alone — the model is the smaller half of the problem. zevet is an
 * Electron app, so there is already a browser process, a GPU process and a
 * renderer per window resident, and it spawns agent subprocesses on top of
 * that. Adding several hundred megabytes of model weights plus an ONNX Runtime
 * arena plus a vector store on a 4 GB machine does not make the index slow, it
 * makes the editor unusable while the index runs, which is the exact failure
 * Andrew asked to prevent.
 *
 * Rejected: 4 GB, on the grounds that the model "only" needs ~400 MB. That
 * reasoning looks at the model in isolation and ignores everything already
 * resident, and 4 GB machines are precisely the ones with no headroom to
 * absorb a mistake.
 */
const MIN_TOTAL_MEM_MB = 8 * 1024;

/**
 * Free RAM at the moment of the check, 1.5 GB.
 *
 * Protects against: winning the allocation and losing the editor. A machine can
 * have 32 GB total and 300 MB free, and loading the model there succeeds right
 * up until something else is paged out. The number is roughly "the top of the
 * model's stated range, plus the runtime's working set, plus a batch of
 * tensors, plus margin" — and the margin is generous on purpose, because:
 *
 * ⚠️ FREE RAM IS THE LEAST TRUSTWORTHY NUMBER HERE. `os.freemem()` on Linux
 * reports MemFree, which excludes reclaimable page cache, so a perfectly
 * healthy machine can report almost nothing free while having gigabytes
 * available. That makes this threshold err toward denial on Linux specifically.
 * Rejected alternative: reading /proc/meminfo's MemAvailable directly, which is
 * the honest number — rejected because it is Linux-only, would need a second
 * code path for Windows and macOS that does not have an equivalent, and a
 * capability gate that behaves differently per platform is a gate nobody can
 * reason about. The chosen answer is one portable number and an override for
 * the person it denies unfairly. ⚠️ NOT VERIFIED on macOS, where the
 * relationship between os.freemem() and actually-available memory has not been
 * checked by anyone who wrote this.
 */
const MIN_FREE_MEM_MB = 1536;

/**
 * Logical CPU cores, 4.
 *
 * Protects against: the index eating the interactive thread. Embedding a
 * workspace is a long CPU-bound pass. On 2 logical cores it competes directly
 * with the renderer that draws the editor and with the agent processes zevet
 * spawns, and the visible symptom is not "indexing is slow", it is "typing is
 * slow". 4 cores means a full core can be given to the index and the UI still
 * has somewhere to run.
 *
 * ⚠️ `os.cpus().length` REPORTS LOGICAL PROCESSORS, AND IN A CONTAINER IT
 * REPORTS THE HOST'S, NOT THE CGROUP QUOTA. A container limited to 1 CPU on a
 * 64-core host passes this check and should not. Not handled: reading
 * cgroup v2's cpu.max would fix it on Linux only, and zevet's desktop app is
 * not a thing people run in containers. Flagged rather than fixed, so whoever
 * hits it knows why.
 */
const MIN_CORES = 4;

/**
 * Free disk in the directory the model will live in, 2 GB.
 *
 * Protects against: filling the disk. The download is the obvious cost — up to
 * ~400 MB of weights, and quite possibly the compressed archive AND the
 * extracted copy on disk at the same moment during install — but the vector
 * store is the one that keeps growing, because it scales with the workspace and
 * is rewritten on reindex. 2 GB covers a worst-case install with both copies
 * resident plus a large store plus enough left that the OS is not at zero.
 *
 * This is the threshold that most deserves its margin: running out of RAM makes
 * things slow, and running out of disk makes things corrupt. A half-written
 * model file or a truncated vector store is a failure the user has to clean up
 * by hand, and it can take unrelated applications down with it.
 */
const MIN_FREE_DISK_MB = 2 * 1024;

/* ========================================================================
 * The budget
 *
 * A yes/no is not enough: a machine with 8 GB that CAN run the index should
 * still attempt far less than one with 64 GB. These are advisory numbers the
 * index module is expected to respect — a ceiling on how much of a workspace to
 * take on, not a promise about how fast it will be.
 * ===================================================================== */

/**
 * Resident bytes per stored chunk. A 384-dimension float32 embedding is 1536
 * bytes; the rest is the file id, the byte offsets and allocator rounding.
 *
 * ⚠️ 384 DIMENSIONS IS AN ASSUMPTION, not a decision anyone has made. It is the
 * width of the small sentence-transformer models that fit the stated 100–400 MB
 * envelope. If the model chosen later is 768-wide, this constant doubles and
 * every budget below halves — which is the correct behaviour, but it means this
 * number must be revisited when the model is picked, not left to rot.
 */
const VECTOR_BYTES_PER_CHUNK = 2048;

/**
 * The share of total RAM the vector store may occupy: 5%.
 *
 * Small on purpose. The store is only one of the index's costs (the model
 * weights and the runtime arena are separate and are NOT drawn from this
 * share), and the number it produces is a ceiling the index is allowed to grow
 * to, not an allocation made up front. On 8 GB that is ~410 MB of store, which
 * is already a large index; the ceiling below stops it running away on a
 * workstation.
 */
const INDEX_MEM_SHARE = 0.05;

/**
 * Chunks per file, 8 — a ~300-line source file cut at roughly 40 lines a chunk.
 * A crude average over a real tree full of short config files and long
 * implementation files. Used only to turn a chunk budget into a file budget.
 */
const AVG_CHUNKS_PER_FILE = 8;

/**
 * Files one core is willing to own in a full pass, 5000. This is what keeps the
 * file budget tied to CPU rather than to RAM alone: a 64 GB machine with 4 slow
 * cores should not be handed a workstation's file count just because it has the
 * memory to hold the result.
 *
 * ⚠️ NOT DERIVED FROM A MEASURED EMBEDDING RATE. Nobody has timed the model. It
 * is a placeholder shaped to keep a full pass in the minutes rather than the
 * hours, and it is the first constant that should be replaced once there is a
 * real throughput number.
 */
const FILES_PER_CORE = 5000;

/**
 * Floors and ceilings.
 *
 * The floors exist so a capable machine is never handed a budget of zero, which
 * would be indistinguishable from "not capable" to a caller that only reads the
 * budget — a silent way to break the feature on a machine that passed. They
 * also cover the forced case, where the measurements may be missing entirely
 * and there is nothing to scale from.
 *
 * The ceilings exist because past a certain size the limit stops being the
 * machine and starts being the workspace: nobody's editor session usefully
 * indexes a million files, and an unbounded budget on a 256 GB server would
 * hand the index permission to try.
 */
const MIN_BUDGET_CHUNKS = 2000;
const MAX_BUDGET_CHUNKS = 500000;
const MIN_BUDGET_FILES = 250;
const MAX_BUDGET_FILES = 100000;

/* ========================================================================
 * Where the model lives, and how much room is there
 * ===================================================================== */

/**
 * The directory the model would be written to.
 *
 * Mirrors main.js's `HOME` (`ZEVET_HOME` or `~/.zevet`) deliberately rather than
 * importing it: main.js is an Electron entry point that pulls in `electron` at
 * require time, and a capability check that cannot be run outside Electron is a
 * capability check that cannot be tested. The duplication is two lines and is
 * called out here so it is changed in both places.
 */
function modelDir(env, osMod) {
  const e = env && typeof env === "object" ? env : process.env;
  const o = osMod && typeof osMod.homedir === "function" ? osMod : nodeOs;
  const home = e.ZEVET_HOME || path.join(o.homedir(), ".zevet");
  return path.join(home, "index", "model");
}

/**
 * Free megabytes on the filesystem holding `dirPath`.
 *
 * ⚠️ MEASURED ON THE MODEL'S DIRECTORY, NOT ON THE CWD. They are routinely
 * different filesystems: on Windows the user profile is on C: while a checkout
 * is on D:, and on Linux $HOME is often a separate and much smaller partition
 * than the one the app was launched from. Asking about the wrong disk produces
 * a confident number about a volume nothing will be written to.
 *
 * `fs.statfs` arrived in Node 18.15, so its presence is CHECKED rather than
 * assumed — and its absence is a denial, not a shrug. There is no portable
 * fallback: rejected alternatives were shelling out to `df` / `wmic` (a
 * subprocess, per platform, parsed from human-readable output, to answer a
 * question we only ask once) and writing a probe file of the required size
 * (which fills the disk to find out whether the disk is full).
 *
 * Returns a finite number of MB, or null when the measurement cannot be taken.
 * Throwing is also allowed — `assess` treats a throw and a null identically —
 * but null is preferred where the cause is knowable.
 *
 * `fsMod` is injectable so a test can drive the no-statfs branch without a Node
 * old enough to lack it.
 */
function freeDiskMB(dirPath, fsMod) {
  const f = fsMod && typeof fsMod === "object" ? fsMod : nodeFs;
  // Node < 18.15. Not "probably plenty" — unknown, and unknown is a denial.
  if (typeof f.statfsSync !== "function") return null;

  const target = nearestExistingDir(dirPath, f);
  if (!target) return null;

  const st = f.statfsSync(target);
  if (!st || typeof st !== "object") return null;
  // `bavail`, not `bfree`: bfree counts the blocks reserved for root, which a
  // model download running as an ordinary user cannot touch. Using bfree would
  // overstate the room by the reserve — 5% of the volume on a default ext4,
  // which is gigabytes on a large disk and would let the check pass on a
  // filesystem the download then cannot write to.
  const free = Number(st.bavail) * Number(st.bsize);
  if (!Number.isFinite(free) || free < 0) return null;
  return Math.floor(free / (1024 * 1024));
}

/**
 * The nearest ancestor of `dirPath` that exists.
 *
 * Needed because on a first run the model directory has NOT been created yet,
 * and statfs on a missing path throws ENOENT — which would deny every machine
 * on the one run where the answer matters most. Creating the directory just to
 * measure it was rejected: a capability check must not have side effects, least
 * of all the side effect of preparing the thing it may be about to refuse.
 *
 * ⚠️ ASSUMES A NOT-YET-CREATED CHILD LANDS ON THE SAME FILESYSTEM AS ITS
 * NEAREST EXISTING ANCESTOR. True unless someone mounts a volume at the
 * intermediate path afterwards, which is not a case worth handling and is not
 * handled.
 */
function nearestExistingDir(dirPath, f) {
  if (typeof dirPath !== "string" || !dirPath) return null;
  let cur = path.resolve(dirPath);
  // Bounded rather than `while (true)`: path.dirname of a root returns the root
  // itself, so a malformed path could otherwise spin here forever. Depth is the
  // only thing being guarded; 64 is far past any real path.
  for (let i = 0; i < 64; i++) {
    try {
      if (typeof f.existsSync === "function" ? f.existsSync(cur) : !!f.statSync(cur)) return cur;
    } catch {
      // Unreadable is not "does not exist", but for this purpose it is the same
      // answer: we cannot measure here, so keep walking up.
    }
    const up = path.dirname(cur);
    if (!up || up === cur) return null;
    cur = up;
  }
  return null;
}

/* ========================================================================
 * The assessment
 * ===================================================================== */

/** Numbers only, and finite ones. NaN, Infinity, null, undefined and "12" are
 *  all "not a measurement" — a string that looks like a number is a stub that
 *  drifted or an API that changed shape, not a value to gate megabytes on. */
function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Bytes to megabytes, with the finiteness check BEFORE the division.
 *
 * Dividing first would be a real bug rather than a style point: `null / 1048576`
 * is 0, not NaN, so an `os` whose totalmem() answered null would be recorded as
 * a machine with 0 MB of RAM — a plausible-looking measurement of a machine
 * that was never measured. It would still deny (0 is under every threshold),
 * but with the wrong reason, telling the user to buy RAM when the truth is that
 * the reading failed.
 */
function bytesToMB(v) {
  return finite(v) === null ? NaN : v / (1024 * 1024);
}

/** Call a measurement, turning every possible failure into null. Returns
 *  `{ value, failed }` — `failed` true means say so in `reasons`. */
function take(fn) {
  let raw;
  try {
    raw = fn();
  } catch {
    return { value: null, failed: true };
  }
  const v = finite(raw);
  return { value: v, failed: v === null };
}

const EMPTY_MEASURED = Object.freeze({
  totalMemMB: null,
  freeMemMB: null,
  cores: null,
  freeDiskMB: null,
  platform: null,
  arch: null,
});

const NO_BUDGET = Object.freeze({ maxFiles: 0, maxChunks: 0 });

/**
 * Should zevet's built-in index run on this machine?
 *
 * `assess({ env, os, disk })` — every input is optional and defaults to the
 * real one. They are injectable because the alternative is testing this laptop
 * instead of testing this logic: there is no other way to exercise the 2 GB
 * machine, the missing-statfs machine or the full-disk machine, and those are
 * exactly the machines this module exists for.
 *
 *   env  — an environment object; defaults to process.env
 *   os   — anything with totalmem/freemem/cpus/platform/arch; defaults to node:os
 *   disk — `(dirPath) => number|null` free MB; defaults to `freeDiskMB`
 *
 * Returns `{ capable, reasons, measured, budget }`.
 *
 * ⚠️ THIS FUNCTION NEVER THROWS, FOR ANY INPUT. That is not defensive
 * decoration, it is the point of the module: it runs at startup, and an
 * exception here would turn "this machine cannot run the optional index" into
 * "zevet does not open" — the precise outcome the feature was gated to avoid.
 * The tests assert it against deliberate garbage.
 */
function assess(opts) {
  try {
    return assessInner(opts);
  } catch {
    // Unreachable by design; every branch below is already guarded. It is here
    // because "by design" is a claim about code that will be edited later, and
    // the cost of being wrong about it is the app not starting.
    return {
      capable: false,
      reasons: ["the capability check itself failed unexpectedly, so the index is off"],
      measured: { ...EMPTY_MEASURED },
      budget: { ...NO_BUDGET },
    };
  }
}

function assessInner(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const env = o.env && typeof o.env === "object" ? o.env : process.env;
  const osMod = o.os && typeof o.os === "object" ? o.os : nodeOs;
  const disk = typeof o.disk === "function" ? o.disk : freeDiskMB;

  /* ── The off switch, before anything is touched ────────────────────────
   *
   * ZEVET_INDEX=off returns here, above every measurement. A person who has
   * turned the feature off must be able to rely on the app not probing their
   * machine for it — not reading their CPU count, and above all not stat-ing
   * their filesystem. "Measure anyway and then ignore the result" would be
   * cheaper to write and would break that promise.
   *
   * It is checked BEFORE the force override on purpose. Someone with both set
   * has contradicted themselves, and `off` wins because honouring `force` would
   * mean taking exactly the measurements `off` promises not to take. */
  const flag = typeof env.ZEVET_INDEX === "string" ? env.ZEVET_INDEX.trim().toLowerCase() : "";
  if (flag === "off" || flag === "0" || flag === "false") {
    return {
      capable: false,
      reasons: ["the index is switched off by ZEVET_INDEX=" + String(env.ZEVET_INDEX)],
      measured: { ...EMPTY_MEASURED },
      budget: { ...NO_BUDGET },
    };
  }

  /* ── Measure ─────────────────────────────────────────────────────────── */

  const total = take(() => bytesToMB(osMod.totalmem()));
  const free = take(() => bytesToMB(osMod.freemem()));
  const cores = take(() => {
    const list = osMod.cpus();
    // A stub that returns undefined, and a Node that reports an empty list
    // (which has happened inside some sandboxes), are both "unknown", not zero.
    return Array.isArray(list) && list.length > 0 ? list.length : NaN;
  });

  const dir = modelDir(env, osMod);
  const freeDisk = take(() => {
    const v = disk(dir);
    // A disk function may legitimately answer null; `take` turns that into a
    // failure, which is what we want. Passing it through unchanged keeps the
    // throw-vs-null distinction invisible to everything below, which is correct
    // — both mean "no measurement".
    return v;
  });

  // Platform and arch are descriptive, not gating: nothing below branches on
  // them, they are carried so a support conversation can start from what the
  // machine actually is. Failing to read them is therefore recorded as null and
  // does NOT deny on its own — and in practice cannot hide anything, because an
  // `os` object broken enough to fail here fails every numeric measurement too.
  const measured = {
    totalMemMB: total.value === null ? null : Math.round(total.value),
    freeMemMB: free.value === null ? null : Math.round(free.value),
    cores: cores.value === null ? null : Math.round(cores.value),
    freeDiskMB: freeDisk.value === null ? null : Math.round(freeDisk.value),
    platform: safeString(() => osMod.platform()),
    arch: safeString(() => osMod.arch()),
  };

  /* ── Judge ───────────────────────────────────────────────────────────────
   *
   * Every check is evaluated; none of them short-circuits. A machine that is
   * short on RAM *and* on disk must say so twice, because a person who buys
   * more RAM on the strength of a single reason and is then denied for disk has
   * been actively misled by this readout. */
  const reasons = [];

  if (total.failed) {
    reasons.push("total RAM could not be measured, so the index stays off rather than guessing");
  } else if (measured.totalMemMB < MIN_TOTAL_MEM_MB) {
    reasons.push(
      `total RAM is ${measured.totalMemMB} MB and the index needs at least ${MIN_TOTAL_MEM_MB} MB`,
    );
  }

  if (free.failed) {
    reasons.push("free RAM could not be measured, so the index stays off rather than guessing");
  } else if (measured.freeMemMB < MIN_FREE_MEM_MB) {
    reasons.push(
      `free RAM is ${measured.freeMemMB} MB right now and loading the model needs at least ${MIN_FREE_MEM_MB} MB free`,
    );
  }

  if (cores.failed) {
    reasons.push("CPU cores could not be counted, so the index stays off rather than guessing");
  } else if (measured.cores < MIN_CORES) {
    reasons.push(
      `CPU cores number ${measured.cores} and the index needs at least ${MIN_CORES} to run without stalling the editor`,
    );
  }

  if (freeDisk.failed) {
    // Spelled out because this one is the likeliest to be taken for a bug. It
    // is not: assuming there is room is how a disk gets filled.
    reasons.push(
      "free disk space could not be measured (fs.statfs is unavailable or failed), and assuming there is room could fill the disk",
    );
  } else if (measured.freeDiskMB < MIN_FREE_DISK_MB) {
    reasons.push(
      `free disk at ${dir} is ${measured.freeDiskMB} MB and the index needs at least ${MIN_FREE_DISK_MB} MB`,
    );
  }

  /* ── The override ────────────────────────────────────────────────────────
   *
   * ZEVET_INDEX_FORCE=1 exists for the person who knows their machine better
   * than four constants written without a benchmark do — the obvious case being
   * the Linux user whose os.freemem() understates availability by gigabytes of
   * page cache. It is the SUPPORTED way to disagree with this file, and it is
   * why the thresholds above are allowed to be conservative.
   *
   * ⚠️ IT IS NOT SOMETHING TO SET BY DEFAULT, not in a shipped config, not in a
   * README's copy-paste block, and not by an installer. It disables the only
   * protection the index has.
   *
   * `reasons` is deliberately still populated — including a first line naming
   * the override itself, so the list is never empty under force. A caller can
   * then show "running because you forced it, over these objections", which is
   * the whole point: an override that hides what it overrode is just a bug with
   * an environment variable in front of it. */
  const forced = String(env.ZEVET_INDEX_FORCE || "").trim() === "1";
  if (forced) {
    reasons.unshift(
      reasons.length
        ? "ZEVET_INDEX_FORCE=1 is set, so the index runs anyway, over the objections below"
        : "ZEVET_INDEX_FORCE=1 is set; the index would have run regardless",
    );
  }

  const capable = forced || reasons.length === 0;

  return {
    capable,
    reasons,
    measured,
    // Not capable means budget zero, so a caller that reads the budget and
    // forgets to read `capable` still does nothing. Fail closed twice.
    budget: capable ? budgetFor(measured) : { ...NO_BUDGET },
  };
}

function safeString(fn) {
  try {
    const v = fn();
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * What this machine should attempt.
 *
 * Chunks come off RAM, because the store is held in memory. Files come off the
 * SMALLER of what those chunks imply and what the cores can chew through, so
 * that neither a memory-rich/core-poor machine nor the reverse gets a budget
 * its other half cannot honour.
 *
 * A measurement that is missing falls back to the floor rather than to a
 * generous default. That path is only reachable under ZEVET_INDEX_FORCE (every
 * other route to a missing measurement has already denied), and someone who has
 * forced past a failed measurement should get the smallest working budget, not
 * the benefit of the doubt.
 */
function budgetFor(m) {
  const totalMemMB = finite(m && m.totalMemMB);
  const cores = finite(m && m.cores);

  const maxChunks = clamp(
    totalMemMB === null
      ? MIN_BUDGET_CHUNKS
      : Math.floor((totalMemMB * 1024 * 1024 * INDEX_MEM_SHARE) / VECTOR_BYTES_PER_CHUNK),
    MIN_BUDGET_CHUNKS,
    MAX_BUDGET_CHUNKS,
  );

  const byChunks = Math.floor(maxChunks / AVG_CHUNKS_PER_FILE);
  const byCores = cores === null ? MIN_BUDGET_FILES : Math.floor(cores * FILES_PER_CORE);
  const maxFiles = clamp(Math.min(byChunks, byCores), MIN_BUDGET_FILES, MAX_BUDGET_FILES);

  return { maxFiles, maxChunks };
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

module.exports = {
  assess,
  budgetFor,
  freeDiskMB,
  nearestExistingDir,
  modelDir,
  MIN_TOTAL_MEM_MB,
  MIN_FREE_MEM_MB,
  MIN_CORES,
  MIN_FREE_DISK_MB,
  MIN_BUDGET_CHUNKS,
  MAX_BUDGET_CHUNKS,
  MIN_BUDGET_FILES,
  MAX_BUDGET_FILES,
  VECTOR_BYTES_PER_CHUNK,
  INDEX_MEM_SHARE,
  AVG_CHUNKS_PER_FILE,
  FILES_PER_CORE,
};
