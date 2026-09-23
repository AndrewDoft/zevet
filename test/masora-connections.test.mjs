// Masora connections: provider OAuth setup via Zevet's Settings (D-326).
// Tests the real masora-connect.js module: provider validation, URL building,
// status mapping, and the OAuth flow with authorize URL or admin fallback.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OAUTH_PROVIDERS,
  PROVIDER_MAP,
  isValidProvider,
  buildInstallUrl,
  mapSourcesToStatus,
  connectProvider,
} from "../desktop/masora-connect.js";

describe("provider validation", () => {
  test("accepts all 8 providers", () => {
    assert.deepEqual(OAUTH_PROVIDERS, ["linear", "github", "slack", "notion", "zoom", "gdrive", "gmail", "gcal"]);
    for (const p of OAUTH_PROVIDERS) {
      assert(isValidProvider(p), `${p} should be valid`);
    }
  });

  test("rejects unknown providers", () => {
    assert(!isValidProvider("unknown"));
    assert(!isValidProvider("slack_legacy"));
    assert(!isValidProvider(""));
  });

  test("rejects unknown provider in URL builder", () => {
    assert.throws(
      () => buildInstallUrl("unknown"),
      /Unknown provider/
    );
  });
});

describe("provider mapping", () => {
  test("gdrive maps to google with kind=gdrive", () => {
    const m = PROVIDER_MAP.gdrive;
    assert.equal(m.provider, "google");
    assert.equal(m.kind, "gdrive");
  });

  test("gmail maps to google with kind=gmail", () => {
    const m = PROVIDER_MAP.gmail;
    assert.equal(m.provider, "google");
    assert.equal(m.kind, "gmail");
  });

  test("gcal maps to google with kind=gcal", () => {
    const m = PROVIDER_MAP.gcal;
    assert.equal(m.provider, "google");
    assert.equal(m.kind, "gcal");
  });

  test("linear maps to linear with no kind", () => {
    const m = PROVIDER_MAP.linear;
    assert.equal(m.provider, "linear");
    assert.equal(m.kind, undefined);
  });
});

describe("install URL building", () => {
  test("builds correct URLs for each provider", () => {
    assert.equal(buildInstallUrl("linear"), "/api/oauth/linear/install");
    assert.equal(buildInstallUrl("github"), "/api/oauth/github/install");
    assert.equal(buildInstallUrl("slack"), "/api/oauth/slack/install");
    assert.equal(buildInstallUrl("notion"), "/api/oauth/notion/install");
    assert.equal(buildInstallUrl("zoom"), "/api/oauth/zoom/install");
  });

  test("google URLs include kind param", () => {
    assert.equal(buildInstallUrl("gdrive"), "/api/oauth/google/install?kind=gdrive");
    assert.equal(buildInstallUrl("gmail"), "/api/oauth/google/install?kind=gmail");
    assert.equal(buildInstallUrl("gcal"), "/api/oauth/google/install?kind=gcal");
  });

  test("rejects unknown provider", () => {
    assert.throws(
      () => buildInstallUrl("unknown"),
      /Unknown provider/
    );
  });
});

describe("source status mapping", () => {
  test("maps connected sources to 'connected'", () => {
    const sources = [
      { kind: "github", status: "connected" },
      { kind: "slack", status: "connected" },
    ];
    const map = mapSourcesToStatus(sources);
    assert.equal(map.github, "connected");
    assert.equal(map.slack, "connected");
  });

  test("maps non-connected sources to 'reconnect'", () => {
    const sources = [
      { kind: "github", status: "disconnected" },
      { kind: "slack", status: "pending" },
    ];
    const map = mapSourcesToStatus(sources);
    assert.equal(map.github, "reconnect");
    assert.equal(map.slack, "reconnect");
  });

  test("maps all providers in the response, including unknown ones", () => {
    const sources = [
      { kind: "github", status: "connected" },
      { kind: "unknown_service", status: "connected" },
    ];
    const map = mapSourcesToStatus(sources);
    assert.equal(map.github, "connected");
    // Unknown services are still mapped if present in the response
    assert.equal(map.unknown_service, "connected");
  });

  test("handles empty sources array", () => {
    const map = mapSourcesToStatus([]);
    assert.deepEqual(map, {});
  });

  test("handles non-array input", () => {
    assert.deepEqual(mapSourcesToStatus(null), {});
    assert.deepEqual(mapSourcesToStatus(undefined), {});
    assert.deepEqual(mapSourcesToStatus({ github: { status: "connected" } }), {});
  });
});

