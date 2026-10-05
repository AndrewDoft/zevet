// Execute the board's real update and GitHub-connect logic against the modules
// the renderer itself drives, with the same bridge calls exposed by preload.js.
// The board's controls used to be sliced out of the page and run in a fake DOM;
// the app is now bundled React, so the same logic lives in plain-JavaScript
// modules — update.mjs and connect.mjs — that the components import, and this
// test runs those exact files. No separate renderer implementation.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const update = await import(pathToFileURL(path.join(ROOT, "board", "src", "lib", "update.mjs")).href);
const { createUpdateControl, updateStatusText, updatePercent, updateCommand, INSTALLER_OPENED } = update;
const { connectPhaseLabel, connectValue, disconnectValue } = await import(
  pathToFileURL(path.join(ROOT, "board", "src", "lib", "connect.mjs")).href
);

const flush = () => new Promise((r) => setImmediate(r));

function board(overrides = {}) {
  const bridge = {
    updateStatus: async () => ({ current: "0.2.0", phase: "idle" }),
    updateInstall: async () => ({ ok: true, manual: true }),
    ...overrides,
  };
  const ctl = createUpdateControl(() => bridge, () => {});
  return { ctl, bridge };
}

const up = (checking = false, installing = false) => ({ checking, installing });
const has = (check = true, install = true) => ({ hasCheck: check, hasInstall: install });
const ready = { current: "0.2.0", phase: "ready", version: "0.2.1", canInstall: true, manual: true };

describe("the update controls", () => {
  test("a real update check refreshes the status through checking, download progress and install", async () => {
    let controller;
    const ui = board({
      updateCheck: () => new Promise((resolve, reject) => { controller = { resolve, reject }; }),
    });
    ui.ctl.receiveUpdate({ current: "0.2.0", phase: "idle" });
    assert.equal(updateStatusText(ui.ctl.updates.state, up()), "Not checked yet");

    const checking = ui.ctl.check();
    await flush();
    assert.equal(updateStatusText(ui.ctl.updates.state, up(true, false)), "Checking\u2026");

    controller.resolve({ current: "0.2.0", version: "0.2.1", phase: "downloading", percent: 0, canInstall: false });
    await checking;
    ui.ctl.receiveUpdate({ current: "0.2.0", version: "0.2.1", phase: "downloading", percent: 50, canInstall: false });
    assert.equal(updatePercent(ui.ctl.updates.state), 50);
    assert.match(updateStatusText(ui.ctl.updates.state, up()), /Downloading 0\.2\.1 · 50%/);
    assert.equal(updateCommand(ui.ctl.updates.state, up(), has()), null, "a bar owns the downloading slot");

    ui.ctl.receiveUpdate({ ...ready });
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(), has()), {
      kind: "install",
      disabled: false,
      label: "Open installer",
    });

    ui.ctl.install();
    await flush();
    assert.equal(ui.ctl.updates.notice, INSTALLER_OPENED, "the rail and Settings show where the installer went");
    assert.ok(INSTALLER_OPENED.includes("replace it in Applications"));
  });

  test("Windows offers a restart and blocks duplicate installation across both controls", async () => {
    let resolveInstall;
    const ui = board({ updateInstall: () => new Promise((r) => { resolveInstall = r; }) });
    ui.ctl.receiveUpdate({ ...ready, manual: false });
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(), has()), {
      kind: "restart",
      disabled: false,
      label: "Restart to install",
    });
    ui.ctl.install();
    await flush();
    // The same command feeds the rail and Settings, so while the install runs
    // both columns read "Restarting…" and both are disabled: one click cannot
    // start a second install from the other column.
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(false, true), has()), {
      kind: "busy",
      disabled: true,
      label: "Restarting\u2026",
    });
    assert.equal(ui.ctl.updates.installing, true);
    resolveInstall({ ok: true, restarting: true });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ui.ctl.updates.installing, false);
    assert.equal(ui.ctl.updates.notice, "", "a restarting install leaves no desktop-opener notice");
  });

  test("a pushed error is visible and a check offers a working retry", async () => {
    let retries = 0;
    const ui = board({ updateCheck: async () => { retries++; return ready; } });
    ui.ctl.receiveUpdate({ ...ready, phase: "error", canInstall: false, error: "Checksum mismatch" });
    assert.match(updateStatusText(ui.ctl.updates.state, up()), /Checksum mismatch/);
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(), has(true, false)), {
      kind: "check",
      disabled: false,
      label: "Check now",
    });
    ui.ctl.check();
    // While the check is in flight the same command reads "Checking…" and is
    // disabled in both columns.
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(true, false), has(true, false)), {
      kind: "check",
      disabled: true,
      label: "Checking\u2026",
    });
    await flush();
    assert.equal(retries, 1);
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(), has()), {
      kind: "install",
      disabled: false,
      label: "Open installer",
    });
  });

  test("a rejected check leaves a visible error and an enabled retry", async () => {
    const ui = board({ updateCheck: async () => { throw new Error("Connection lost"); } });
    ui.ctl.check();
    await flush();
    assert.match(updateStatusText(ui.ctl.updates.state, up()), /Connection lost/);
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(), has(true, false)), {
      kind: "check",
      disabled: false,
      label: "Check now",
    });
  });

  test("both failed and rejected installer calls retain a usable install action", async () => {
    for (const failure of [
      async () => ({ ok: false, error: "Cannot open image" }),
      async () => { throw new Error("Cannot open image"); },
    ]) {
      const ui = board({ updateInstall: failure });
      ui.ctl.receiveUpdate(ready);
      ui.ctl.install();
      await flush();
      assert.match(ui.ctl.updates.installError, /Cannot open image/);
      assert.deepEqual(updateCommand(ui.ctl.updates.state, up(), has()), {
        kind: "install",
        disabled: false,
        label: "Open installer",
      });
    }
  });

  test("ready without installation permission does not expose an install action", () => {
    const ui = board();
    ui.ctl.receiveUpdate({ ...ready, canInstall: false });
    assert.equal(updateCommand(ui.ctl.updates.state, up(), has()), null);
  });

  test("initial status cannot overwrite a newer update pushed from the app", async () => {
    let resolveStatus;
    let push;
    const ui = board({
      onUpdate: (cb) => { push = cb; },
      updateStatus: () => new Promise((r) => { resolveStatus = r; }),
    });
    ui.ctl.startUpdates();
    await flush();
    push(ready);
    resolveStatus({ current: "0.2.0", phase: "current" });
    await flush();
    // The newer push survived the initial status read.
    assert.deepEqual(updateCommand(ui.ctl.updates.state, up(), has()), {
      kind: "install",
      disabled: false,
      label: "Open installer",
    });
  });

  test("the update section degrades safely in browsers and old app builds", () => {
    const settings = readFileSync(path.join(ROOT, "board", "src", "components", "settings.tsx"), "utf8");
    assert.ok(settings.includes('typeof bridge.local.updateStatus !== "function"'), "the Settings gate is still there");
    assert.ok(settings.includes('<SSection title="Version" summary="web">'));
  });
});

