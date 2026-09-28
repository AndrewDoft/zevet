// One malformed request must not kill the hub (audit B1/B5): an undecodable
// cookie and an unparseable request target both used to throw out of the async
// request handler and take the process down for everyone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startHub } from "./helpers.mjs";

const hub = await startHub();
after(() => hub.stop());

function raw(port, requestLine, headers = "") {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`${requestLine} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n${headers}\r\n`);
    });
    let out = "";
    s.on("data", (c) => (out += c));
    s.on("close", () => resolve(out));
    s.on("error", reject);
  });
}

test("cookie with a bad %-escape is refused, not fatal", async () => {
  const res = await fetch(`${hub.base}/api/state`, { headers: { cookie: "zevet_session=%" } });
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
  assert.equal((await fetch(`${hub.base}/healthz`)).status, 200);
});

test("unparseable request target gets a 400, not a dead hub", async () => {
  const out = await raw(new URL(hub.base).port, "GET //[");
  assert.match(out, /^HTTP\/1\.1 4\d\d /);
  assert.equal((await fetch(`${hub.base}/healthz`)).status, 200);
});
