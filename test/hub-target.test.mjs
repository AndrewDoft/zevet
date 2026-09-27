// Which hub the app talks to is decided in one place, never by a renderer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { HOSTED_HUB, LEGACY_HUB, resolveHub } = createRequire(import.meta.url)("../desktop/hub-target.js");

describe("resolveHub", () => {
  test("a new install goes to the hosted hub", () => {
    assert.equal(resolveHub(), HOSTED_HUB);
    assert.equal(resolveHub({ env: {}, cfg: null }), HOSTED_HUB);
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
      assert.equal(resolveHub({ env: { ZEVET_HUB: bad }, cfg: { hub: bad, defaultHub: bad } }), HOSTED_HUB, String(bad));
    }
  });

  // D-0NN: hub.usemasora.com replaced the sslip.io address as the default.
  // LEGACY_HUB is never decommissioned (Caddy serves the same hub on both
  // names permanently) and is what main.js's migrateHubDomain compares an
  // existing config against to know it is still on the OLD default.
  test("the hosted hub is the domain, and the legacy sslip address is still named", () => {
    assert.equal(HOSTED_HUB, "https://hub.usemasora.com");
    assert.equal(LEGACY_HUB, "https://34-74-69-129.sslip.io");
    assert.notEqual(HOSTED_HUB, LEGACY_HUB);
  });

  test("an install still on the legacy address is exactly what resolveHub returns unchanged", () => {
    // resolveHub itself never migrates anything -- it is main.js's job, and
    // this pins that resolveHub keeps honouring cfg.hub verbatim (including
    // the legacy one) rather than silently preferring HOSTED_HUB.
    assert.equal(resolveHub({ cfg: { hub: LEGACY_HUB } }), LEGACY_HUB);
  });
});