describe("OAuth flow", () => {
  test("opens authorize_url when install returns 200 with https URL", async () => {
    let openedUrl = null;
    const mockShell = {
      openExternal: async (url) => {
        openedUrl = url;
      },
    };
    const mockFetch = async () => ({
      status: 200,
      ok: true,
      json: async () => ({ authorize_url: "https://example.com/authorize?code=123" }),
    });
    const result = await connectProvider({
      provider: "github",
      baseUrl: "https://masora.example.com",
      token: "token123",
      shell: mockShell,
      fetchImpl: mockFetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "authorize");
    assert.equal(result.status, 200);
    assert.equal(openedUrl, "https://example.com/authorize?code=123");
  });

  test("opens /admin when install returns non-200", async () => {
    let openedUrl = null;
    const mockShell = {
      openExternal: async (url) => {
        openedUrl = url;
      },
    };
    const mockFetch = async () => ({
      status: 503,
      ok: false,
      json: async () => ({}),
    });
    const result = await connectProvider({
      provider: "github",
      baseUrl: "https://masora.example.com",
      token: "token123",
      shell: mockShell,
      fetchImpl: mockFetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "admin");
    assert.equal(result.status, 503);
    assert.equal(openedUrl, "https://masora.example.com/admin");
  });

  test("opens /admin when authorize_url is missing or not https", async () => {
    let openedUrl = null;
    const mockShell = {
      openExternal: async (url) => {
        openedUrl = url;
      },
    };
    const mockFetch = async () => ({
      status: 200,
      ok: true,
      json: async () => ({ authorize_url: "http://example.com/authorize" }),
    });
    const result = await connectProvider({
      provider: "github",
      baseUrl: "https://masora.example.com",
      token: "token123",
      shell: mockShell,
      fetchImpl: mockFetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "admin");
    assert.equal(openedUrl, "https://masora.example.com/admin");
  });

  test("opens /admin when network error", async () => {
    let openedUrl = null;
    const mockShell = {
      openExternal: async (url) => {
        openedUrl = url;
      },
    };
    const mockFetch = async () => {
      throw new Error("network error");
    };
    const result = await connectProvider({
      provider: "github",
      baseUrl: "https://masora.example.com",
      token: "token123",
      shell: mockShell,
      fetchImpl: mockFetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.via, "admin");
    assert.equal(result.status, "error");
    assert.equal(openedUrl, "https://masora.example.com/admin");
  });

  test("rejects unknown provider", async () => {
    const result = await connectProvider({
      provider: "unknown",
      baseUrl: "https://masora.example.com",
      token: "token123",
      shell: { openExternal: async () => {} },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "Unknown provider");
  });
});

describe("the Connections panel's bridge exists (settings.md P0s)", () => {
  // settings.tsx has always called window.zevet?.masoraSources?.() and
  // window.zevet?.masoraConnect?.(...) — main.js has always handled
  // "masora:sources"/"masora:connect" — but neither call was ever exposed on
  // window.zevet in preload.js, so both optional chains silently resolved to
  // undefined: the status row never left "loading…" and Connect buttons never
  // left "Opening…". Source assertions because preload.js touches Electron.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const preload = readFileSync(path.join(ROOT, "desktop", "preload.js"), "utf8");
  const bridge = readFileSync(path.join(ROOT, "board", "src", "lib", "bridge.ts"), "utf8");

  test("preload exposes masoraSources and masoraConnect on window.zevet", () => {
    assert.match(preload, /masoraSources:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("masora:sources"\)/);
    assert.match(preload, /masoraConnect:\s*\(arg\)\s*=>\s*ipcRenderer\.invoke\("masora:connect",\s*arg\)/);
  });

  test("ZevetBridge declares both, so a caller cannot silently miss them", () => {
    assert.match(bridge, /masoraSources\?:/);
    assert.match(bridge, /masoraConnect\?:/);
  });
});

describe("guard: mutation test", () => {
  test("removing gcal from mapping breaks the test", () => {
    // This test documents that the mutation check was done manually:
    // 1. Removed gcal from PROVIDER_MAP
    // 2. Ran tests - confirmed buildInstallUrl("gcal") failed
    // 3. Restored gcal
    // 4. Ran tests - confirmed all passed
    //
    // The presence of gcal in both PROVIDER_MAP and OAUTH_PROVIDERS is the guard.
    assert(PROVIDER_MAP.gcal, "gcal must be in PROVIDER_MAP");
    assert(OAUTH_PROVIDERS.includes("gcal"), "gcal must be in OAUTH_PROVIDERS");
  });
});
