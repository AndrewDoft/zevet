// Whether zevet's own semantic index is allowed to run on this machine.
//
// These are the tests that matter most in the feature, because the failure they
// guard is not "the index is wrong", it is "zevet does not work on someone's
// machine and they cannot use the product at all". Everything the index does is
// optional; this gate is not.
//
// Every measurement is injected. Running these against the real `os` would test
// this laptop — it would assert that a 64 GB workstation is capable, learn
// nothing about the 4 GB laptop the gate exists for, and quietly change meaning
// on whatever machine ran it next. So `os` and `disk` are stubs throughout, and
// the only test that touches the real filesystem is the one about statfs, which
// is specifically about the real one.
//
// ⚠️ WHAT THESE TESTS DO NOT ESTABLISH: that the thresholds are the RIGHT
// numbers. They cannot — nobody has benchmarked the embedding model, and the
// module says so in its header. What is tested is that each threshold is
// applied, that every failure path denies rather than assumes, and that nothing
// here throws. If the constants are later replaced with measured ones, these
// tests should keep passing unchanged; they are written against the exported
// constants rather than against literals for exactly that reason.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const C = require(path.join(ROOT, "desktop", "index-capability.js"));

const MB = 1024 * 1024;

/** A machine with room to spare, as an `os`-shaped stub. Overrides are in the
 *  units a caller thinks in (MB, cores), not in bytes, so a test that means
 *  "512 MB free" reads as 512 rather than as 536870912.
 *
 *  Key PRESENCE picks the override, not `!== undefined`: one of the values
 *  under test is literally `undefined`, and a helper that treats it as "not
 *  overridden" silently hands back a healthy machine and passes a test that
 *  never ran. That is how this helper was first written, and the assertion it
 *  faked is one of the four that matter most. */
function machine(over = {}) {
  const pick = (k, dflt) => (Object.prototype.hasOwnProperty.call(over, k) ? over[k] : dflt);
  const totalMemMB = pick("totalMemMB", 32768);
  const freeMemMB = pick("freeMemMB", 16384);
  const cores = pick("cores", 16);
  const bytes = (v) => (typeof v === "number" && Number.isFinite(v) ? v * MB : v);
  return {
    totalmem: () => bytes(totalMemMB),
    freemem: () => bytes(freeMemMB),
    cpus: () =>
      typeof cores === "number" && Number.isFinite(cores)
        ? new Array(cores).fill({ model: "stub" })
        : cores,
    platform: () => "linux",
    arch: () => "x64",
    homedir: () => "/home/stub",
  };
}

/** A disk with room, unless told otherwise. */
const roomyDisk = () => 500000;

function assess(over = {}, env = {}, disk = roomyDisk) {
  return C.assess({ env, os: machine(over), disk });
}

/** Does any reason mention this measurement? Reasons are prose on purpose — a
 *  person has to be able to act on them — so the tests match the noun each one
 *  leads with rather than an error code. */
const mentions = (r, re) => r.reasons.some((x) => re.test(x));

describe("a machine that can carry the index", () => {
  test("a generous machine is capable, with nothing to complain about", () => {
    const r = assess();
    assert.equal(r.capable, true);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.measured.totalMemMB, 32768);
    assert.equal(r.measured.cores, 16);
    assert.equal(r.measured.platform, "linux");
    assert.equal(r.measured.arch, "x64");
  });

  test("a machine sitting exactly on every threshold is capable", () => {
    // The boundary is inclusive: "needs at least 8192 MB" must admit 8192 MB.
    // An off-by-one here denies a whole class of machines for no reason and
    // would be invisible without this test.
    const r = assess(
      {
        totalMemMB: C.MIN_TOTAL_MEM_MB,
        freeMemMB: C.MIN_FREE_MEM_MB,
        cores: C.MIN_CORES,
      },
      {},
      () => C.MIN_FREE_DISK_MB,
    );
    assert.equal(r.capable, true, r.reasons.join("; "));
  });
});