describe("a ready update shows a bar, not a dialog", () => {
  // Andrew: "when you are in the middle of using the app it should just say
  // update available" — not a modal. These read source rather than render
  // React, the same way "the update section degrades safely" above does.
  const appTsx = readFileSync(path.join(ROOT, "board", "src", "App.tsx"), "utf8");
  const bannerPath = path.join(ROOT, "board", "src", "components", "updatebanner.tsx");
  const banner = readFileSync(bannerPath, "utf8");

  test("App mounts the bar, and the old modal is gone", () => {
    assert.match(appTsx, /<UpdateBanner \/>/);
    assert.ok(!appTsx.includes("UpdateDialog"), "the modal must not still be mounted");
    assert.equal(
      existsSync(path.join(ROOT, "board", "src", "components", "updatedialog.tsx")),
      false,
      "the old modal file should be deleted, not just unmounted",
    );
  });

  test("the bar is not a Dialog wearing a different name", () => {
    assert.ok(!banner.includes("Dialog"), "a modal component renamed is still a modal");
    assert.match(banner, /Restart now/);
    assert.match(banner, />\s*Close\s*</);
  });
});

describe("the connect flow", () => {
  const settings = readFileSync(path.join(ROOT, "board", "src", "components", "settings.tsx"), "utf8");

  test("GitHub connects from Settings: code, approval, done", () => {
    assert.equal(connectPhaseLabel("waiting"), "Cancel");
    assert.equal(connectValue("waiting", { code: "ABCD-1234" }), "Approve on GitHub: ABCD-1234");
    assert.equal(connectValue("done", { login: "michael" }), "Signed in as @michael.");
    assert.equal(connectPhaseLabel("done"), "Connect GitHub");
    // The flow starts through the same three main-process calls setup.html
    // uses, with the hub from the redacted config and a way out.
    assert.ok(settings.includes("githubStart?.("), "Settings must start the flow through githubStart");
    assert.ok(settings.includes("githubCancel?.()"), "waiting must be cancellable");
  });

  test("a failed start shows the reason with a working retry", () => {
    assert.equal(connectPhaseLabel("fail"), "Retry");
    assert.equal(connectValue("fail", { message: "Hub is unreachable." }), "Hub is unreachable.");
  });

  test("disconnect signs the machine out and reports it", () => {
    assert.equal(disconnectValue("done"), "Signed out.");
    assert.ok(settings.includes("githubLogout?.("), "Settings must sign the machine out through githubLogout");
  });

  test("a failed disconnect keeps a working retry", () => {
    assert.equal(disconnectValue("fail"), "Could not sign out.");
  });
});