// zevet uninstall — takes the hooks back out, and the client with them.
//
//   node client/uninstall.mjs
//   node client/uninstall.mjs --all
//
// The default leaves ~/.zevet/config.json where it is: the hub URL, the shared
// token and the actor name are the parts that were fiddly to obtain, and
// somebody uninstalling the client today is usually reinstalling it tomorrow.
// `--all` is for the other case — leaving the team — and takes the whole of
// ~/.zevet with it, token included.
//
// THREE RULES, two of them borrowed from the doctor:
//
//   1. EXIT 0, always. Uninstall is run by someone who has already decided to
//      stop; handing them a red exit code and a half-removed install helps
//      nobody. Every repo is attempted whatever the one before it did, and what
//      could not be removed is printed with the command to finish it by hand.
//   2. NEVER DELETE SOMEBODY ELSE'S CONFIG. A repo's .claude/settings.json and
//      .codex/config.toml belong to the repo, not to us. Our hook entries come
//      out; everything else in those files is left byte-for-byte alone, and a
//      file with nothing of ours in it is not rewritten at all — not even
//      reformatted.
//   3. SAY WHAT IT DID, per repo and per agent. An uninstaller that prints
//      "done" has told you nothing about the repos it could not reach.
//
// WHAT IT CANNOT KNOW: ~/.zevet/workspaces.json lists the folders this machine
// has opened, which is where the hooks are — but a repo wired up by hand from a
// checkout and never opened in the app is not in that list. Those are named in
// the closing note rather than hunted for; searching the disk for settings
// files to edit is not a thing an uninstaller should do uninvited.
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { installCodex, codexConfigPathFor, stripBlock, BLOCK_START } from "./install-codex.mjs";

const HOME = process.env.ZEVET_HOME || path.join(os.homedir(), ".zevet");
const WORKSPACES = path.join(HOME, "workspaces.json");
const CLIENT_DIR = path.join(HOME, "client");
const CONFIG = path.join(HOME, "config.json");

/**
 * How we recognise our own hook entries.
 *
 * Deliberately a COPY of install.mjs's MARK and isOurs, not an import: that
 * file installs on import — it has no exports and its top level is the
 * installer — so importing it here would wire hooks up in the middle of taking
 * them down. The two must agree; if the flag ever changes, it changes in both.
 * The legacy path test is kept for the same reason install.mjs keeps it: hooks
 * written before the flag existed carry no mark, and an uninstall that cannot
 * see them leaves the board counting a client that is no longer there.
 */
const MARK = "--zevet-hook";

function isOurs(entry) {
  if (!entry || typeof entry.command !== "string") return false;
  const norm = entry.command.split("\\").join("/").replace(/\/{2,}/g, "/");
  return entry.command.includes(MARK) || /(^|\/)\.?zevet\/client\/hook\.mjs/.test(norm);
}