describe("each threshold denies on its own", () => {
  test("too little total RAM", () => {
    const r = assess({ totalMemMB: C.MIN_TOTAL_MEM_MB - 1 });
    assert.equal(r.capable, false);
    assert.ok(mentions(r, /total RAM/), r.reasons.join("; "));
    // Exactly one complaint: the other three are fine and must not be blamed.
    assert.equal(r.reasons.length, 1, r.reasons.join("; "));
  });

  test("too little free RAM, even on a big machine", () => {
    // 64 GB total and 300 MB free is a real state, and loading the model there
    // succeeds right up until something else gets paged out.
    const r = assess({ totalMemMB: 65536, freeMemMB: 300 });
    assert.equal(r.capable, false);
    assert.ok(mentions(r, /free RAM/), r.reasons.join("; "));
    assert.ok(!mentions(r, /total RAM/), "blamed total RAM for a free RAM problem");
  });

  test("too few cores", () => {
    const r = assess({ cores: C.MIN_CORES - 1 });
    assert.equal(r.capable, false);
    assert.ok(mentions(r, /CPU cores/), r.reasons.join("; "));
    assert.equal(r.reasons.length, 1, r.reasons.join("; "));
  });

  test("too little free disk", () => {
    const r = assess({}, {}, () => C.MIN_FREE_DISK_MB - 1);
    assert.equal(r.capable, false);
    assert.ok(mentions(r, /free disk/), r.reasons.join("; "));
    assert.equal(r.reasons.length, 1, r.reasons.join("; "));
  });

  test("the reason names the number and the threshold, not just 'no'", () => {
    // A reason a person cannot act on is not a reason. "total RAM is 4096 MB
    // and the index needs at least 8192 MB" tells someone what to change.
    const r = assess({ totalMemMB: 4096 });
    assert.match(r.reasons[0], /4096/);
    assert.match(r.reasons[0], new RegExp(String(C.MIN_TOTAL_MEM_MB)));
  });
});

describe("several problems at once", () => {
  test("a machine borderline on two things lists BOTH", () => {
    // The bug this exists to prevent: short-circuiting on the first failure, so
    // someone buys RAM on the strength of one reason and is then denied for
    // disk. That is worse than no message.
    const r = assess({ totalMemMB: 2048, cores: 2 });
    assert.equal(r.capable, false);
    assert.ok(mentions(r, /total RAM/), r.reasons.join("; "));
    assert.ok(mentions(r, /CPU cores/), r.reasons.join("; "));
    assert.equal(r.reasons.length, 2, r.reasons.join("; "));
  });

  test("a machine that fails everything lists all four", () => {
    const r = assess({ totalMemMB: 1024, freeMemMB: 64, cores: 1 }, {}, () => 10);
    assert.equal(r.capable, false);
    assert.equal(r.reasons.length, 4, r.reasons.join("; "));
    for (const re of [/total RAM/, /free RAM/, /CPU cores/, /free disk/]) {
      assert.ok(mentions(r, re), `missing ${re}: ${r.reasons.join("; ")}`);
    }
  });
});

