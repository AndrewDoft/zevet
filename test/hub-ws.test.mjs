// The hand-rolled WebSocket transport, at both ends of the telescope.
//
// TWO KINDS OF TEST LIVE HERE, on purpose.
//
// The first kind drives the exported codec directly with buffers built byte by
// byte in this file. Framing is where hand-rolled WebSockets go wrong, and they
// go wrong in a way a happy-path socket test cannot see: on localhost a whole
// message almost always arrives in one `data` event, so a decoder that assumes
// "one chunk, one frame" passes every end-to-end test anybody writes and then
// corrupts documents the moment there is a real network in the way. So the
// splits are made deliberately, at every byte boundary, rather than hoped for.
//
// The second kind runs a real hub on a real port and talks to it with Node's
// own WebSocket client — a client this code did not write, which is the point:
// if the handshake or the framing is subtly wrong, an independent implementation
// says so. That client is used ONLY here. hub/server.mjs implements RFC 6455
// itself and imports nothing to do it.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { startHub, TOKEN } from "./helpers.mjs";

// Importing the hub would normally seize a port; ZEVET_NO_LISTEN says load the
// module and do not listen. ZEVET_TOKEN because the hub refuses to exist
// without one, which is a property worth keeping.
process.env.ZEVET_TOKEN = TOKEN;
process.env.ZEVET_NO_LISTEN = "1";
const { decodeFrames, encodeFrame, createAssembler, MAX_MESSAGE_BYTES, MAX_ROOM_NAME } = await import(
  "../hub/server.mjs"
);
// And unset it immediately. startHub spawns the real hub with a copy of this
// process's environment, so leaving it set means every hub this file starts
// declines to listen and exits 0 — which surfaces as "hub exited 0" from the
// helper and looks nothing like the one-line cause.
delete process.env.ZEVET_NO_LISTEN;

// ---- building frames by hand -----------------------------------------------

/** A client frame, masked the way a client must mask, with every length form. */
function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, masked = true, key = Buffer.from([0x37, 0xfa, 0x21, 0x3d]) } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = body.length;
  const header = [];
  header.push((fin ? 0x80 : 0) | (opcode & 0x0f));
  const maskBit = masked ? 0x80 : 0;
  let ext = Buffer.alloc(0);
  if (len < 126) {
    header.push(maskBit | len);
  } else if (len < 65536) {
    header.push(maskBit | 126);
    ext = Buffer.alloc(2);
    ext.writeUInt16BE(len, 0);
  } else {
    header.push(maskBit | 127);
    ext = Buffer.alloc(8);
    ext.writeBigUInt64BE(BigInt(len), 0);
  }
  const masking = masked ? key : Buffer.alloc(0);
  const scrambled = Buffer.from(body);
  if (masked) for (let i = 0; i < scrambled.length; i++) scrambled[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(header), ext, masking, scrambled]);
}

/** A header that CLAIMS a payload of `len` bytes and sends none of it. */
function lyingHeader(len) {
  const header = Buffer.alloc(10);
  header[0] = 0x82; // fin, binary
  header[1] = 0x80 | 127; // masked, 64-bit length
  header.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([header, Buffer.from([1, 2, 3, 4])]);
}

/**
 * Read server-to-client frames. Deliberately NOT decodeFrames: that one is the
 * server's reader and rejects unmasked frames, which is exactly what a server
 * must send. This also asserts the mask bit is clear, so a server that started
 * masking would fail here rather than quietly break every browser.
 */
function readServerFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    assert.equal(b1 & 0x80, 0, "a server frame must never be masked");
    let len = b1 & 0x7f;
    let cur = off + 2;
    if (len === 126) {
      if (buf.length - cur < 2) break;
      len = buf.readUInt16BE(cur);
      cur += 2;
    } else if (len === 127) {
      if (buf.length - cur < 8) break;
      len = Number(buf.readBigUInt64BE(cur));
      cur += 8;
    }
    if (buf.length - cur < len) break;
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload: buf.subarray(cur, cur + len) });
    off = cur + len;
  }
  return { frames, rest: buf.subarray(off) };
}

