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
//   1. WITH NO SECRETS, the config is exactly what it has always been. This is
//      the state of every build today, every fork, and every pull request. A
//      signing feature that breaks unsigned builds has made things worse.
//   2. WITH SECRETS, signing actually turns on — and turns on COMPLETELY,
//      because a Mac build that is signed but not notarised is still refused by
//      Gatekeeper while looking, in the log, like a success.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const CONFIG = path.join(ROOT, "desktop", "electron-builder.config.js");
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
  try {
    return require(CONFIG);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(CONFIG)];
  }
}

describe("with no signing secrets — today, and every fork", () => {
  const c = load({});

  test("signing is off on both platforms", () => {
    assert.deepEqual(c.__signing, { mac: false, win: false });
  });

  test("the mac build does not ask for a hardened runtime or notarisation", () => {
    // Either one without a certificate does not make an unsigned build. It
    // FAILS the build, which is the whole reason this config is computed.
    assert.equal(c.mac.hardenedRuntime, undefined);
    assert.equal(c.mac.notarize, undefined);
    assert.equal(c.mac.gatekeeperAssess, undefined);
    assert.equal(c.mac.identity, null, "identity must be explicitly null so electron-builder stops hunting");
  });

  test("the windows build has no azure block", () => {
    assert.equal(c.win.azureSignOptions, undefined);
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
  const c = load(MAC_ENV);

  test("signing and notarisation both turn on", () => {
    assert.equal(c.__signing.mac, true);
    assert.equal(c.mac.hardenedRuntime, true, "notarisation is refused without it");
    assert.deepEqual(c.mac.notarize, { teamId: "TEAM123456" });
    assert.equal(c.mac.gatekeeperAssess, true);
  });

  test("identity is no longer forced to null", () => {
    // Left at null, the certificate would be ignored and the build would come
    // out unsigned while every log line said signing was configured.
    assert.equal(c.mac.identity, undefined);
  });
});

describe("with mac secrets only PARTLY set", () => {
  test("a certificate without notarisation credentials does not half-sign", () => {
    // ⚠️ THE WORST AVAILABLE OUTCOME, and the one this guards. A signed,
    // un-notarised app is still refused by Gatekeeper on any machine that
    // downloaded it -- so it looks like the certificate did not work, and
    // nothing in the build says otherwise.
    const c = load({ CSC_LINK: "p12", CSC_KEY_PASSWORD: "x" });
    assert.equal(c.__signing.mac, false);
    assert.equal(c.mac.hardenedRuntime, undefined);
  });

  test("an empty secret counts as absent, not as present", () => {
    // A GitHub secret that does not exist expands to "". Every one of these
    // variables is passed on every build, so "" is the NORMAL value.
    const c = load({ ...MAC_ENV, APPLE_TEAM_ID: "" });
    assert.equal(c.__signing.mac, false);
  });

  test("whitespace is not a credential either", () => {
    const c = load({ ...MAC_ENV, APPLE_ID: "   " });
    assert.equal(c.__signing.mac, false);
  });
});

describe("with every windows secret set", () => {
  const c = load(WIN_ENV);

  test("azure trusted signing turns on with all four fields", () => {
    assert.equal(c.__signing.win, true);
    assert.deepEqual(c.win.azureSignOptions, {
      publisherName: "Masora Inc",
      endpoint: "https://eus.codesigning.azure.net",
      codeSigningAccountName: "masora",
      certificateProfileName: "zevet",
    });
  });

  test("the mac half is untouched by the windows half", () => {
    assert.equal(c.__signing.mac, false);
    assert.equal(c.mac.identity, null);
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