function backup(file) {
  copyFileSync(file, `${file}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

// ---- the repos -------------------------------------------------------------

/**
 * @returns {{list: string[], detail: string}} `list` is the folders to clean;
 * `detail` is the one line printed about where they came from.
 */
function readWorkspaces() {
  if (!existsSync(WORKSPACES)) {
    return { list: [], detail: `none — ${WORKSPACES} does not exist` };
  }
  let parsed;
  try {
    // A BOM here has cost this project a day before now; see hook.mjs.
    parsed = JSON.parse(readFileSync(WORKSPACES, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    return { list: [], detail: `${WORKSPACES} is not valid JSON (${err.message}) — no repo could be read from it` };
  }
  if (!Array.isArray(parsed)) {
    return { list: [], detail: `${WORKSPACES} does not contain a list of folders` };
  }
  const list = parsed.filter((d) => typeof d === "string" && d.trim()).map((d) => path.resolve(d));
  return { list, detail: `${list.length} listed in ${WORKSPACES}` };
}

/** @returns {{state: "removed"|"clean"|"absent"|"failed", detail: string}} */
function removeClaude(repo) {
  const file = path.join(repo, ".claude", "settings.json");
  if (!existsSync(file)) return { state: "absent", detail: "no .claude/settings.json" };

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "") || "{}");
  } catch (err) {
    return { state: "failed", detail: `${file} is not valid JSON (${err.message}) — left untouched` };
  }
  if (!cfg.hooks || typeof cfg.hooks !== "object") return { state: "clean", detail: `no hooks in ${file}` };

  let removed = 0;
  for (const evt of Object.keys(cfg.hooks)) {
    const groups = cfg.hooks[evt];
    // An event key holding something other than a list of groups is not a shape
    // we ever wrote, so it is theirs and it stays. Treating it as an empty list
    // — which is what the installer does — would delete it on the way past.
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !isOurs(h));
      removed += before - g.hooks.length;
    }
    // Drop the groups we emptied, and the event key if that emptied it. Leaving
    // `"Stop": [{ "hooks": [] }]` behind is not wrong, exactly, but it is our
    // litter in their file. Anything that is not one of our group shapes is
    // kept whatever it contains.
    cfg.hooks[evt] = groups.filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (cfg.hooks[evt].length === 0) delete cfg.hooks[evt];
  }

  // Rule 2: nothing of ours, nothing written. Rewriting here would reformat a
  // file we have no business reformatting, and produce a backup nobody asked
  // for, purely to report that there was nothing to do.
  if (removed === 0) return { state: "clean", detail: `no zevet hooks in ${file}` };

  try {
    backup(file);
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch (err) {
    return { state: "failed", detail: `could not write ${file} (${err.message})` };
  }
  return { state: "removed", detail: `removed ${removed} hook entr${removed === 1 ? "y" : "ies"} from ${file}` };
}

/**
 * Codex has TWO places to clean.
 *
 * The live one is the global `$CODEX_HOME/config.toml`, because a repo-local
 * hooks block never fires and nothing installs there any more. The other is
 * exactly that dead repo-local block, which earlier versions did write -- it
 * does nothing, but leaving our marker in somebody's repo after they asked us
 * to leave is still litter, and it would confuse the next person who reads it.
 *
 * @returns {{state: "removed"|"clean"|"absent"|"failed", detail: string}}
 */
function removeCodex(repo) {
  const notes = [];
  let failed = false;
  let removed = false;

  // 1. The legacy per-repo block, by text surgery -- installCodex no longer
  //    points at this file at all.
  const legacy = codexConfigPathFor(repo);
  if (existsSync(legacy)) {
    try {
      const text = readFileSync(legacy, "utf8");
      if (text.includes(BLOCK_START)) {
        const stripped = stripBlock(text);
        if (stripped.malformed) {
          failed = true;
          notes.push(`${legacy} has a zevet block with no end marker — left untouched`);
        } else {
          backup(legacy);
          writeFileSync(legacy, stripped.text, "utf8");
          removed = true;
          notes.push(`removed the (inert) legacy block from ${legacy}`);
        }
      }
    } catch (err) {
      failed = true;
      notes.push(`could not clean ${legacy} (${err.message})`);
    }
  }

  // 2. The global block, which is the one that actually runs.
  try {
    const r = installCodex(repo, { hookPath: "", node: "", mark: MARK, remove: true });
    if (!r.ok) {
      failed = true;
      notes.push(r.detail);
    } else {
      removed = true;
      notes.push(r.detail);
    }
  } catch (err) {
    failed = true;
    notes.push(err.message);
  }

  if (failed) return { state: "failed", detail: notes.join("; ") };
  if (!removed) return { state: "clean", detail: notes.join("; ") || "nothing of zevet's in the Codex config" };
  return { state: "removed", detail: notes.join("; ") };
}

// ---- main ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");

  console.log("zevet uninstall");
  console.log("");

  const { list, detail } = readWorkspaces();
  console.log(`  workspaces    ${detail}`);

  let cleaned = 0;
  let failures = 0;

  for (const repo of list) {
    console.log("");
    console.log(`  ${repo}`);
    if (!existsSync(repo)) {
      // Nothing to clean, and nothing wrong either: the folder was deleted or
      // is on a drive that is not mounted right now.
      console.log("    (folder is not here — nothing to remove)");
      continue;
    }
    let touched = false;
    let said = false;
    for (const [label, result] of [
      ["Claude Code", removeClaude(repo)],
      ["Codex", removeCodex(repo)],
    ]) {
      // "absent" is the ordinary case for the agent somebody does not use, and
      // a line about it on every repo would bury the lines that matter.
      if (result.state === "absent") continue;
      if (result.state === "failed") failures++;
      if (result.state === "removed") touched = true;
      said = true;
      console.log(`    ${label.padEnd(12)} ${result.state === "failed" ? "FAILED: " : ""}${result.detail}`);
    }
    if (!said) console.log("    (no agent config here)");
    if (touched) cleaned++;
  }

  console.log("");

  // The client comes out after the repos, not before: the Codex block is
  // removed by code living in this very directory, and on Windows a half-
  // deleted client mid-loop would fail the rest of the repos. Deleting the
  // folder this file is running from is safe only because the import at the top
  // is static — install-codex.mjs is read and evaluated before a line of this
  // runs, so nothing is loaded from disk after this point.
  if (existsSync(CLIENT_DIR)) {
    try {
      rmSync(CLIENT_DIR, { recursive: true, force: true });
      console.log(`  client        removed ${CLIENT_DIR}`);
    } catch (err) {
      failures++;
      console.log(`  client        FAILED: could not remove ${CLIENT_DIR} (${err.message})`);
      console.log("                Close anything running from it and delete that folder by hand.");
    }
  } else {
    console.log(`  client        not installed at ${CLIENT_DIR}`);
  }

  if (all) {
    if (existsSync(HOME)) {
      try {
        // Everything ~/.zevet holds is ours: config.json, workspaces.json, the
        // updater's manifest, its stamp and its lock. --all means all of it.
        rmSync(HOME, { recursive: true, force: true });
        console.log(`  config        removed ${HOME} — token and all`);
      } catch (err) {
        failures++;
        console.log(`  config        FAILED: could not remove ${HOME} (${err.message})`);
      }
    } else {
      console.log(`  config        nothing at ${HOME}`);
    }
  } else if (existsSync(CONFIG)) {
    console.log(`  config        left alone at ${CONFIG} (--all removes ${HOME} entirely)`);
  } else {
    console.log(`  config        nothing at ${CONFIG}`);
  }

  console.log("");
  console.log(
    `  ${cleaned} repo${cleaned === 1 ? "" : "s"} unwired` +
      (failures ? `, ${failures} thing${failures === 1 ? "" : "s"} could not be done — see FAILED above` : ""),
  );
  // Rule 3's other half: workspaces.json is not a list of every repo zevet was
  // ever wired into, and pretending otherwise is how a hook survives an
  // uninstall and keeps reporting to a hub nobody is watching.
  console.log("  A repo wired up by hand and never opened in the app is not listed above. For those:");
  console.log("      node client/install.mjs <repo-path> --remove      (from a zevet checkout)");
}

try {
  main();
} catch (err) {
  // Rule 1. Whatever went wrong, it is a finding, not an exit code.
  console.log(`  uninstall hit an unexpected error: ${(err && err.message) || err}`);
}
process.exit(0);