describe("frame decoding", () => {
  test("round-trips one masked text frame", () => {
    const { frames, rest, error } = decodeFrames(clientFrame(0x1, "hello"));
    assert.equal(error, null);
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].opcode, 0x1);
    assert.equal(frames[0].fin, true);
    assert.equal(frames[0].payload.toString("utf8"), "hello");
  });

  test("two frames in one chunk are both returned, in order", () => {
    const chunk = Buffer.concat([clientFrame(0x1, "first"), clientFrame(0x2, Buffer.from([9, 9]))]);
    const { frames, rest, error } = decodeFrames(chunk);
    assert.equal(error, null);
    assert.equal(rest.length, 0);
    assert.deepEqual(
      frames.map((f) => f.opcode),
      [0x1, 0x2],
    );
    assert.equal(frames[0].payload.toString("utf8"), "first");
    assert.deepEqual([...frames[1].payload], [9, 9]);
  });

  test("a frame split across two chunks is completed, not lost", () => {
    const whole = clientFrame(0x1, "split me in half");
    const head = whole.subarray(0, 7);
    const tail = whole.subarray(7);

    const first = decodeFrames(head);
    assert.equal(first.error, null);
    assert.equal(first.frames.length, 0, "half a frame is not a frame");
    assert.equal(first.rest.length, head.length, "and every byte of it is kept");

    const second = decodeFrames(Buffer.concat([first.rest, tail]));
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames[0].payload.toString("utf8"), "split me in half");
    assert.equal(second.rest.length, 0);
  });

  test("survives a split at EVERY byte boundary", () => {
    // The strong version of the test above. A decoder can be wrong at exactly
    // one offset — inside the 16-bit length, between the mask key bytes — and
    // look perfect everywhere else.
    const whole = Buffer.concat([clientFrame(0x2, Buffer.alloc(300, 7)), clientFrame(0x1, "tail")]);
    for (let cut = 0; cut <= whole.length; cut++) {
      const a = decodeFrames(whole.subarray(0, cut));
      assert.equal(a.error, null, `cut ${cut}`);
      const b = decodeFrames(Buffer.concat([a.rest, whole.subarray(cut)]));
      assert.equal(b.error, null, `cut ${cut}`);
      const all = [...a.frames, ...b.frames];
      assert.equal(all.length, 2, `cut ${cut} lost a frame`);
      assert.equal(all[0].payload.length, 300, `cut ${cut}`);
      assert.equal(all[1].payload.toString("utf8"), "tail", `cut ${cut}`);
      assert.equal(b.rest.length, 0, `cut ${cut} left bytes behind`);
    }
  });

  test("fed one byte at a time, nothing is lost or duplicated", () => {
    const whole = Buffer.concat([clientFrame(0x1, "abc"), clientFrame(0x2, Buffer.alloc(70_000, 3))]);
    let pending = Buffer.alloc(0);
    const got = [];
    for (const byte of whole) {
      pending = Buffer.concat([pending, Buffer.from([byte])]);
      const out = decodeFrames(pending);
      assert.equal(out.error, null);
      pending = out.rest;
      got.push(...out.frames);
    }
    assert.equal(pending.length, 0);
    assert.equal(got.length, 2);
    assert.equal(got[0].payload.toString("utf8"), "abc");
    assert.equal(got[1].payload.length, 70_000);
    assert.ok(
      got[1].payload.every((b) => b === 3),
      "unmasking must not depend on how the bytes arrived",
    );
  });

  test("all three payload length encodings", () => {
    for (const size of [0, 125, 126, 65535, 65536, 70_000]) {
      const body = randomBytes(size);
      const frame = clientFrame(0x2, body);
      // The wire form is the one the spec names for that size, not whichever
      // one happens to work: a 7-bit length of 126 means "read two more bytes".
      const marker = frame[1] & 0x7f;
      if (size < 126) assert.equal(marker, size, `size ${size} takes the 7-bit form`);
      else if (size < 65536) assert.equal(marker, 126, `size ${size} takes the 16-bit form`);
      else assert.equal(marker, 127, `size ${size} takes the 64-bit form`);

      const { frames, rest, error } = decodeFrames(frame);
      assert.equal(error, null, `size ${size}`);
      assert.equal(rest.length, 0, `size ${size}`);
      assert.equal(frames.length, 1, `size ${size}`);
      assert.ok(frames[0].payload.equals(body), `size ${size} round-tripped`);
    }
  });

  test("an unmasked client frame is a protocol error", () => {
    const { error } = decodeFrames(clientFrame(0x1, "unmasked", { masked: false }));
    assert.ok(error, "must not be accepted");
    assert.equal(error.code, 1002);
  });

  test("an unmasked frame is rejected even when it is truncated", () => {
    // The mask bit is known from the second byte, so waiting for the rest of a
    // frame that can never be legal would be a way to hold memory for free.
    const whole = clientFrame(0x2, Buffer.alloc(200), { masked: false });
    const { error } = decodeFrames(whole.subarray(0, 3));
    assert.equal(error?.code, 1002);
  });

  test("a declared length over the cap is refused from the header alone", () => {
    const { error } = decodeFrames(lyingHeader(MAX_MESSAGE_BYTES + 1));
    assert.equal(error?.code, 1009, "a 64-bit length must not be believed first and checked later");
  });

  test("a length just inside the cap is not refused", () => {
    const out = decodeFrames(lyingHeader(MAX_MESSAGE_BYTES));
    assert.equal(out.error, null);
    assert.equal(out.frames.length, 0, "still waiting for the payload");
  });

  test("reserved bits and unknown opcodes are refused", () => {
    const rsv = clientFrame(0x1, "x");
    rsv[0] |= 0x40;
    assert.equal(decodeFrames(rsv).error?.code, 1002, "RSV1 without a negotiated extension");
    assert.equal(decodeFrames(clientFrame(0x3, "x")).error?.code, 1002, "reserved data opcode");
    assert.equal(decodeFrames(clientFrame(0xb, "x")).error?.code, 1002, "reserved control opcode");
  });

  test("a control frame may not be long or fragmented", () => {
    assert.equal(decodeFrames(clientFrame(0x9, Buffer.alloc(126))).error?.code, 1002, "126-byte ping");
    assert.equal(decodeFrames(clientFrame(0x9, "x", { fin: false })).error?.code, 1002, "fragmented ping");
  });
});

