// Code signing: off today, and correct on the day it is switched on.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS TESTED WHEN NOTHING IS SIGNED
//
// Because the day a certificate is bought is the worst possible day to find out
// the pipeline is wrong. There will be a renewal deadline, a half-configured
// Azure account, a build log four hundred lines long, and no memory of which of
// the twelve environment variables mattered. All of it is decided here instead,
// against a config object, in milliseconds.
//
// Two properties, and the first is the load-bearing one:
//
//   1. WITH NO SECRETS, the Mac bundle is sealed ad-hoc without importing a
//      certificate or attempting notarization. Forks can still build it.
//   2. WITH SECRETS, signing actually turns on — and turns on COMPLETELY,
//      because a Mac build that is signed but not notarised is still refused by
//      Gatekeeper while looking, in the log, like a success.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const CONFIG = path.join(ROOT, "desktop", "electron-builder.config.js");
const FLAGS = path.join(ROOT, "desktop", "signing.js");
const PKG = require(path.join(ROOT, "desktop", "package.json"));

const MAC_ENV = {
  CSC_LINK: "base64-p12",
  CSC_KEY_PASSWORD: "hunter2",
  APPLE_ID: "andrew@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
  APPLE_TEAM_ID: "TEAM123456",
};

const WIN_ENV = {
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_CLIENT_SECRET: "secret",
  AZURE_CODE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
  AZURE_CODE_SIGNING_ACCOUNT: "masora",
  AZURE_CERT_PROFILE: "zevet",
  AZURE_PUBLISHER_NAME: "Masora Inc",
};

/** Load the config fresh under a given environment. `require` caches by path,
 *  so the cache entry is dropped — without this every case after the first
 *  would silently assert against the first one's environment. */
function load(env) {
  const saved = {};
  const keys = [...Object.keys(MAC_ENV), ...Object.keys(WIN_ENV)];
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve(CONFIG)];
  delete require.cache[require.resolve(FLAGS)];
  try {
    const config = require(CONFIG);
    const { macSigning, winSigning } = require(FLAGS);
    // ⚠️ THE FLAGS COME FROM signing.js, NOT OFF THE CONFIG. They used to be
    // exported as `config.__signing`, and electron-builder's schema validation
    // is CLOSED -- that one extra key failed every build on both runners with
    // "configuration has an unknown property '__signing'". The test asserted it
    // was there, so the test agreed with the bug. Nothing but a real build
    // found it.
    return { config, signing: { mac: macSigning(), win: winSigning() } };
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(CONFIG)];
    delete require.cache[require.resolve(FLAGS)];
  }
}

describe("with no signing secrets — today, and every fork", () => {
  const { config: c, signing } = load({});

  test("publisher signing is off on both platforms", () => {
    assert.deepEqual(signing, { mac: false, win: false });
  });

  test("the normal mac signer skips certificate import and notarisation", () => {
    // The separate afterPack hook supplies the ad-hoc seal. identity:null
    // must remain here: without it partial credentials reach electron-builder.
    assert.equal(c.mac.hardenedRuntime, undefined);
    assert.equal(c.mac.notarize, undefined);
    assert.equal(c.mac.gatekeeperAssess, undefined);
    assert.equal(c.mac.identity, null, "identity must be explicitly null so electron-builder stops hunting");
    assert.equal(c.mac.sign, undefined, "a custom mac.sign hook would override publisher signing");
    assert.equal(c.afterPack, "./sign-macos.cjs");
  });

  test("the windows build has no azure block", () => {
    assert.equal(c.win.azureSignOptions, undefined);
  });

  test("the config introduces NO top-level key of its own", () => {
    /* ⚠️ THE ONE THAT WOULD HAVE CAUGHT IT. electron-builder validates the
     * exported object against a CLOSED schema: a single unrecognised top-level
     * property is a hard failure, not a warning, and it fails the build before
     * anything is packaged -- unsigned builds included. This file added
     * `__signing` for the tests to read and broke v0.2.1 on both runners.
     *
     * Asserted as "the same keys package.json's build had" rather than against
     * a copied list of electron-builder's valid options, because that list is
     * theirs and would rot. This config only ever spreads the base and
     * overrides `mac` and `win`; if it grows a key, that key is new. */
    assert.deepEqual(Object.keys(c).sort(), Object.keys(PKG.build).sort());
  });

  test("everything else is exactly what package.json says", () => {
    // ⚠️ THE IMPORTANT ONE. The build moved from `build` in package.json to
    // this file. If anything else drifted -- the file list, the artifact names,
    // extraResources -- the app either stops launching or stops carrying the
    // client scripts, and the build still succeeds.
    assert.deepEqual(c.files, PKG.build.files);
    assert.deepEqual(c.extraResources, PKG.build.extraResources);
    assert.deepEqual(c.nsis, PKG.build.nsis);
    assert.equal(c.appId, PKG.build.appId);
    assert.equal(c.productName, PKG.build.productName);
    assert.equal(c.win.artifactName, PKG.build.win.artifactName);
    assert.equal(c.mac.artifactName, PKG.build.mac.artifactName);
    assert.deepEqual(c.win.target, PKG.build.win.target);
    assert.deepEqual(c.mac.target, PKG.build.mac.target);
  });
});

