// Masora provider OAuth flow: fetch authorize URL, open in browser or fallback to admin.
// D-326: Zevet holds no secrets, opens Masora's OAuth flows via system browser.
"use strict";

/**
 * Map Zevet's provider IDs to Masora's provider names and optional kind param.
 * Masora provider names: slack, ms (Teams), google, github, notion, linear, atlassian, zoom.
 * Google needs a kind param to distinguish gdrive, gmail, gcal.
 */
const PROVIDER_MAP = {
  linear: { provider: "linear" },
  github: { provider: "github" },
  slack: { provider: "slack" },
  notion: { provider: "notion" },
  zoom: { provider: "zoom" },
  gdrive: { provider: "google", kind: "gdrive" },
  gmail: { provider: "google", kind: "gmail" },
  gcal: { provider: "google", kind: "gcal" },
};

const OAUTH_PROVIDERS = Object.keys(PROVIDER_MAP);

/**
 * Validates a provider ID against the allowlist.
 */
function isValidProvider(provider) {
  return OAUTH_PROVIDERS.includes(provider);
}

/**
 * Builds the install URL for a provider. Returns the path only, no domain.
 * Example: "/api/oauth/linear/install" or "/api/oauth/google/install?kind=gdrive"
 */
function buildInstallUrl(provider) {
  if (!isValidProvider(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const { provider: masoraProvider, kind } = PROVIDER_MAP[provider];
  if (kind) {
    return `/api/oauth/${masoraProvider}/install?kind=${kind}`;
  }
  return `/api/oauth/${masoraProvider}/install`;
}

/**
 * Maps a sources array from Masora's /api/sources to status labels.
 */
function mapSourcesToStatus(sources) {
  const map = {};
  if (!Array.isArray(sources)) return map;
  for (const s of sources) {
    map[s.kind] = s.status === "connected" ? "connected" : "reconnect";
  }
  return map;
}

/**
 * Fetches the OAuth authorize URL from Masora and opens it in the system browser.
 * If the fetch fails or the URL is invalid, falls back to opening /admin instead.
 *
 * Returns {ok, via, status} where:
 *   via: "authorize" (opened authorize_url) or "admin" (fallback to /admin)
 *   status: HTTP status or error type
 */
async function connectProvider({ provider, baseUrl, token, shell, fetchImpl } = {}) {
  if (!isValidProvider(provider)) {
    return { ok: false, error: "Unknown provider" };
  }
  const url = String(baseUrl).replace(/\/+$/, "");
  const installPath = buildInstallUrl(provider);
  const fetchUrl = `${url}${installPath}`;
  const f = typeof fetchImpl === "function" ? fetchImpl : (...a) => fetch(...a);

  let installRes;
  let installStatus;
  try {
    installRes = await f(fetchUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    installStatus = installRes.status;
  } catch (err) {
    // Network error or timeout
    console.warn(`oauth ${provider}: install fetch failed`, err && err.message);
    shell.openExternal(`${url}/admin`).catch(() => {});
    return { ok: true, via: "admin", status: "error" };
  }

  // If not 200, fallback to admin
  if (installStatus !== 200) {
    console.warn(`oauth ${provider}: install returned ${installStatus}`);
    shell.openExternal(`${url}/admin`).catch(() => {});
    return { ok: true, via: "admin", status: installStatus };
  }

  let body;
  try {
    body = await installRes.json();
  } catch {
    console.warn(`oauth ${provider}: install response not JSON`);
    shell.openExternal(`${url}/admin`).catch(() => {});
    return { ok: true, via: "admin", status: 200 };
  }

  const authorizeUrl = body && body.authorize_url ? String(body.authorize_url) : null;
  if (!authorizeUrl || !authorizeUrl.startsWith("https://")) {
    console.warn(`oauth ${provider}: no valid authorize_url`, authorizeUrl);
    shell.openExternal(`${url}/admin`).catch(() => {});
    return { ok: true, via: "admin", status: 200 };
  }

  shell.openExternal(authorizeUrl).catch(() => {});
  return { ok: true, via: "authorize", status: 200 };
}

module.exports = {
  OAUTH_PROVIDERS,
  PROVIDER_MAP,
  isValidProvider,
  buildInstallUrl,
  mapSourcesToStatus,
  connectProvider,
};