describe("frame encoding", () => {
  test("never masks, always finishes, and uses the right length form", () => {
    for (const size of [0, 125, 126, 65535, 65536, 200_000]) {
      const frame = encodeFrame(0x2, Buffer.alloc(size, 1));
      assert.equal(frame[0], 0x82, `size ${size}: FIN set, binary opcode`);
      assert.equal(frame[1] & 0x80, 0, `size ${size}: the server must not mask`);
      const marker = frame[1] & 0x7f;
      if (size < 126) assert.equal(marker, size);
      else if (size < 65536) assert.equal(marker, 126);
      else assert.equal(marker, 127);
      const { frames, rest } = readServerFrames(frame);
      assert.equal(rest.length, 0, `size ${size}`);
      assert.equal(frames[0].payload.length, size, `size ${size}`);
    }
  });

  test("takes a string as well as a buffer", () => {
    const { frames } = readServerFrames(encodeFrame(0x1, "héllo"));
    assert.equal(frames[0].payload.toString("utf8"), "héllo");
    assert.equal(frames[0].opcode, 0x1);
  });
});

describe("message assembly", () => {
  test("joins a fragmented message in order", () => {
    const push = createAssembler();
    assert.equal(push({ opcode: 0x1, fin: false, payload: Buffer.from("one ") }).kind, "partial");
    assert.equal(push({ opcode: 0x0, fin: false, payload: Buffer.from("two ") }).kind, "partial");
    const done = push({ opcode: 0x0, fin: true, payload: Buffer.from("three") });
    assert.equal(done.kind, "message");
    assert.equal(done.opcode, 0x1, "the message keeps the opcode of its FIRST frame");
    assert.equal(done.payload.toString("utf8"), "one two three");
  });

  test("a ping between two fragments does not corrupt the message", () => {
    // §5.4 allows this and real clients do it — a keepalive fires while a large
    // update is still going out. An assembler that folded the ping's payload
    // into the message would corrupt a document and blame the network.
    const push = createAssembler();
    push({ opcode: 0x2, fin: false, payload: Buffer.from([1, 2]) });
    const ping = push({ opcode: 0x9, fin: true, payload: Buffer.from("beat") });
    assert.equal(ping.kind, "control");
    assert.equal(ping.opcode, 0x9);
    assert.equal(ping.payload.toString("utf8"), "beat");
    const done = push({ opcode: 0x0, fin: true, payload: Buffer.from([3, 4]) });
    assert.equal(done.kind, "message");
    assert.deepEqual([...done.payload], [1, 2, 3, 4], "the ping must leave no trace in the message");
  });

  test("fragments that add up past the cap are refused", () => {
    const push = createAssembler(10);
    assert.equal(push({ opcode: 0x2, fin: false, payload: Buffer.alloc(6) }).kind, "partial");
    const out = push({ opcode: 0x0, fin: true, payload: Buffer.alloc(6) });
    assert.equal(out.kind, "error");
    assert.equal(out.code, 1009, "the cap is on the MESSAGE, not on each frame");
  });

  test("a continuation with nothing to continue is a protocol error", () => {
    const push = createAssembler();
    assert.equal(push({ opcode: 0x0, fin: true, payload: Buffer.alloc(0) }).code, 1002);
  });

  test("a new message starting mid-message is a protocol error", () => {
    const push = createAssembler();
    push({ opcode: 0x1, fin: false, payload: Buffer.from("half") });
    assert.equal(push({ opcode: 0x1, fin: true, payload: Buffer.from("other") }).code, 1002);
  });
});

// ---- end to end -------------------------------------------------------------

