// Every child a script under scripts/ starts must be windowless on Windows.
// A script run by an agent (no console of its own) otherwise gives each child a
// new VISIBLE console: codemagic.mjs's powershell call was caught doing exactly
// that on Andrew's machine (2026-09-28). This is a text check on each call's
// options object, so a new call site without windowsHide goes red here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "scripts");
const CALL = /\b(execFileSync|execSync|spawnSync|execFile|spawn)\(/g;

function callText(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

export function unhiddenCalls(src) {
  const out = [];
  for (const m of src.matchAll(CALL)) {
    const before = src.slice(Math.max(0, m.index - 30), m.index);
    if (/import\s*\{[^}]*$/.test(before) || /function\s*$/.test(before)) continue;
    const text = callText(src, m.index + m[1].length);
    if (!/windowsHide\s*:\s*true/.test(text)) out.push(`${m[1]}${text.slice(0, 60)}`);
  }
  return out;
}

test("every child process a script starts is windowless", () => {
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    for (const c of unhiddenCalls(fs.readFileSync(path.join(dir, f), "utf8"))) bad.push(`${f}: ${c}`);
  }
  assert.deepEqual(bad, []);
});

test("the check itself catches a call without windowsHide", () => {
  assert.equal(unhiddenCalls('execFileSync("git", ["log"], { encoding: "utf8" });').length, 1);
  assert.equal(unhiddenCalls('execFileSync("git", ["log"], { encoding: "utf8", windowsHide: true });').length, 0);
});
