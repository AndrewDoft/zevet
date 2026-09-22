"use strict";

/**
 * A git worktree of its own for an agent that would otherwise share one.
 *
 * Two agents in one working tree is how work silently disappears: a
 * whole-file write from a stale read deletes what the other agent committed a
 * minute ago, and neither of them notices. So the SECOND agent into a repo
 * gets `zevet/<slug>` in a worktree under the zevet home — never inside the
 * repo, where every file walker would find it — and the first keeps the repo
 * itself, so one agent on its own behaves exactly as it always did.
 *
 * Every failure here returns null or false and leaves things where they are:
 * the caller starts the agent in the repo, as before, and a worktree that
 * could not be removed is left for `prune` at the next start. Nothing here
 * may block an agent from starting, and nothing may lose work to tidy up.
 *
 * No Electron in here, so node --test can load it. `git` is injectable.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

/** Big ignored dependency dirs an agent needs to build and test, linked from
 *  the repo rather than reinstalled per worktree. */
const DEPS = ["node_modules", ".venv"];

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

function createAgentWorktrees({ home, git = runGit, platform = process.platform }) {
  const root = path.join(home, "worktrees");
  const sidecar = (dir) => `${dir}.json`;

  /** Where a dependency dir could be: the repo root and each first-level
   *  folder, relative to the top of the checkout. */
  function depSlots(top) {
    let subs = [];
    try {
      subs = fs
        .readdirSync(top, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== ".git" && !DEPS.includes(d.name))
        .map((d) => d.name);
    } catch {
      // Unreadable repo root: the root slot alone is still worth trying.
    }
    return ["", ...subs].flatMap((sub) => DEPS.map((name) => path.join(sub, name)));
  }

  async function linkDeps(top, dir) {
    for (const rel of depSlots(top)) {
      const src = path.join(top, rel);
      const dst = path.join(dir, rel);
      if (!fs.existsSync(src) || !fs.existsSync(path.dirname(dst)) || fs.existsSync(dst)) continue;
      try {
        // A junction on Windows needs no developer mode; a symlink elsewhere.
        fs.symlinkSync(src, dst, platform === "win32" ? "junction" : "dir");
        // `node_modules/` in a .gitignore matches a directory, not a symlink
        // to one: a link git would not ignore is one the agent could commit.
        await git(["check-ignore", "-q", rel], dir);
      } catch {
        unlink(dst);
      }
    }
  }

  /** The link itself, never what it points at: `rmSync` without `recursive`
   *  on a link removes the link. A real directory is left to `git worktree
   *  remove` like any other file. */
  function unlink(p) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p);
    } catch {
      // Not there, or not a link: nothing to remove.
    }
  }

  function unlinkDeps(dir, top) {
    for (const rel of depSlots(top)) unlink(path.join(dir, rel));
  }

  const api = {
    /**
     * A new worktree of `repo` at its HEAD, or null when there is none to be
     * had (not a git repo, no commit yet, git missing or failing). `cwd` is
     * where the agent starts: the same folder inside the worktree that the
     * workspace is inside the repo.
     */
    async create(repo) {
      try {
        // Not --show-toplevel: that resolves symlinks, and the hook matches
        // this path against the workspace as the user opened it.
        const top = path.resolve(repo, (await git(["rev-parse", "--show-cdup"], repo)).trim());
        const base = (await git(["rev-parse", "--verify", "HEAD"], top)).trim();
        const slug = crypto.randomBytes(3).toString("hex");
        const dir = path.join(root, `${path.basename(top)}-${slug}`);
        const branch = `zevet/${slug}`;
        fs.mkdirSync(root, { recursive: true });
        await git(["worktree", "add", "-q", "-b", branch, dir, base], top);
        const wt = { dir, branch, base, repo: top };
        fs.writeFileSync(sidecar(dir), JSON.stringify(wt));
        await linkDeps(top, dir);
        return { ...wt, cwd: path.join(dir, path.relative(top, path.resolve(repo))) };
      } catch {
        return null;
      }
    },

    /**
     * Done with a worktree. Nothing new: the worktree and its branch go.
     * Uncommitted changes: committed to its own branch, which is kept, and
     * only the directory goes. False when anything failed, with the worktree
     * left in place for the next `prune`.
     */
    async release(wt, message) {
      const { dir, branch, base, repo } = wt || {};
      // Never anything but a branch and a folder this module made.
      if (!dir || !String(branch).startsWith("zevet/") || path.dirname(path.resolve(dir)) !== path.resolve(root)) {
        return false;
      }
      try {
        if (fs.existsSync(dir)) {
          unlinkDeps(dir, repo);
          if ((await git(["status", "--porcelain"], dir)).trim()) {
            let ident = [];
            try {
              await git(["config", "user.email"], dir);
            } catch {
              ident = ["-c", "user.name=zevet", "-c", "user.email=zevet@localhost"];
            }
            await git(["add", "-A"], dir);
            // zevet's own safekeeping commit, not the user's: their hooks and
            // signing are for work they are committing on purpose.
            await git([...ident, "-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message || "Agent work"], dir);
          }
          await git(["worktree", "remove", "--force", dir], repo);
        } else {
          await git(["worktree", "prune"], repo);
        }
        if ((await git(["rev-list", "--count", `${base}..${branch}`], repo)).trim() === "0") {
          await git(["branch", "-D", branch], repo);
        }
        fs.rmSync(sidecar(dir), { force: true });
        return true;
      } catch {
        return false;
      }
    },

    /** Every worktree this module made and nobody is using: at app start,
     *  that is all of them — consoles do not outlive the app. */
    async prune() {
      let names = [];
      try {
        names = fs.readdirSync(root).filter((n) => n.endsWith(".json"));
      } catch {
        return;
      }
      for (const n of names) {
        try {
          await api.release(JSON.parse(fs.readFileSync(path.join(root, n), "utf8")));
        } catch {
          // Unreadable record: left alone rather than guessed at.
        }
      }
    },
  };
  return api;
}

module.exports = { createAgentWorktrees, DEPS };