function wsUrl(base, token = TOKEN) {
  return `${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
}

/** Node's own WebSocket client, wrapped so a test can await what it received. */
function connect(base, token = TOKEN) {
  const ws = new WebSocket(wsUrl(base, token));
  ws.binaryType = "arraybuffer";
  const got = [];
  const closed = { code: null, seen: false };
  ws.addEventListener("message", (ev) => {
    got.push(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data));
  });
  ws.addEventListener("close", (ev) => {
    closed.seen = true;
    closed.code = ev.code;
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("close", () => reject(new Error("closed before it opened")));
    // ⚠️ AND ON `error`, WHICH IS NOT THE SAME EVENT AND DOES NOT ALWAYS BRING
    // `close` WITH IT. A refused upgrade fires error-then-close on Node 24 and
    // error ALONE on Node 22 — so without this line the promise below never
    // settles, `assert.rejects` waits forever, and the whole suite hangs. It
    // did: twelve minutes on both CI runners, green in six seconds locally,
    // because the two were on different Node versions. The product had the
    // same assumption in desktop/doc-sync.js and the same bug.
    ws.addEventListener("error", () => reject(new Error("the connection failed")));
  });
  return {
    ws,
    got,
    closed,
    open,
    join: (room) => ws.send(JSON.stringify({ type: "join", room })),
    snapshot: () => ws.send(JSON.stringify({ type: "snapshot" })),
    send: (bytes) => ws.send(new Uint8Array(bytes)),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Poll, never sleep-and-hope: a fixed sleep is how a suite becomes flaky.
 *
 * The predicate is awaited, which matters more than it looks: an async
 * predicate returns a Promise, every Promise is truthy, and a version of this
 * that forgot the await would report success instantly and assert nothing.
 */
async function until(predicate, why, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A short grace period, used only to assert something did NOT arrive. */
const settle = () => new Promise((r) => setTimeout(r, 150));

/** The handshake, by hand, so a test can send bytes no library would send. */
function rawUpgrade(port, { path = "/ws", token = TOKEN, version = "13", upgrade = "websocket" } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("connect", () => {
      const lines = [
        `GET ${path}${token === null ? "" : `?token=${encodeURIComponent(token)}`} HTTP/1.1`,
        `host: 127.0.0.1:${port}`,
        `connection: Upgrade`,
        `sec-websocket-key: ${randomBytes(16).toString("base64")}`,
      ];
      if (upgrade !== null) lines.push(`upgrade: ${upgrade}`);
      if (version !== null) lines.push(`sec-websocket-version: ${version}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      resolve({ socket, head: buf.subarray(0, end).toString("latin1"), rest: buf.subarray(end + 4) });
    });
    socket.on("close", () => reject(new Error("the hub closed without answering")));
  });
}

/** Collect server frames off a raw socket until `want` of them have arrived. */
function collect(socket, rest = Buffer.alloc(0)) {
  let pending = Buffer.from(rest);
  const frames = [];
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const out = readServerFrames(pending);
    pending = out.rest;
    frames.push(...out.frames);
  });
  return frames;
}

let hub;
before(async () => {
  hub = await startHub();
});
after(async () => {
  await hub?.stop();
});