describe("with every mac secret set", () => {
  const { config: c, signing } = load(MAC_ENV);

  test("signing and notarisation both turn on", () => {
    assert.equal(signing.mac, true);
    assert.equal(c.mac.hardenedRuntime, true, "notarisation is refused without it");
    assert.equal(c.mac.forceCodeSigning, true, "missing publisher identity must fail the release build");
    assert.deepEqual(c.mac.notarize, { teamId: "TEAM123456" });
    assert.equal(c.mac.gatekeeperAssess, true);
  });

  test("identity is no longer forced to null", () => {
    // Left at null, the certificate would be ignored and the build would come
    // out unsigned while every log line said signing was configured.
    assert.equal(c.mac.identity, undefined);
    assert.equal(c.mac.sign, undefined, "configured releases must use electron-builder's normal signer");
  });
});

describe("with mac secrets only PARTLY set", () => {
  test("a certificate without notarisation credentials does not half-sign", () => {
    // ⚠️ THE WORST AVAILABLE OUTCOME, and the one this guards. A signed,
    // un-notarised app is still refused by Gatekeeper on any machine that
    // downloaded it -- so it looks like the certificate did not work, and
    // nothing in the build says otherwise.
    const { config: c, signing } = load({ CSC_LINK: "p12", CSC_KEY_PASSWORD: "x" });
    assert.equal(signing.mac, false);
    assert.equal(c.mac.hardenedRuntime, undefined);
    assert.equal(c.mac.identity, null);
  });

  test("an empty secret counts as absent, not as present", () => {
    // A GitHub secret that does not exist expands to "". Every one of these
    // variables is passed on every build, so "" is the NORMAL value.
    const { signing } = load({ ...MAC_ENV, APPLE_TEAM_ID: "" });
    assert.equal(signing.mac, false);
  });

  test("whitespace is not a credential either", () => {
    const { signing } = load({ ...MAC_ENV, APPLE_ID: "   " });
    assert.equal(signing.mac, false);
  });
});

describe("with every windows secret set", () => {
  const { config: c, signing } = load(WIN_ENV);

  test("azure trusted signing turns on with all four fields", () => {
    assert.equal(signing.win, true);
    assert.deepEqual(c.win.azureSignOptions, {
      publisherName: "Masora Inc",
      endpoint: "https://eus.codesigning.azure.net",
      codeSigningAccountName: "masora",
      certificateProfileName: "zevet",
    });
  });

  test("the mac half is untouched by the windows half", () => {
    assert.equal(signing.mac, false);
    assert.equal(c.mac.identity, null);
  });
});