describe("the disk measurement, which is the one with no os API", () => {
  test("statfs missing means not capable, not 'probably fine'", () => {
    // Node < 18.15 has no fs.statfs at all. The tempting answer is to skip the
    // disk check on those; the honest one is to refuse, because the whole
    // failure mode being guarded is filling somebody's disk.
    const free = C.freeDiskMB("/anywhere", { existsSync: () => true });
    assert.equal(free, null, "a fs without statfsSync must answer null");

    const r = assess({}, {}, () => free);
    assert.equal(r.capable, false);
    assert.ok(mentions(r, /free disk/), r.reasons.join("; "));
  });

  test("statfs throwing does not propagate, it denies", () => {
    const r = assess({}, {}, () => {
      throw new Error("EIO");
    });
    assert.equal(r.capable, false);
    assert.ok(mentions(r, /free disk/), r.reasons.join("; "));
  });

  test("statfs returning nonsense denies rather than producing a nonsense budget", () => {
    for (const bad of [NaN, Infinity, -1, null, undefined, "lots", {}]) {
      const r = assess({}, {}, () => bad);
      assert.equal(r.capable, false, `${String(bad)} was treated as a real measurement`);
      assert.ok(mentions(r, /free disk/), `${String(bad)}: ${r.reasons.join("; ")}`);
    }
  });

  test("the measurement is taken on the model's directory, not the cwd", () => {
    // They are routinely different filesystems — C: versus D: on Windows, a
    // separate /home partition on Linux. Measuring the cwd answers confidently
    // about a volume nothing will be written to.
    let seen = null;
    C.assess({
      env: { ZEVET_HOME: "/opt/zevet-home" },
      os: machine(),
      disk: (p) => {
        seen = p;
        return 500000;
      },
    });
    assert.ok(seen, "the disk function was never called");
    assert.ok(
      seen.includes("zevet-home"),
      `measured ${seen}, which is not under the configured ZEVET_HOME`,
    );
    assert.notEqual(path.resolve(seen), process.cwd());
  });

  test("the real statfs path answers a real number for a directory that exists", () => {
    // The one test that touches this machine. It asserts only that the wiring
    // works and the units are megabytes — not any particular amount of room,
    // which would make the suite depend on how full the runner's disk is.
    const mb = C.freeDiskMB(ROOT);
    if (mb === null) {
      // A Node without statfsSync. Not a failure of this module: the module's
      // documented answer for that machine is exactly null.
      assert.equal(typeof require("node:fs").statfsSync, "undefined");
      return;
    }
    assert.ok(Number.isFinite(mb) && mb >= 0, `got ${mb}`);
  });

  test("a directory that does not exist yet measures its nearest existing parent", () => {
    // On a first run the model directory has NOT been created. statfs on a
    // missing path throws ENOENT, which would deny every machine on the one run
    // where the answer matters.
    const missing = path.join(ROOT, "no-such-dir-" + Date.now(), "model");
    const near = C.nearestExistingDir(missing, require("node:fs"));
    assert.ok(near, "walked past every ancestor");
    assert.equal(near, ROOT);
    const mb = C.freeDiskMB(missing);
    assert.ok(mb === null || Number.isFinite(mb), `got ${mb}`);
  });

  test("nearestExistingDir gives up rather than looping on a path with no root", () => {
    assert.equal(C.nearestExistingDir("", { existsSync: () => false }), null);
    assert.equal(C.nearestExistingDir(null, { existsSync: () => false }), null);
    assert.equal(C.nearestExistingDir("/a/b/c", { existsSync: () => false }), null);
    // An existsSync that throws is "cannot measure here", not a crash.
    assert.equal(
      C.nearestExistingDir("/a/b/c", {
        existsSync: () => {
          throw new Error("EPERM");
        },
      }),
      null,
    );
  });
});

describe("a measurement that cannot be taken", () => {
  test("a throwing os denies and names what failed", () => {
    const boom = (name) => {
      const m = machine();
      m[name] = () => {
        throw new Error("no");
      };
      return m;
    };
    const cases = [
      ["totalmem", /total RAM/],
      ["freemem", /free RAM/],
      ["cpus", /CPU cores/],
    ];
    for (const [fn, re] of cases) {
      const r = C.assess({ env: {}, os: boom(fn), disk: roomyDisk });
      assert.equal(r.capable, false, `${fn} threw and the machine was still called capable`);
      assert.ok(mentions(r, re), `${fn}: ${r.reasons.join("; ")}`);
      assert.ok(mentions(r, /could not be/), `${fn}: ${r.reasons.join("; ")}`);
      assert.equal(r.measured[fn === "cpus" ? "cores" : fn === "totalmem" ? "totalMemMB" : "freeMemMB"], null);
    }
  });

  test("NaN, null and undefined are all 'not measured', never zero", () => {
    // The trap: `null / 1048576` is 0, not NaN. Dividing before checking would
    // record a machine with "0 MB of RAM" — a plausible-looking measurement of
    // a machine that was never measured, and a reason telling the user to buy
    // RAM when the truth is that the reading failed.
    for (const bad of [NaN, null, undefined]) {
      const r = assess({ totalMemMB: bad });
      assert.equal(r.capable, false, `${String(bad)} total RAM was accepted`);
      assert.equal(r.measured.totalMemMB, null, `${String(bad)} became a number`);
      assert.ok(mentions(r, /total RAM could not be measured/), r.reasons.join("; "));
    }
  });

  test("an empty cpu list is unknown, not zero cores", () => {
    const m = machine();
    m.cpus = () => [];
    const r = C.assess({ env: {}, os: m, disk: roomyDisk });
    assert.equal(r.capable, false);
    assert.equal(r.measured.cores, null);
    assert.ok(mentions(r, /CPU cores could not be counted/), r.reasons.join("; "));
  });

  test("platform and arch failing does not deny on its own", () => {
    // Nothing is gated on them; they are carried so a support conversation can
    // start from what the machine is. Denying a capable machine because a
    // cosmetic string was unreadable would help nobody.
    const m = machine();
    m.platform = () => {
      throw new Error("no");
    };
    m.arch = () => undefined;
    const r = C.assess({ env: {}, os: m, disk: roomyDisk });
    assert.equal(r.capable, true, r.reasons.join("; "));
    assert.equal(r.measured.platform, null);
    assert.equal(r.measured.arch, null);
  });
});

