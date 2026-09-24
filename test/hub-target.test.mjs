// Which hub the app talks to is decided in one place, never by a renderer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { HOSTED_HUB, resolveHub } = createRequire(import.meta.url)("../desktop/hub-target.js");

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
});