describe("the unsigned Mac integrity seal", () => {
  // CI runs these tests before installing desktop dependencies. Exercise the
  // real hook with only the expensive native signer replaced; the built DMG
  // smoke test separately runs codesign and launches the actual result.
  const hookSource = readFileSync(path.join(ROOT, "desktop", "sign-macos.cjs"), "utf8");

  async function seal(platform, env = {}, failure) {
    const { config, signing } = load(env);
    const calls = [];
    const modules = [];
    const entitlements = path.join(ROOT, "desktop/node_modules/app-builder-lib/templates/entitlements.mac.plist");
    const module = { exports: {} };
    function hookRequire(name) {
      modules.push(name);
      if (name === "node:path") return path;
      if (name === "./signing.js") return { macSigning: () => signing.mac };
      assert.equal(name, "@electron/osx-sign");
      return { signAsync: async (options) => {
        calls.push(options);
        if (failure) throw failure;
      } };
    }
    hookRequire.resolve = (name) => {
      assert.equal(name, "app-builder-lib/templates/entitlements.mac.plist");
      return entitlements;
    };
    vm.runInNewContext(hookSource, { module, require: hookRequire, console: { log() {} } });
    const appOutDir = path.join(ROOT, "desktop/out/mac arm64");
    await module.exports({ electronPlatformName: platform, appOutDir, packager: { appInfo: { productFilename: "zevet" } } });
    return { calls, modules, config, appOutDir, entitlements };
  }

  test("a beta gets a strict ad-hoc seal with Electron's runtime entitlements", async () => {
    const { calls, appOutDir, entitlements } = await seal("darwin");
    assert.equal(calls.length, 1);
    const options = calls[0];
    assert.equal(options.app, path.join(appOutDir, "zevet.app"));
    assert.equal(options.platform, "darwin");
    assert.equal(options.identity, "-");
    assert.equal(options.identityValidation, false);
    assert.equal(options.preAutoEntitlements, false);
    assert.equal(options.strictVerify, undefined, "use the working bare --strict default");
    assert.deepEqual({ ...options.optionsForFile(options.app) }, {
      entitlements, hardenedRuntime: true, timestamp: "none",
    });
  });

  test("incomplete Mac credentials keep the ad-hoc path and disable certificate import", async () => {
    for (const missing of Object.keys(MAC_ENV)) {
      const env = { ...MAC_ENV, [missing]: "" };
      const { calls, config } = await seal("darwin", env);
      assert.equal(calls.length, 1, `missing ${missing} should keep the ad-hoc seal`);
      assert.equal(calls[0].identity, "-");
      assert.equal(config.mac.identity, null, `missing ${missing} must not import a certificate`);
      assert.equal(config.mac.notarize, undefined);
    }
  });

  test("fully configured releases leave signing to electron-builder", async () => {
    const { calls, modules } = await seal("darwin", MAC_ENV);
    assert.equal(calls.length, 0);
    assert.ok(!modules.includes("@electron/osx-sign"));
  });

  test("Windows and Linux never invoke the Mac signer", async () => {
    for (const platform of ["win32", "linux"]) {
      const { calls, modules } = await seal(platform);
      assert.equal(calls.length, 0);
      assert.ok(!modules.includes("@electron/osx-sign"));
    }
  });

  test("a seal failure aborts the build", async () => {
    const failure = new Error("codesign could not seal a native module");
    await assert.rejects(seal("darwin", {}, failure), (error) => error === failure);
  });
});

describe("the CI workflow passes what the config reads", () => {
  test("every variable the config checks is in build.yml", async () => {
    // A config that reads APPLE_TEAM_ID and a workflow that does not pass it is
    // a pipeline that silently never signs. They are in two files that nothing
    // else connects.
    const { readFileSync } = await import("node:fs");
    const yml = readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
    for (const name of [...Object.keys(MAC_ENV), ...Object.keys(WIN_ENV)]) {
      assert.ok(yml.includes(`${name}:`), `build.yml never passes ${name}`);
    }
  });

  test("CSC_IDENTITY_AUTO_DISCOVERY is not hardcoded to false", () => {
    // It was. Pinned off, it would have suppressed the certificate as well as
    // the hunt for one, and the first signed build would have come out unsigned.
    const { readFileSync } = require("node:fs");
    const yml = readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
    assert.ok(
      /CSC_IDENTITY_AUTO_DISCOVERY:\s*\$\{\{/.test(yml),
      "CSC_IDENTITY_AUTO_DISCOVERY must be computed from whether a certificate exists",
    );
  });
});
