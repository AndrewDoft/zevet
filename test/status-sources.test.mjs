// The status strip's data sources.
//
// The vault half runs against real health files written into a temp directory,
// because the thing that breaks here is precedence — which problem wins when a
// vault is stale AND unsynced — and precedence is only visible when several
// states are set at once.
//
// ⚠️ WHAT IS NOT TESTED, because it cannot be from here: that the usage shapes
// below are the shapes Claude Code actually emits. They are written from the
// documented stream-json format. Every getter is written to answer null rather
// than throw on a shape it does not recognise, and THAT is what these tests
// establish — not that the happy path matches reality.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = require(path.join(ROOT, "desktop", "status-sources.js"));

let dir;
before(() => { dir = mkdtempSync(path.join(tmpdir(), "zevet-status-")); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ } });

const NOW = Date.parse("2026-09-18T12:00:00Z");

function health(name, obj) {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("the vault graph", () => {
  test("a healthy vault reports its shared count and head", () => {
    // This is the real payload off this machine on 2026-09-18, trimmed.
    const p = health("ok.json", {
      notes: 490, shared: 465, errors: 0, reported: 0,
      auto: "2026-09-18T07:30:10.289Z", sync: "synced", head: "8cd46c5",
    });
    const h = S.vaultHealth(p, NOW);
    assert.equal(h.state, "ok");
    assert.equal(h.count, 465);
    assert.equal(h.head, "8cd46c5");
  });

  test("the count is the SHARED one, not the raw note count", () => {
    // The raw count includes machine-local nodes, so two machines in sync show
    // different numbers and look broken. 465, not 490.
    const p = health("shared.json", { notes: 490, shared: 465, sync: "synced" });
    assert.equal(S.vaultHealth(p, NOW).count, 465);
  });

  test("a vault with no shared field falls back to notes", () => {
    const p = health("old.json", { notes: 12, sync: "synced" });
    assert.equal(S.vaultHealth(p, NOW).count, 12);
  });

  test("errors outrank everything else", () => {
    const p = health("err.json", {
      shared: 465, errors: 3, reported: 9, sync: "diverged",
      auto: "2020-01-01T00:00:00Z",
    });
    const h = S.vaultHealth(p, NOW);
    assert.equal(h.state, "errors");
    assert.equal(h.detail, "3 err");
  });

  test("open reports outrank staleness and sync", () => {
    const p = health("rep.json", {
      shared: 465, errors: 0, reported: 2, sync: "diverged",
      auto: "2020-01-01T00:00:00Z",
    });
    assert.equal(S.vaultHealth(p, NOW).state, "reported");
  });

  test("staleness outranks an unsynced flag", () => {
    const p = health("stale.json", {
      shared: 465, auto: "2026-09-01T00:00:00Z", sync: "diverged",
    });
    const h = S.vaultHealth(p, NOW);
    assert.equal(h.state, "stale");
    assert.equal(h.detail, "17d stale");
  });

  test("a vault refreshed today is not stale", () => {
    const p = health("fresh.json", { shared: 465, auto: "2026-09-18T07:30:10.289Z", sync: "synced" });
    assert.equal(S.vaultHealth(p, NOW).state, "ok");
  });

  test("diverged and unsynced are reported, synced and offline are not", () => {
    assert.equal(S.vaultHealth(health("d.json", { shared: 1, sync: "diverged" }), NOW).state, "unsynced");
    assert.equal(S.vaultHealth(health("u.json", { shared: 1, sync: "unsynced" }), NOW).state, "unsynced");
    assert.equal(S.vaultHealth(health("s.json", { shared: 1, sync: "synced" }), NOW).state, "ok");
    const off = S.vaultHealth(health("o.json", { shared: 1, sync: "offline" }), NOW);
    assert.equal(off.state, "ok");
    assert.equal(off.detail, "offline");
  });

  test("a missing vault is not an error", () => {
    // Most machines have no vault. Drawing that in red would be wrong on all
    // of them.
    const h = S.vaultHealth(path.join(dir, "nope.json"), NOW);
    assert.equal(h.state, "missing");
    assert.equal(h.count, null);
  });

  test("an unparseable health file is missing, not a crash", () => {
    const p = path.join(dir, "junk.json");
    writeFileSync(p, "{not json");
    assert.equal(S.vaultHealth(p, NOW).state, "missing");
  });
});

describe("timestamp handling", () => {
  test("a timestamp with no zone is read as UTC, not local", () => {
    // The trap: the spec says a date-time with no offset is LOCAL time, so on a
    // machine six hours off UTC a vault refreshed a minute ago reads as six
    // hours old -- or a stale one reads as fresh. Both directions are bugs.
    const withZ = S.ageInDays("2026-09-18T06:00:00.000Z", NOW);
    const without = S.ageInDays("2026-09-18T06:00:00.000", NOW);
    assert.ok(Math.abs(withZ - 0.25) < 1e-6);
    assert.equal(without, withZ, "a zoneless timestamp was not read as UTC");
  });

  test("junk is null rather than NaN", () => {
    assert.equal(S.ageInDays("yesterday", NOW), null);
    assert.equal(S.ageInDays(null, NOW), null);
    assert.equal(S.ageInDays("2026", NOW), null);
  });
});

describe("the port probe", () => {
  test("a listening port is up and a closed one is not", async () => {
    const server = net.createServer(() => {});
    const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
    assert.equal(await S.probePort(port, "127.0.0.1", 500), true);
    await new Promise((r) => server.close(r));
    assert.equal(await S.probePort(port, "127.0.0.1", 500), false);
  });

  test("it resolves false rather than rejecting", async () => {
    // It runs on a timer behind a UI. A rejection here would be an unhandled
    // rejection once a second.
    assert.equal(await S.probePort(1, "127.0.0.1", 100), false);
    assert.equal(await S.probePort(99999, "127.0.0.1", 100), false);
  });
});

describe("usage off the agent stream", () => {
  test("context is input plus BOTH cache fields and excludes output", () => {
    // The mistake statusline.py records having made: adding output on top
    // double-counts, because this turn's output is inside next turn's input.
    const u = S.usageFrom({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 900,
          output_tokens: 5000,
        },
      },
    });
    assert.equal(u.context, 10000);
    assert.equal(u.output, 5000);
    assert.equal(u.model, "claude-opus-5");
  });

  test("the cache hit rate is the share of input served from cache", () => {
    const u = S.usageFrom({ usage: { input_tokens: 100, cache_read_input_tokens: 900 } });
    assert.equal(Math.round(u.cacheHit), 90);
  });

  test("no input at all gives a null hit rate, not zero", () => {
    // "no data" and "0% cached" are opposite readings; one means the prefix was
    // thrown away and this turn is expensive.
    const u = S.usageFrom({ usage: { output_tokens: 5 } });
    assert.equal(u.cacheHit, null);
  });

  test("a line with no usage is null", () => {
    assert.equal(S.usageFrom({ type: "system", subtype: "init" }), null);
    assert.equal(S.usageFrom({}), null);
    assert.equal(S.usageFrom(null), null);
    assert.equal(S.usageFrom("a string"), null);
  });

  test("a usage object full of nonsense does not throw or produce NaN", () => {
    const u = S.usageFrom({ usage: { input_tokens: "lots", cache_read_input_tokens: null, output_tokens: 3 } });
    assert.equal(u.context, 0);
    assert.equal(u.output, 3);
    assert.ok(!Number.isNaN(u.context));
  });

  test("cost is read only where it is reported", () => {
    assert.equal(S.costFrom({ type: "result", total_cost_usd: 1.25 }), 1.25);
    assert.equal(S.costFrom({ type: "assistant" }), null);
    assert.equal(S.costFrom({ total_cost_usd: "1.25" }), null);
  });

  test("the model comes off the init line", () => {
    assert.equal(S.modelFrom({ type: "system", subtype: "init", model: "claude-opus-5" }), "claude-opus-5");
    assert.equal(S.modelFrom({ type: "assistant", model: "x" }), null);
  });
});

