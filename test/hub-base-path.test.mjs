// The hub under a path of another origin (app.usemasora.com/hub/): the proxy strips the prefix, the hub re-adds it
// to everything it hands the browser. A prefix-less request must come out byte-identical.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basePrefix, htmlUnder, cssUnder } from "../hub/base-path.mjs";
const { socketUrl } = createRequire(import.meta.url)("../desktop/doc-sync.js");

const html = '<!doctype html><html><head>\n<link rel="stylesheet" href="/board.css" /><script type="module" src="/board.js"></script></head></html>';

describe("hub base path", () => {
  test("only one plain segment is a prefix", () => {
    assert.equal(basePrefix({ "x-forwarded-prefix": "/hub/" }), "/hub");
    for (const bad of ["", "hub", "/a/b", "/x\"><script>", "//evil.com", undefined]) assert.equal(basePrefix({ "x-forwarded-prefix": bad }), "", String(bad));
  });
  test("no prefix, no change", () => {
    assert.equal(htmlUnder(html, ""), html);
    assert.equal(cssUnder("a{src:url(/fonts/x.woff2)}", ""), "a{src:url(/fonts/x.woff2)}");
  });
  test("the page's own urls, fonts and the runtime shim carry the prefix", () => {
    const out = htmlUnder(html, "/hub");
    assert.match(out, /href="\/hub\/board\.css"/);
    assert.match(out, /src="\/hub\/board\.js"/);
    assert.match(out, /window\.__zevetBase=b\}\)\("\/hub"\)/);
    assert.equal(cssUnder('src:url("/fonts/a.woff2");src:url(/fonts/b.woff2)', "/hub"), 'src:url("/hub/fonts/a.woff2");src:url(/hub/fonts/b.woff2)');
  });
  test("the shim prefixes fetch, EventSource and WebSocket paths and leaves absolute urls alone", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(htmlUnder(html, "/hub"))[1];
    const seen = [];
    const win = { fetch: (u) => seen.push(["fetch", u]), EventSource: function (u) { seen.push(["es", u]); }, WebSocket: function (u) { seen.push(["ws", u]); } };
    win.EventSource.prototype = {}; win.WebSocket.prototype = {};
    new Function("window", "XMLHttpRequest", "Request", "location", "URL", script)(win, { prototype: { open() {} } }, function () {}, { href: "https://app.x/hub/", host: "app.x" }, URL);
    win.fetch("/api/state"); win.fetch("https://other/x"); new win.EventSource("/events"); new win.WebSocket("wss://app.x/ws?token=t");
    assert.deepEqual(seen, [["fetch", "/hub/api/state"], ["fetch", "https://other/x"], ["es", "/hub/events"], ["ws", "wss://app.x/hub/ws?token=t"]]);
  });
  test("the desktop's doc socket keeps a hub path", () => {
    assert.equal(socketUrl("https://app.usemasora.com/hub", "r").pathname, "/hub/ws");
    assert.equal(socketUrl("https://hub.usemasora.com", "r").pathname, "/ws");
  });
});

describe("the hub behind a path-stripping proxy", async () => {
  const { startHub, TOKEN } = await import("./helpers.mjs");
  const { after } = await import("node:test");
  const hub = await startHub({});
  after(() => hub.stop());
  const via = { "x-forwarded-prefix": "/hub", "x-forwarded-proto": "https" };

  test("a token link redirects and sets its cookie under the prefix", async () => {
    const r = await fetch(`${hub.base}/?token=${TOKEN}`, { headers: via, redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/hub/");
    assert.match(r.headers.get("set-cookie"), /Path=\/hub;/);
  });
  test("the page and stylesheet carry the prefix; without the header nothing changes", async () => {
    const cookie = { ...via, "x-zevet-token": TOKEN };
    const page = await (await fetch(`${hub.base}/`, { headers: cookie })).text();
    assert.match(page, /src="\/hub\/board\.js"/);
    const plain = await (await fetch(`${hub.base}/`, { headers: { "x-zevet-token": TOKEN } })).text();
    assert.match(plain, /src="\/board\.js"/);
    assert.doesNotMatch(plain, /__zevetBase/);
    const r = await fetch(`${hub.base}/?token=${TOKEN}`, { redirect: "manual" });
    assert.equal(r.headers.get("location"), "/");
    assert.match(r.headers.get("set-cookie"), /Path=\/;/);
  });
});