describe("the off switch", () => {
  test("ZEVET_INDEX=off denies without taking a single measurement", () => {
    // The promise is not "measure and ignore the result", it is "do not probe
    // this machine". Spies, so the promise is actually checked.
    const calls = [];
    const spy = {
      totalmem: () => (calls.push("totalmem"), 64 * 1024 * MB),
      freemem: () => (calls.push("freemem"), 32 * 1024 * MB),
      cpus: () => (calls.push("cpus"), new Array(16).fill({})),
      platform: () => (calls.push("platform"), "linux"),
      arch: () => (calls.push("arch"), "x64"),
      homedir: () => (calls.push("homedir"), "/home/stub"),
    };
    const disk = () => (calls.push("disk"), 500000);

    const r = C.assess({ env: { ZEVET_INDEX: "off" }, os: spy, disk });
    assert.equal(r.capable, false);
    assert.deepEqual(calls, [], `took measurements after being switched off: ${calls.join(", ")}`);
    assert.ok(mentions(r, /switched off/), r.reasons.join("; "));
    assert.deepEqual(r.measured, {
      totalMemMB: null, freeMemMB: null, cores: null,
      freeDiskMB: null, platform: null, arch: null,
    });
    assert.deepEqual(r.budget, { maxFiles: 0, maxChunks: 0 });
  });

  test("off wins over force, and still probes nothing", () => {
    // Someone with both set has contradicted themselves. `off` wins because
    // honouring `force` would mean taking the measurements `off` promises not
    // to take.
    const calls = [];
    const spy = { ...machine() };
    for (const k of Object.keys(spy)) {
      const orig = spy[k];
      spy[k] = (...a) => (calls.push(k), orig(...a));
    }
    const r = C.assess({
      env: { ZEVET_INDEX: "off", ZEVET_INDEX_FORCE: "1" },
      os: spy,
      disk: () => (calls.push("disk"), 500000),
    });
    assert.equal(r.capable, false);
    assert.deepEqual(calls, []);
  });

  test("case and whitespace do not defeat the off switch", () => {
    for (const v of ["off", "OFF", " Off ", "0", "false"]) {
      assert.equal(C.assess({ env: { ZEVET_INDEX: v }, os: machine(), disk: roomyDisk }).capable,
        false, `ZEVET_INDEX=${JSON.stringify(v)} did not switch it off`);
    }
  });

  test("an unset or unrelated ZEVET_INDEX does not switch it off", () => {
    for (const env of [{}, { ZEVET_INDEX: "" }, { ZEVET_INDEX: "on" }, { ZEVET_INDEX: "1" }]) {
      assert.equal(C.assess({ env, os: machine(), disk: roomyDisk }).capable, true);
    }
  });
});

describe("the override", () => {
  test("ZEVET_INDEX_FORCE=1 makes a hopeless machine capable", () => {
    const r = assess({ totalMemMB: 1024, freeMemMB: 64, cores: 1 }, { ZEVET_INDEX_FORCE: "1" }, () => 10);
    assert.equal(r.capable, true);
  });

  test("forcing keeps every reason, so the caller can show what was overridden", () => {
    // An override that hides what it overrode is a bug with an environment
    // variable in front of it.
    const r = assess({ totalMemMB: 1024, cores: 1 }, { ZEVET_INDEX_FORCE: "1" }, () => 10);
    assert.equal(r.capable, true);
    assert.ok(mentions(r, /total RAM/), r.reasons.join("; "));
    assert.ok(mentions(r, /CPU cores/), r.reasons.join("; "));
    assert.ok(mentions(r, /free disk/), r.reasons.join("; "));
    assert.ok(mentions(r, /ZEVET_INDEX_FORCE/), r.reasons.join("; "));
    assert.match(r.reasons[0], /ZEVET_INDEX_FORCE/, "the override is not named first");
  });

  test("forcing a machine that needed no forcing still says so", () => {
    // `reasons` is never empty under force, so a UI can always render
    // "running because you forced it" rather than silently looking normal.
    const r = assess({}, { ZEVET_INDEX_FORCE: "1" });
    assert.equal(r.capable, true);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0], /ZEVET_INDEX_FORCE/);
  });

  test("only the exact value 1 forces", () => {
    // A half-set variable must not quietly disable the only protection the
    // index has.
    for (const v of ["", "0", "yes", "true", "11", "on"]) {
      const r = assess({ totalMemMB: 1024 }, { ZEVET_INDEX_FORCE: v });
      assert.equal(r.capable, false, `ZEVET_INDEX_FORCE=${JSON.stringify(v)} forced`);
    }
  });

  test("a forced machine whose measurements all failed still gets a usable budget", () => {
    // The only route to a missing measurement on a capable result. The floor,
    // not the benefit of the doubt.
    const broken = {
      totalmem: () => { throw new Error("no"); },
      freemem: () => { throw new Error("no"); },
      cpus: () => { throw new Error("no"); },
      platform: () => { throw new Error("no"); },
      arch: () => { throw new Error("no"); },
      homedir: () => "/home/stub",
    };
    const r = C.assess({
      env: { ZEVET_INDEX_FORCE: "1" },
      os: broken,
      disk: () => { throw new Error("no"); },
    });
    assert.equal(r.capable, true);
    assert.equal(r.budget.maxFiles, C.MIN_BUDGET_FILES);
    assert.equal(r.budget.maxChunks, C.MIN_BUDGET_CHUNKS);
    assert.ok(r.budget.maxFiles > 0 && r.budget.maxChunks > 0);
  });
});

