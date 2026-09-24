// Verify Electron's actual OS encryption across two processes. No cloud calls,
// real credential, window, or workspace runtime is involved.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const TOKEN = `paup_${"f".repeat(32)}_${"s".repeat(43)}`;

if (!process.versions.electron) {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "masora-update-storage-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    for (const mode of ["write", "read"]) {
      execFileSync(require("electron"), [__filename, dir, mode], { env, stdio: "inherit", timeout: 30000 });
    }
    console.log("OS-encrypted update access survived a separate Electron process.");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else {
  const { app, safeStorage } = require("electron");
  const { UpdateAccess } = require("./update-access.js");
  const [dir, mode] = process.argv.slice(2);
  if (!dir || !["write", "read"].includes(mode)) app.exit(1);
  app.setName("Masora Update Storage Test");
  app.setPath("userData", dir);
  app.whenReady().then(() => {
    const file = path.join(dir, "update-access.json");
    const access = new UpdateAccess({ product: "zevet", file, storage: safeStorage });
    if (mode === "write") {
      access.saveToken(TOKEN, "storage-test-device");
      assert.ok(!fs.readFileSync(file, "utf8").includes(TOKEN));
    } else {
      assert.equal(access.readToken(), TOKEN);
      access.clear();
      assert.equal(access.readToken(), null);
    }
    app.exit(0);
  }).catch(() => {
    console.error("OS-encrypted update storage verification failed.");
    app.exit(1);
  });
}
