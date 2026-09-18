// Granting Codex's hook trust, without a terminal.
//
// Codex will not run a hook until its trust is recorded, and it does not say so
// -- `codex exec` completes the turn normally and silently skips every hook.
// That is indistinguishable from zevet being broken, and it is where this
// integration died for its whole life.
//
// The trust record is `hooks.state.'<key>'.trusted_hash = "<hash>"` in
// $CODEX_HOME/config.toml. The key and the hash are NOT guessed -- guessing a
// hash is exactly the kind of invention CLAUDE.md §4 bans. They are read from
// Codex itself over its app-server JSON-RPC protocol:
//
//     codex app-server        (stdio, newline-delimited JSON-RPC 2.0)
//       -> initialize
//       -> hooks/list { cwds: [repo] }
//       <- { data: [ { cwd, hooks: [ { key, currentHash, trustStatus, command, ... } ] } ] }
//
// Verified 2026-09-18 on codex-cli 0.155.0-alpha.2.6: writing the returned hash
// flips trustStatus from "untrusted" to "trusted", and hooks then fire under a
// plain `codex exec` with no --dangerously-bypass-hook-trust anywhere.
//
// WHAT THIS DELIBERATELY WILL NOT DO: trust anything that is not ours. Hook
// trust exists so that a config file you did not write cannot silently run
// commands. Only entries whose command carries zevet's own marker are recorded,
// so an unrelated hook someone else added stays untrusted and still gets its
// review. zevet grants trust to the hook zevet just wrote, in the same action,
// for a user who just ran the installer -- and to nothing else.
import { spawn } from "node:child_process";

/** How long to wait for the app-server. It is a large binary and starts slowly. */
const RPC_TIMEOUT_MS = Number(process.env.ZEVET_CODEX_RPC_TIMEOUT_MS || 30000);

/**
 * Ask Codex to describe the hooks it sees for `repo`.
 *
 * @returns {Promise<{ok: true, hooks: object[]} | {ok: false, detail: string}>}
 */
export function listCodexHooks(codexBin, repo) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, detail: `could not start \`codex app-server\` (${err.message})` });
      return;
    }

    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // The answer is already in hand; a kill that fails changes nothing.
      }
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({ ok: false, detail: `\`codex app-server\` did not answer in ${RPC_TIMEOUT_MS}ms` }),
      RPC_TIMEOUT_MS,
    );

    child.on("error", (err) => finish({ ok: false, detail: `could not run \`codex app-server\` (${err.message})` }));

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) finish({ ok: false, detail: `\`codex app-server\` exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}` });
    });

    let buf = "";
    let nextId = 0;
    const pending = new Map();
    const send = (method, params) => {
      const id = ++nextId;
      return new Promise((res) => {
        pending.set(id, res);
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (err) {
          finish({ ok: false, detail: `could not talk to \`codex app-server\` (${err.message})` });
        }
      });
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // The protocol is newline-delimited JSON; anything else is chatter
          // from the binary and is not ours to interpret.
          continue;
        }
        const waiting = msg.id !== undefined && pending.get(msg.id);
        if (waiting) {
          pending.delete(msg.id);
          waiting(msg);
        }
      }
    });

    (async () => {
      const init = await send("initialize", {
        clientInfo: { name: "zevet", title: "zevet", version: "0.1.1" },
      });
      if (settled) return;
      if (!init || init.error) {
        finish({ ok: false, detail: `codex app-server refused initialize: ${JSON.stringify(init && init.error)}` });
        return;
      }
      const res = await send("hooks/list", { cwds: [repo] });
      if (settled) return;
      if (!res || res.error || !res.result) {
        finish({ ok: false, detail: `hooks/list failed: ${JSON.stringify(res && res.error)}` });
        return;
      }
      const data = res.result.data || [];
      const hooks = [];
      for (const entry of data) for (const h of entry.hooks || []) hooks.push(h);
      finish({ ok: true, hooks });
    })();
  });
}

export const TRUST_START = "# zevet:trust:start — hook trust recorded by zevet, do not edit by hand";
export const TRUST_END = "# zevet:trust:end";

/** Take zevet's trust block out of a config's text. Mirrors stripBlock. */
export function stripTrustBlock(text) {
  const start = text.indexOf(TRUST_START);
  if (start === -1) return { text, had: false };
  const endIdx = text.indexOf(TRUST_END, start);
  if (endIdx === -1) return { text, had: false, malformed: true };
  const end = endIdx + TRUST_END.length;
  const before = text.slice(0, start).replace(/\n+$/, "\n");
  const after = text.slice(end).replace(/^\n+/, "");
  return { text: before + after, had: true };
}

/**
 * The TOML for a set of hook entries.
 *
 * A literal (single-quoted) key, because the key is a Windows path full of
 * backslashes and a basic string would need every one escaped. A key containing
 * a single quote cannot be written at all, and is refused rather than mangled.
 */
export function trustBlockFor(hooks) {
  const lines = [TRUST_START];
  for (const h of hooks) {
    if (String(h.key).includes("'")) {
      throw new Error(`refusing to write a hook key containing a single quote into TOML: ${h.key}`);
    }
    lines.push(`[hooks.state.'${h.key}']`, `trusted_hash = "${h.currentHash}"`);
  }
  lines.push(TRUST_END, "");
  return lines.join("\n");
}

/** Only hooks that are unmistakably ours. Everything else keeps its review. */
export function ourHooks(hooks, mark) {
  return hooks.filter(
    (h) =>
      h &&
      typeof h.command === "string" &&
      h.command.includes(mark) &&
      typeof h.key === "string" &&
      typeof h.currentHash === "string" &&
      h.currentHash,
  );
}
