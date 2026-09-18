// Codex hook trust — the part that can be tested without spawning Codex.
//
// The RPC itself (`codex app-server` -> initialize -> hooks/list) is verified by
// observation and written up in docs/contracts/codex-hooks.md: writing the
// returned hash flipped trustStatus from "untrusted" to "trusted", and a plain
// `codex exec` with no --dangerously-bypass-hook-trust then fired the hooks and
// put events on the live hub.
//
// What is tested here is everything downstream of that answer, against a
// CAPTURED real hooks/list response rather than an invented one: which entries
// get trusted, what TOML is written, and that the block round-trips out again.
// The selection rule is the part that matters -- trusting somebody else's hook
// would defeat the control this is working with.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ourHooks, trustBlockFor, stripTrustBlock, TRUST_START, TRUST_END } from "../client/codex-trust.mjs";

const MARK = "--zevet-hook";
const ZEVET_CMD =
  'cmd /c "C:\\Program Files\\nodejs\\node.exe" "C:\\dev\\GitHub\\zevet\\client\\hook.mjs" --zevet-hook --zevet-agent codex';

/**
 * A real hooks/list response, captured from codex-cli 0.155.0-alpha.2.6 on
 * 2026-09-18, trimmed to the fields under test. Not hand-invented: the key
 * spelling (`<config path>:<event>:<n>:<n>`) and the `sha256:` prefix are the
 * two things most likely to be got wrong from memory, so they come from the
 * wire.
 */
const CAPTURED = [
  {
    key: "C:\\Users\\andre\\.codex\\config.toml:pre_tool_use:0:0",
    eventName: "preToolUse",
    command: ZEVET_CMD,
    currentHash: "sha256:b1808df8e2c10be28726bd60a72c96747a9a4ec5d18fc1c8fdf8a21a1c32f74c",
    trustStatus: "untrusted",
  },
  {
    key: "C:\\Users\\andre\\.codex\\config.toml:user_prompt_submit:0:0",
    eventName: "userPromptSubmit",
    command: ZEVET_CMD,
    currentHash: "sha256:46c515ed8dc63eca72e1b709c10166be1a0fe80a46aeaa99e49fbd820a2dedf1",
    trustStatus: "untrusted",
  },
  {
    key: "C:\\Users\\andre\\.codex\\config.toml:stop:0:0",
    eventName: "stop",
    command: ZEVET_CMD,
    currentHash: "sha256:a005ca7689da3aead4d1f0c6a0a2a6e6c4e0a2f0b4a1c9d8e7f6a5b4c3d2e1f0",
    trustStatus: "untrusted",
  },
];

/** Somebody else's hook, sitting in the same config. */
const FOREIGN = {
  key: "C:\\Users\\andre\\.codex\\config.toml:stop:1:0",
  eventName: "stop",
  command: "node C:/somewhere/their-telemetry.js --report",
  currentHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  trustStatus: "untrusted",
};

describe("which hooks zevet is willing to trust", () => {
  test("ours, and only ours", () => {
    const picked = ourHooks([...CAPTURED, FOREIGN], MARK);
    assert.equal(picked.length, 3, "expected exactly the three zevet hooks");
    assert.ok(
      !picked.some((h) => h.key === FOREIGN.key),
      "a hook zevet did not write was selected for trust — that defeats the control",
    );
  });

  test("an entry missing a hash is not trusted on a guess", () => {
    // A hash is the whole security value of the record. If Codex did not give
    // one, the answer is to write nothing, never to compute something plausible.
    const broken = [
      { ...CAPTURED[0], currentHash: "" },
      { ...CAPTURED[1], currentHash: undefined },
      { ...CAPTURED[2] },
    ];
    const picked = ourHooks(broken, MARK);
    assert.deepEqual(
      picked.map((h) => h.eventName),
      ["stop"],
      "an entry with no usable hash was selected",
    );
  });

  test("a malformed entry cannot crash the selection", () => {
    assert.deepEqual(ourHooks([null, undefined, {}, { command: 42 }, ...CAPTURED], MARK).length, 3);
  });
});

describe("the TOML that gets written", () => {
  test("one table per hook, with the hash Codex gave", () => {
    const block = trustBlockFor(ourHooks(CAPTURED, MARK));
    assert.ok(block.startsWith(TRUST_START), "the block is not marked as ours");
    assert.ok(block.includes(TRUST_END), "the block has no end marker");
    for (const h of CAPTURED) {
      // A LITERAL key: the key is a Windows path full of backslashes, and a
      // basic TOML string would need every one of them escaped.
      assert.ok(block.includes(`[hooks.state.'${h.key}']`), `no table for ${h.eventName}`);
      assert.ok(block.includes(`trusted_hash = "${h.currentHash}"`), `no hash for ${h.eventName}`);
    }
    // Backslashes go in verbatim; a doubled one means someone escaped a literal.
    assert.ok(!block.includes("\\\\"), `escaped backslashes in a literal key:\n${block}`);
  });

  test("a key containing a single quote is refused, not mangled", () => {
    // A literal TOML string cannot contain a single quote at all. Writing one
    // anyway would produce a config that does not parse.
    assert.throws(
      () => trustBlockFor([{ ...CAPTURED[0], key: "C:\\Users\\o'brien\\.codex\\config.toml:stop:0:0" }]),
      /single quote/,
      "a key with a quote was written instead of refused",
    );
  });
});

describe("the block comes back out again", () => {
  test("stripping restores the original text", () => {
    const before = 'model = "gpt-6-astra"\n\n[projects.' + "'" + "/x" + "'" + "]\ntrust_level = \"trusted\"\n";
    const withBlock = `${before}\n${trustBlockFor(ourHooks(CAPTURED, MARK))}`;
    const { text, had } = stripTrustBlock(withBlock);
    assert.equal(had, true, "the block was not found");
    assert.ok(!text.includes("hooks.state"), "trust records survived the strip");
    assert.ok(text.includes('model = "gpt-6-astra"'), "their settings were lost");
    assert.ok(text.includes("trust_level"), "their project trust was lost");
  });

  test("a block with no end marker is left alone rather than eaten", () => {
    const text = `model = "x"\n${TRUST_START}\n[hooks.state.'a']\n`;
    const r = stripTrustBlock(text);
    assert.equal(r.malformed, true, "a truncated block should be reported, not guessed at");
    assert.equal(r.text, text, "a truncated block was edited anyway");
  });

  test("nothing of ours present is not an error", () => {
    const text = 'model = "x"\n';
    const r = stripTrustBlock(text);
    assert.equal(r.had, false);
    assert.equal(r.text, text);
  });
});