describe("the upgrade handshake", () => {
  test("a good token upgrades", async () => {
    const { socket, head } = await rawUpgrade(hub.port);
    assert.match(head, /^HTTP\/1\.1 101 /);
    assert.match(head, /sec-websocket-accept: /i);
    socket.destroy();
  });

  test("the accept key is the sha1 of the key and the GUID", async () => {
    // The one constant in RFC 6455 that cannot be inferred from behaviour, and
    // the example in §1.3 is the only independent check of it available.
    const fresh = await startHub();
    try {
      const socket = net.connect(fresh.port, "127.0.0.1");
      const head = await new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        socket.on("error", reject);
        socket.on("connect", () => {
          socket.write(
            [
              `GET /ws?token=${TOKEN} HTTP/1.1`,
              `host: 127.0.0.1:${fresh.port}`,
              "upgrade: websocket",
              "connection: Upgrade",
              "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
              "sec-websocket-version: 13",
              "",
              "",
            ].join("\r\n"),
          );
        });
        socket.on("data", (c) => {
          buf = Buffer.concat([buf, c]);
          if (buf.includes("\r\n\r\n")) resolve(buf.toString("latin1"));
        });
      });
      assert.match(head, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
      socket.destroy();
    } finally {
      await fresh.stop();
    }
  });

  test("a bad token never reaches the handshake", async () => {
    const fresh = await startHub();
    try {
      const { socket, head } = await rawUpgrade(fresh.port, { token: "wrong-token-value-here" });
      assert.match(head, /^HTTP\/1\.1 401 /);
      assert.ok(!/101/.test(head), "nothing may be switched on a bad token");
      socket.destroy();
    } finally {
      await fresh.stop();
    }
  });

  test("a missing token is refused too", async () => {
    const fresh = await startHub();
    try {
      const { socket, head } = await rawUpgrade(fresh.port, { token: null });
      assert.match(head, /^HTTP\/1\.1 401 /);
      socket.destroy();
    } finally {
      await fresh.stop();
    }
  });

  test("the client sees the refusal as a failure to open", async () => {
    const fresh = await startHub();
    try {
      const bad = connect(fresh.base, "wrong-token-value-here");
      await assert.rejects(bad.open, "a refused upgrade must not look like a connection");
    } finally {
      await fresh.stop();
    }
  });

  test("failed upgrades are rate limited by the same counter as the HTTP routes", async () => {
    const fresh = await startHub();
    try {
      let sawLimit = false;
      for (let i = 0; i < 25; i++) {
        const { socket, head } = await rawUpgrade(fresh.port, { token: "wrong-token-value-here" });
        if (/^HTTP\/1\.1 429 /.test(head)) sawLimit = true;
        socket.destroy();
      }
      assert.ok(sawLimit, "the upgrade path must not be a way around the limit");

      // And the same property the HTTP suite protects: a valid token still works.
      const good = connect(fresh.base);
      await good.open;
      good.close();
    } finally {
      await fresh.stop();
    }
  });

  test("only /ws upgrades", async () => {
    const { socket, head } = await rawUpgrade(hub.port, { path: "/events" });
    assert.match(head, /^HTTP\/1\.1 400 /);
    socket.destroy();
  });

  test("a version 13 handshake is required", async () => {
    const a = await rawUpgrade(hub.port, { version: "8" });
    assert.match(a.head, /^HTTP\/1\.1 400 /);
    a.socket.destroy();
    const b = await rawUpgrade(hub.port, { version: null });
    assert.match(b.head, /^HTTP\/1\.1 400 /);
    b.socket.destroy();
  });

  test("a refused upgrade does not take the hub with it", async () => {
    const res = await fetch(`${hub.base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

describe("rooms", () => {
  test("two clients in a room relay to each other, and to nobody else", async () => {
    const fresh = await startHub();
    try {
      const a = connect(fresh.base);
      const b = connect(fresh.base);
      const outsider = connect(fresh.base);
      await Promise.all([a.open, b.open, outsider.open]);
      a.join("doc-1");
      b.join("doc-1");
      outsider.join("doc-2");

      a.send([1, 2, 3]);
      await until(() => b.got.length === 1, "b to receive a's update");
      await settle();

      assert.deepEqual([...b.got[0]], [1, 2, 3]);
      assert.equal(a.got.length, 0, "a sender must never be echoed its own update");
      assert.equal(outsider.got.length, 0, "another room must not see it");

      b.send([4]);
      await until(() => a.got.length === 1, "a to receive b's update");
      assert.deepEqual([...a.got[0]], [4], "the relay is bidirectional");

      a.close();
      b.close();
      outsider.close();
    } finally {
      await fresh.stop();
    }
  });

  test("a late joiner gets the whole log, in order, before live traffic", async () => {
    const fresh = await startHub();
    try {
      const a = connect(fresh.base);
      const b = connect(fresh.base);
      await Promise.all([a.open, b.open]);
      a.join("replay");
      b.join("replay");

      for (const n of [10, 20, 30]) a.send([n]);
      // b receiving all three is the proof the hub has logged all three; there
      // is nothing to poll on the hub itself and a sleep here would be a guess.
      await until(() => b.got.length === 3, "b to receive the three updates");

      const late = connect(fresh.base);
      await late.open;
      late.join("replay");
      await until(() => late.got.length === 3, "the late joiner's replay");
      await settle();
      assert.deepEqual(
        late.got.map((m) => m[0]),
        [10, 20, 30],
        "replayed in the order they were sent",
      );

      a.send([40]);
      await until(() => late.got.length === 4, "live traffic after the replay");
      assert.deepEqual(
        late.got.map((m) => m[0]),
        [10, 20, 30, 40],
        "live traffic must land after the replay, never inside it",
      );

      a.close();
      b.close();
      late.close();
    } finally {
      await fresh.stop();
    }
  });

  test("a snapshot replaces the log outright", async () => {
    const fresh = await startHub();
    try {
      const a = connect(fresh.base);
      const b = connect(fresh.base);
      await Promise.all([a.open, b.open]);
      a.join("compact");
      b.join("compact");

      for (const n of [1, 2, 3]) a.send([n]);
      await until(() => b.got.length === 3, "the three updates");

      a.snapshot();
      a.send([99, 99]);
      await until(() => b.got.length === 4, "the snapshot to be relayed like any other blob");

      const late = connect(fresh.base);
      await late.open;
      late.join("compact");
      await until(() => late.got.length === 1, "the compacted replay");
      await settle();
      assert.equal(late.got.length, 1, "the log is the snapshot and nothing else");
      assert.deepEqual([...late.got[0]], [99, 99]);

      a.close();
      b.close();
      late.close();
    } finally {
      await fresh.stop();
    }
  });

  test("a room outlives its last member, and an empty one does not", async () => {
    const fresh = await startHub();
    try {
      const keeper = connect(fresh.base);
      const passer = connect(fresh.base);
      await Promise.all([keeper.open, passer.open]);
      keeper.join("kept");
      passer.join("passed-through");
      keeper.send([1]);
      // Another member of "kept" is the only sync point available: once it has
      // the update, the hub has logged it.
      const witness = connect(fresh.base);
      await witness.open;
      witness.join("kept");
      await until(() => witness.got.length === 1, "the log to exist");

      keeper.close();
      witness.close();
      passer.close();
      await until(
        async () => (await (await fetch(`${fresh.base}/healthz`)).json()).wsListeners === 0,
        "the hub to notice the sockets are gone",
      );
      const health = await (await fetch(`${fresh.base}/healthz`)).json();
      assert.equal(health.rooms, 1, "the room with a log is kept; the empty one is forgotten");
    } finally {
      await fresh.stop();
    }
  });

  test("binary before a join is refused", async () => {
    const fresh = await startHub();
    try {
      const a = connect(fresh.base);
      await a.open;
      a.send([1, 2, 3]);
      await until(() => a.closed.seen, "the hub to close the connection");
      assert.equal(a.closed.code, 1008);
    } finally {
      await fresh.stop();
    }
  });

  test("a join needs a room name, and a short one", async () => {
    const fresh = await startHub();
    try {
      for (const room of [undefined, "", 42, "x".repeat(MAX_ROOM_NAME + 1)]) {
        const c = connect(fresh.base);
        await c.open;
        c.ws.send(JSON.stringify({ type: "join", room }));
        await until(() => c.closed.seen, `the hub to refuse room ${JSON.stringify(room)}`);
        assert.equal(c.closed.code, 1008, `room ${JSON.stringify(room)}`);
      }

      // And the boundary itself is allowed: the cap is a limit, not an
      // opinion about what a room may be called.
      const ok = connect(fresh.base);
      await ok.open;
      ok.join("x".repeat(MAX_ROOM_NAME));
      await settle();
      assert.equal(ok.closed.seen, false, "exactly 256 characters is fine");
      ok.close();
    } finally {
      await fresh.stop();
    }
  });

  test("a room name the hub cannot interpret is still just a name", async () => {
    // Opaque means opaque: no normalising, no namespacing, no rejecting on
    // grounds of taste. Two names that differ by a byte are two rooms.
    const fresh = await startHub();
    try {
      const a = connect(fresh.base);
      const b = connect(fresh.base);
      const other = connect(fresh.base);
      await Promise.all([a.open, b.open, other.open]);
      a.join("../../etc/passwd 🔥");
      b.join("../../etc/passwd 🔥");
      other.join("../../etc/passwd 🔥 ");
      a.send([7]);
      await until(() => b.got.length === 1, "the relay");
      await settle();
      assert.equal(other.got.length, 0, "a trailing space is a different room");
      a.close();
      b.close();
      other.close();
    } finally {
      await fresh.stop();
    }
  });

  test("the log drops its oldest entries when a room passes its byte cap", async () => {
    const fresh = await startHub({ ZEVET_ROOM_LOG_MAX_BYTES: "100" });
    try {
      // The sender is a raw socket here, and the sync point is a PING.
      //
      // Every other test in this file uses "a peer received it" as the proof
      // that the hub has processed a blob. That proof is unavailable once the
      // log is lossy: a peer whose join happens to land after the sends gets
      // the already-trimmed log and is short by exactly the entries this test
      // is about, so the wait would hang on a hub that is working perfectly.
      // Frames on ONE socket are processed in order, so a pong is the hub
      // saying "and everything you sent before this, too".
      const { socket, rest } = await rawUpgrade(fresh.port);
      const frames = collect(socket, rest);
      socket.write(clientFrame(0x1, JSON.stringify({ type: "join", room: "bounded" })));
      for (const fill of [1, 2, 3]) socket.write(clientFrame(0x2, Buffer.alloc(40, fill)));
      socket.write(clientFrame(0x9, "flush"));
      await until(() => frames.some((f) => f.opcode === 0xa), "the pong that proves all three were seen");

      const late = connect(fresh.base);
      await late.open;
      late.join("bounded");
      await until(() => late.got.length === 2, "the trimmed replay");
      await settle();
      assert.equal(late.got.length, 2, "120 bytes do not fit in 100");
      assert.deepEqual(
        late.got.map((m) => m[0]),
        [2, 3],
        "the OLDEST entry is the one that goes",
      );

      socket.destroy();
      late.close();
    } finally {
      await fresh.stop();
    }
  });

  test("a single blob bigger than the cap is kept anyway", async () => {
    // Trimming it would leave the room with nothing, which is a worse answer
    // than being over an accounting limit.
    const fresh = await startHub({ ZEVET_ROOM_LOG_MAX_BYTES: "100" });
    try {
      const a = connect(fresh.base);
      const b = connect(fresh.base);
      await Promise.all([a.open, b.open]);
      a.join("huge");
      b.join("huge");
      a.send(new Uint8Array(400).fill(9));
      await until(() => b.got.length === 1, "the update");

      const late = connect(fresh.base);
      await late.open;
      late.join("huge");
      await until(() => late.got.length === 1, "the replay");
      assert.equal(late.got[0].length, 400);
      a.close();
      b.close();
      late.close();
    } finally {
      await fresh.stop();
    }
  });

  test("past the room cap, the least recently used empty room is evicted", async () => {
    const fresh = await startHub({ ZEVET_MAX_ROOMS: "2" });
    try {
      // A room with a log and nobody in it is kept — that is the case the cap
      // has to bound. Made one at a time, with a gap, because `used` has
      // millisecond resolution and two rooms born in the same millisecond have
      // no least-recently-used between them.
      for (const name of ["first", "second"]) {
        const c = connect(fresh.base);
        await c.open;
        c.join(name);
        c.send([1]);
        const witness = connect(fresh.base);
        await witness.open;
        witness.join(name);
        await until(() => witness.got.length === 1, `${name} to have a log`);
        c.close();
        witness.close();
        await new Promise((r) => setTimeout(r, 20));
      }
      await until(
        async () => (await (await fetch(`${fresh.base}/healthz`)).json()).rooms === 2,
        "two remembered rooms",
      );

      const third = connect(fresh.base);
      await third.open;
      third.join("third");
      await until(
        async () => (await (await fetch(`${fresh.base}/healthz`)).json()).rooms === 2,
        "the cap to hold at two",
      );

      // "first" was the least recently used, so it is the one that went: coming
      // back to it now gets an empty room rather than its old log.
      const back = connect(fresh.base);
      await back.open;
      back.join("first");
      await settle();
      assert.equal(back.got.length, 0, "the evicted room's log is gone");

      third.close();
      back.close();
    } finally {
      await fresh.stop();
    }
  });

  test("a hub whose rooms are all occupied refuses a new one rather than evicting it", async () => {
    const fresh = await startHub({ ZEVET_MAX_ROOMS: "1" });
    try {
      const sitting = connect(fresh.base);
      await sitting.open;
      sitting.join("occupied");
      await until(
        async () => (await (await fetch(`${fresh.base}/healthz`)).json()).rooms === 1,
        "the first room",
      );

      const turned_away = connect(fresh.base);
      await turned_away.open;
      turned_away.join("no-space");
      await until(() => turned_away.closed.seen, "the refusal");
      assert.equal(turned_away.closed.code, 1013, "try again later, not a silent desync for the people sitting in the room");
      assert.equal(sitting.closed.seen, false, "and nobody was thrown out to make space");
      sitting.close();
    } finally {
      await fresh.stop();
    }
  });

  test("unknown JSON, and JSON that is not an object, are refused", async () => {
    const fresh = await startHub();
    try {
      for (const text of ["not json at all", "42", JSON.stringify({ type: "delete-everything" })]) {
        const c = connect(fresh.base);
        await c.open;
        c.ws.send(text);
        await until(() => c.closed.seen, `the hub to refuse ${text}`);
        assert.equal(c.closed.code, 1008, text);
      }
    } finally {
      await fresh.stop();
    }
  });
});

describe("the wire, adversarially", () => {
  test("an unmasked frame from a client closes the connection with 1002", async () => {
    const fresh = await startHub();
    try {
      const { socket, rest } = await rawUpgrade(fresh.port);
      const frames = collect(socket, rest);
      socket.write(clientFrame(0x1, JSON.stringify({ type: "join", room: "r" }), { masked: false }));
      await until(() => frames.some((f) => f.opcode === 0x8), "a close frame");
      const close = frames.find((f) => f.opcode === 0x8);
      assert.equal(close.payload.readUInt16BE(0), 1002);
      socket.destroy();

      const health = await (await fetch(`${fresh.base}/healthz`)).json();
      assert.equal(health.ok, true, "the hub survived it");
    } finally {
      await fresh.stop();
    }
  });

  test("a frame claiming more than the cap is refused before the bytes arrive", async () => {
    const fresh = await startHub();
    try {
      const { socket, rest } = await rawUpgrade(fresh.port);
      const frames = collect(socket, rest);
      socket.write(clientFrame(0x1, JSON.stringify({ type: "join", room: "big" })));
      socket.write(lyingHeader(MAX_MESSAGE_BYTES + 1));
      await until(() => frames.some((f) => f.opcode === 0x8), "a close frame");
      assert.equal(frames.find((f) => f.opcode === 0x8).payload.readUInt16BE(0), 1009);
      socket.destroy();

      const health = await (await fetch(`${fresh.base}/healthz`)).json();
      assert.equal(health.ok, true, "one greedy client must not take the hub down");
    } finally {
      await fresh.stop();
    }
  });

  test("a ping is answered with a pong carrying the same body", async () => {
    const { socket, rest } = await rawUpgrade(hub.port);
    const frames = collect(socket, rest);
    socket.write(clientFrame(0x9, "are you there"));
    await until(() => frames.some((f) => f.opcode === 0xa), "a pong");
    const pong = frames.find((f) => f.opcode === 0xa);
    assert.equal(pong.payload.toString("utf8"), "are you there");
    socket.destroy();
  });

  test("a close is echoed back", async () => {
    const { socket, rest } = await rawUpgrade(hub.port);
    const frames = collect(socket, rest);
    const body = Buffer.alloc(2);
    body.writeUInt16BE(1000, 0);
    socket.write(clientFrame(0x8, body));
    await until(() => frames.some((f) => f.opcode === 0x8), "the close echo");
    assert.equal(frames.find((f) => f.opcode === 0x8).payload.readUInt16BE(0), 1000);
    socket.destroy();
  });

  test("a fragmented join, with a ping in the middle of it, still joins", async () => {
    // The end-to-end version of the assembler test: fragments and a control
    // frame interleaved, over a real socket, into a real room.
    const fresh = await startHub();
    try {
      const listener = connect(fresh.base);
      await listener.open;
      listener.join("fragmented");
      await settle();

      const { socket, rest } = await rawUpgrade(fresh.port);
      const frames = collect(socket, rest);
      const json = JSON.stringify({ type: "join", room: "fragmented" });
      socket.write(clientFrame(0x1, json.slice(0, 5), { fin: false }));
      socket.write(clientFrame(0x9, "mid", { fin: true }));
      socket.write(clientFrame(0x0, json.slice(5), { fin: true }));
      await until(() => frames.some((f) => f.opcode === 0xa), "the pong");

      socket.write(clientFrame(0x2, Buffer.from([5, 5, 5])));
      await until(() => listener.got.length === 1, "the relayed update");
      assert.deepEqual([...listener.got[0]], [5, 5, 5], "the fragmented join was understood");
      assert.ok(!frames.some((f) => f.opcode === 0x8), "and nothing was closed");
      socket.destroy();
      listener.close();
    } finally {
      await fresh.stop();
    }
  });

  test("a message split across TCP writes arrives whole", async () => {
    const fresh = await startHub();
    try {
      const listener = connect(fresh.base);
      await listener.open;
      listener.join("dribble");
      await settle();

      const { socket, rest } = await rawUpgrade(fresh.port);
      collect(socket, rest);
      socket.write(clientFrame(0x1, JSON.stringify({ type: "join", room: "dribble" })));

      const payload = randomBytes(3000);
      const frame = clientFrame(0x2, payload);
      // Written in three pieces with a turn of the event loop between them, so
      // the hub genuinely has to buffer a partial frame rather than being handed
      // the whole thing by a kind kernel.
      for (const piece of [frame.subarray(0, 3), frame.subarray(3, 1000), frame.subarray(1000)]) {
        socket.write(piece);
        await new Promise((r) => setTimeout(r, 20));
      }
      await until(() => listener.got.length === 1, "the reassembled update");
      assert.ok(listener.got[0].equals(payload), "byte for byte");
      socket.destroy();
      listener.close();
    } finally {
      await fresh.stop();
    }
  });
});

describe("observability", () => {
  test("/healthz keeps its old shape and gains two counts", async () => {
    const fresh = await startHub();
    try {
      const before = await (await fetch(`${fresh.base}/healthz`)).json();
      // `teams` is additive too, same rule as the two ws counts: a hub with
      // no teams created yet still has the DEFAULT one.
      assert.deepEqual(before, { ok: true, events: 0, listeners: 0, rooms: 0, wsListeners: 0, teams: 1 });

      const a = connect(fresh.base);
      const b = connect(fresh.base);
      await Promise.all([a.open, b.open]);
      a.join("one");
      b.join("two");
      await until(
        async () => (await (await fetch(`${fresh.base}/healthz`)).json()).rooms === 2,
        "both rooms to appear",
      );
      const during = await (await fetch(`${fresh.base}/healthz`)).json();
      assert.equal(during.wsListeners, 2);
      assert.equal(during.rooms, 2);
      assert.equal(during.listeners, 0, "an SSE listener is not a ws listener");

      a.close();
      b.close();
      await until(
        async () => (await (await fetch(`${fresh.base}/healthz`)).json()).wsListeners === 0,
        "the sockets to be forgotten",
      );
    } finally {
      await fresh.stop();
    }
  });

  test("/healthz needs no token, as before", async () => {
    const res = await fetch(`${hub.base}/healthz`);
    assert.equal(res.status, 200);
    await res.json();
  });
});
