// Two things a dozen files each re-implemented: where ~/.zevet is, and how to
// write a JSON file so a crash cannot leave it half-written. Shared by client/
// and desktop/ (desktop/zevet-home.js locates this file). hook.mjs and friends
// import it, so it is in the hub's CLIENT_FILES and doctor.mjs's copy of that list.
// opencode-plugin.mjs deliberately does NOT: it is copied alone into wired repos.
import os from "node:os";
import path from "node:path";
import { writeFileSync, renameSync, rmSync } from "node:fs";

export function zevetHome(env = process.env, homedir = os.homedir) {
  return env.ZEVET_HOME || path.join(homedir(), ".zevet");
}

/** JSON, 2-space indent, trailing newline; temp file in the same directory, then rename. */
export function atomicWriteJson(file, value, { mode } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