describe("rolling spend", () => {
  test("tokens inside the window count and older ones do not", () => {
    const b = new S.BurnWindows();
    const t = NOW;
    b.add({ tokens: 1000 }, t - 8 * 3600000);   // 8h ago: inside 7d, outside 5h
    b.add({ tokens: 500 }, t - 3600000);        // 1h ago: inside both
    const r = b.read(t);
    assert.equal(r["5h"].tokens, 500);
    assert.equal(r["7d"].tokens, 1500);
  });

  test("samples older than the longest window are dropped, not kept forever", () => {
    const b = new S.BurnWindows();
    b.add({ tokens: 1 }, NOW - 30 * 24 * 3600000);
    b.add({ tokens: 2 }, NOW);
    assert.equal(b.samples.length, 1);
    assert.equal(b.read(NOW)["7d"].tokens, 2);
  });

  test("cost REPLACES per session rather than accumulating", () => {
    // Claude Code reports total_cost_usd as a running session total on every
    // result line. Summing them multiplies the bill by the number of turns.
    const b = new S.BurnWindows();
    b.add({ tokens: 10, cost: 0.10, sessionId: "a" }, NOW);
    b.add({ tokens: 10, cost: 0.25, sessionId: "a" }, NOW);
    b.add({ tokens: 10, cost: 0.05, sessionId: "b" }, NOW);
    assert.equal(Number(b.read(NOW).cost.toFixed(2)), 0.30);
  });

  test("a sample with no tokens does not create an entry", () => {
    const b = new S.BurnWindows();
    b.add({ cost: 1, sessionId: "a" }, NOW);
    assert.equal(b.samples.length, 0);
    assert.equal(b.read(NOW).cost, 1);
  });

  test("an empty window reads zero rather than throwing", () => {
    const r = new S.BurnWindows().read(NOW);
    assert.equal(r["5h"].tokens, 0);
    assert.equal(r.cost, 0);
  });
});
