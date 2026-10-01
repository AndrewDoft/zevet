// Whether a folder's code may be sent to a model Zevet cannot vouch for (the
// router's privacy gate, zevet-router.js PUBLIC_ONLY). Unknown is private.
//
//   a path containing "masora2"          private, whatever git says
//   no git remote, or a non-GitHub one   private
//   a github.com remote                  public only when GitHub's own API,
//                                        asked WITHOUT credentials, serves the
//                                        repo with `private: false`; a private
//                                        repo is a 404 to an anonymous caller
//
// Nothing here carries a token, and a failure of any kind answers "private".
const { execFile } = require("node:child_process");

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // dir -> { at, value }

function remoteOf(dir) {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 5000, windowsHide: true }, (err, out) =>
      resolve(err ? "" : String(out).trim()),
    );
  });
}

/** "owner/repo" for a github.com remote URL, else null. */
function githubRepo(url) {
  const m = /github\.com[/:]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

async function anonymousIsPublic(repo, fetchImpl) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "zevet" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return false;
  const body = await res.json();
  return body && body.private === false;
}

/**
 * @param {string} dir
 * @param {{ remote?: (dir:string)=>Promise<string>, fetch?: typeof fetch, now?: ()=>number }} [deps]
 * @returns {Promise<boolean>} true unless the folder is positively known to be a public GitHub repo
 */
async function isPrivate(dir, deps = {}) {
  if (typeof dir !== "string" || !dir) return true;
  if (/masora2/i.test(dir)) return true;
  const now = (deps.now || Date.now)();
  const hit = cache.get(dir);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  let value = true;
  try {
    const repo = githubRepo(await (deps.remote || remoteOf)(dir));
    if (repo && /masora2/i.test(repo)) value = true;
    else if (repo) value = !(await anonymousIsPublic(repo, deps.fetch || fetch));
  } catch {
    value = true;
  }
  cache.set(dir, { at: now, value });
  return value;
}

module.exports = { isPrivate, githubRepo, _cache: cache };
