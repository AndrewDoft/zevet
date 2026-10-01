// Which hub the app talks to is decided in one place, never by a renderer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { PRIMARY_ORIGIN, FALLBACK_ORIGIN, cloudOrigin, hostedHub, pickCloudOrigin, DOMAIN_HUB, LEGACY_HUB, resolveHub } = createRequire(import.meta.url)("../desktop/hub-target.js");

describe("resolveHub", () => {
  test("a new install goes to the hosted hub", () => {
    assert.equal(resolveHub(), hostedHub());
    assert.equal(resolveHub({ env: {}, cfg: null }), hostedHub());
  });

  test("an existing install keeps the hub it stored", () => {
    assert.equal(resolveHub({ cfg: { hub: "https://team.example.com/" } }), "https://team.example.com");
  });

  test("an admin's ZEVET_HUB wins, then the config's defaultHub", () => {
    assert.equal(resolveHub({ env: { ZEVET_HUB: "http://10.0.0.5:8787" }, cfg: { hub: "https://old.example.com" } }), "http://10.0.0.5:8787");
    assert.equal(resolveHub({ cfg: { defaultHub: "https://self.example.com/" } }), "https://self.example.com");
    assert.equal(resolveHub({ cfg: { hub: "https://a.example.com", defaultHub: "https://b.example.com" } }), "https://a.example.com");
  });

  test("junk is ignored, not trusted", () => {
    for (const bad of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "not a url", 5, null]) {
      assert.equal(resolveHub({ env: { ZEVET_HUB: bad }, cfg: { hub: bad, defaultHub: bad } }), hostedHub(), String(bad));
    }
  });

  // D-0NN: hub.usemasora.com replaced the sslip.io address as the default.
  // LEGACY_HUB is never decommissioned (Caddy serves the same hub on both
  // names permanently) and is what main.js's migrateHubDomain compares an
  // existing config against to know it is still on the OLD default.
  test("the hosted hub is the domain, and the legacy sslip address is still named", () => {
    assert.equal(PRIMARY_ORIGIN + "/hub", "https://app.usemasora.com/hub", "the hub lives under the cloud origin");
    assert.equal(DOMAIN_HUB, "https://hub.usemasora.com");
    assert.equal(resolveHub({ cfg: { hub: DOMAIN_HUB } }), DOMAIN_HUB, "an install on the old hub domain keeps working");
    assert.equal(resolveHub({ cfg: { hub: "https://app.usemasora.com/hub/" } }), "https://app.usemasora.com/hub", "a hub with a path keeps it");
    assert.equal(LEGACY_HUB, "https://34-74-69-129.sslip.io");
    assert.notEqual(hostedHub(), LEGACY_HUB);
  });

  test("an install still on the legacy address is exactly what resolveHub returns unchanged", () => {
    // resolveHub itself never migrates anything -- it is main.js's job, and
    // this pins that resolveHub keeps honouring cfg.hub verbatim (including
    // the legacy one) rather than silently preferring hostedHub().
    assert.equal(resolveHub({ cfg: { hub: LEGACY_HUB } }), LEGACY_HUB);
  });
});

describe("pickCloudOrigin", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zevet-co-")), "cloud-origin.json");
  const up = async () => ({ address: "1.2.3.4" });
  const down = async () => { throw new Error("ENOTFOUND"); };
  const hang = () => new Promise(() => {});
  const cached = () => JSON.parse(fs.readFileSync(file, "utf8")).origin;

  test("app.usemasora.com when it resolves, cached so the next launch does no lookup", async () => {
    assert.equal(await pickCloudOrigin({ lookup: up, file }), PRIMARY_ORIGIN);
    assert.equal(cached(), PRIMARY_ORIGIN);
    assert.equal(await pickCloudOrigin({ lookup: () => { throw new Error("looked up"); }, file }), PRIMARY_ORIGIN);
    assert.equal(cloudOrigin(), PRIMARY_ORIGIN);
    assert.equal(hostedHub(), PRIMARY_ORIGIN + "/hub");
  });

  test("the sslip origin when it does not resolve, and when the lookup hangs past the budget", async () => {
    fs.rmSync(file);
    assert.equal(await pickCloudOrigin({ lookup: down, file }), FALLBACK_ORIGIN);
    assert.equal(cached(), FALLBACK_ORIGIN);
    const t = Date.now();
    assert.equal(await pickCloudOrigin({ lookup: hang, file, timeoutMs: 50 }), FALLBACK_ORIGIN);
    assert.ok(Date.now() - t < 1000);
  });

  test("a cached fallback is re-checked: DNS appears later", async () => {
    fs.writeFileSync(file, JSON.stringify({ origin: FALLBACK_ORIGIN }));
    assert.equal(await pickCloudOrigin({ lookup: up, file }), PRIMARY_ORIGIN);
  });

  test("ZEVET_CLOUD_ORIGIN overrides everything", async () => {
    process.env.ZEVET_CLOUD_ORIGIN = "https://cloud.example.com/";
    try {
      assert.equal(await pickCloudOrigin({ lookup: down, file }), "https://cloud.example.com");
      assert.equal(hostedHub(), "https://cloud.example.com/hub");
    } finally {
      delete process.env.ZEVET_CLOUD_ORIGIN;
    }
  });
});