describe("the budget", () => {
  test("a denied machine is budgeted zero, so a caller that ignores `capable` does nothing", () => {
    const r = assess({ totalMemMB: 1024 });
    assert.equal(r.capable, false);
    assert.deepEqual(r.budget, { maxFiles: 0, maxChunks: 0 });
  });

  test("it scales with the machine", () => {
    const small = assess({ totalMemMB: 8192, freeMemMB: 4096, cores: 4 });
    const large = assess({ totalMemMB: 32768, freeMemMB: 16384, cores: 16 });
    assert.equal(small.capable, true, small.reasons.join("; "));
    assert.equal(large.capable, true, large.reasons.join("; "));
    assert.ok(large.budget.maxChunks > small.budget.maxChunks,
      `${large.budget.maxChunks} is not more than ${small.budget.maxChunks}`);
    assert.ok(large.budget.maxFiles > small.budget.maxFiles,
      `${large.budget.maxFiles} is not more than ${small.budget.maxFiles}`);
  });

  test("cores cap the file budget even when there is memory to spare", () => {
    // A memory-rich, core-poor machine must not be handed a workstation's file
    // count just because it could hold the result.
    const rich = assess({ totalMemMB: 65536, freeMemMB: 32768, cores: 4 });
    const richer = assess({ totalMemMB: 65536, freeMemMB: 32768, cores: 32 });
    assert.ok(rich.budget.maxFiles < richer.budget.maxFiles);
    assert.ok(rich.budget.maxFiles <= 4 * C.FILES_PER_CORE);
  });

  test("it is never zero or negative on a capable machine, at any size", () => {
    for (const totalMemMB of [C.MIN_TOTAL_MEM_MB, 12288, 16384, 65536, 262144, 4194304]) {
      for (const cores of [C.MIN_CORES, 8, 64, 512]) {
        const r = assess({ totalMemMB, freeMemMB: C.MIN_FREE_MEM_MB, cores });
        assert.equal(r.capable, true, `${totalMemMB}/${cores}: ${r.reasons.join("; ")}`);
        assert.ok(Number.isInteger(r.budget.maxFiles) && r.budget.maxFiles > 0,
          `${totalMemMB}/${cores} gave maxFiles ${r.budget.maxFiles}`);
        assert.ok(Number.isInteger(r.budget.maxChunks) && r.budget.maxChunks > 0,
          `${totalMemMB}/${cores} gave maxChunks ${r.budget.maxChunks}`);
      }
    }
  });

  test("it is bounded, so a huge machine does not get permission to try anything", () => {
    const huge = C.budgetFor({ totalMemMB: 1024 * 1024 * 8, cores: 4096 });
    assert.ok(huge.maxChunks <= C.MAX_BUDGET_CHUNKS);
    assert.ok(huge.maxFiles <= C.MAX_BUDGET_FILES);
  });

  test("budgetFor survives garbage on its own, since it is exported", () => {
    for (const bad of [null, undefined, {}, { totalMemMB: "8192", cores: NaN }, 7, "x"]) {
      const b = C.budgetFor(bad);
      assert.ok(b.maxFiles >= C.MIN_BUDGET_FILES, `${JSON.stringify(bad)} -> ${b.maxFiles}`);
      assert.ok(b.maxChunks >= C.MIN_BUDGET_CHUNKS, `${JSON.stringify(bad)} -> ${b.maxChunks}`);
    }
  });
});

describe("it never throws", () => {
  test("assess survives nonsense of every shape", () => {
    // This runs at startup. An exception here turns "this machine cannot run
    // the optional index" into "zevet does not open", which is the precise
    // outcome the whole feature was gated to avoid. So: a fuzz-ish sweep over
    // inputs nobody should ever pass, asserting only that a well-formed answer
    // comes back.
    const throwing = () => {
      throw new Error("boom");
    };
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile");
      },
    });

    const envs = [
      undefined, null, 0, "", "off", 42, [], { ZEVET_INDEX: 5 }, { ZEVET_INDEX: {} },
      { ZEVET_INDEX_FORCE: {} }, { ZEVET_HOME: 5 }, { ZEVET_HOME: "" },
      { ZEVET_HOME: " bad" }, Object.create(null),
    ];
    const oses = [
      undefined, null, 0, "os", [], {}, machine(), hostile,
      { totalmem: throwing, freemem: throwing, cpus: throwing, platform: throwing, arch: throwing, homedir: throwing },
      { totalmem: () => "8gb", freemem: () => [], cpus: () => "four", platform: () => 7, arch: () => null, homedir: () => 3 },
      { totalmem: () => Infinity, freemem: () => -Infinity, cpus: () => ({ length: 8 }), platform: () => "", arch: () => "", homedir: () => "/h" },
    ];
    const disks = [
      undefined, null, 0, "disk", throwing, () => 500000, () => null, () => NaN,
      () => -5, () => "500000", () => ({}), () => Infinity,
    ];

    let n = 0;
    for (const env of envs) {
      for (const os of oses) {
        for (const disk of disks) {
          let r;
          assert.doesNotThrow(() => {
            r = C.assess({ env, os, disk });
          }, `env=${JSON.stringify(env)} os=${typeof os} disk=${typeof disk}`);
          assert.equal(typeof r.capable, "boolean");
          assert.ok(Array.isArray(r.reasons));
          assert.ok(r.measured && typeof r.measured === "object");
          assert.ok(Number.isInteger(r.budget.maxFiles) && r.budget.maxFiles >= 0);
          assert.ok(Number.isInteger(r.budget.maxChunks) && r.budget.maxChunks >= 0);
          // The invariant that matters: capable false is always a budget of
          // zero, and capable true is always a budget worth having.
          if (!r.capable) {
            assert.deepEqual(r.budget, { maxFiles: 0, maxChunks: 0 });
            assert.ok(r.reasons.length > 0, "denied with no reason given");
          } else {
            assert.ok(r.budget.maxFiles > 0 && r.budget.maxChunks > 0);
          }
          n++;
        }
      }
    }
    assert.ok(n > 1000, `only ${n} combinations were tried`);
  });

  test("assess survives being called with no arguments at all", () => {
    // The real call, against the real machine. It asserts the SHAPE, never the
    // verdict: whether this particular runner is capable is not a property of
    // the code, and asserting it would make the suite pass or fail on hardware.
    for (const args of [[], [undefined], [null], ["nonsense"], [42]]) {
      const r = C.assess(...args);
      assert.equal(typeof r.capable, "boolean");
      assert.ok(Array.isArray(r.reasons));
      assert.ok("totalMemMB" in r.measured && "freeDiskMB" in r.measured);
    }
  });

  test("freeDiskMB survives garbage rather than throwing at the caller", () => {
    // `assess` catches, but this is exported and something else may call it.
    for (const bad of [null, undefined, "", 42, {}, []]) {
      assert.doesNotThrow(() => C.freeDiskMB(bad, { existsSync: () => false }));
      assert.equal(C.freeDiskMB(bad, { existsSync: () => false }), null);
    }
  });

  test("modelDir always returns a string, whatever it is handed", () => {
    for (const env of [undefined, null, {}, { ZEVET_HOME: "/opt/z" }]) {
      const d = C.modelDir(env, { homedir: () => "/home/stub" });
      assert.equal(typeof d, "string");
      assert.ok(d.length > 0);
    }
  });
});
