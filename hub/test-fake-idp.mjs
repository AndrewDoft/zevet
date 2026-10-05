// Test-only fake GitHub/Google upstream, gated on ZEVET_TEST_HOOKS=1 — the
// SAME flag desktop/main.js uses to record shell.openExternal instead of
// actually opening a browser (see its own comment, and
// scripts/drive/README.md). Together the two let a REAL Electron app drive a
// REAL hub through a COMPLETE GitHub device-flow or Google web-flow sign-in
// with no real GitHub, no real Google, and no browser window ever opening —
// see test/setup-sso-e2e.test.mjs, which is the only caller.
//
// ⚠️ NEVER WIRED IN UNLESS THIS ENV VAR IS SET, and it is never set by the
// installer, by a normal launch, or by any other test file's hub — every
// other hub in this suite (and every real deployment) talks to the real
// github.com/oauth2.googleapis.com, because hub/server.mjs only calls this
// module's `fetchImpl` when `ZEVET_TEST_HOOKS === "1"` (checked once, at
// module load, in server.mjs itself).
//
// It stands in for exactly the two outbound calls github-auth.mjs and
// google-auth.mjs make to a real identity provider — the device-code mint,
// the access-token poll, the profile fetch, and the authorization-code
// exchange — and answers everything else (Resend, GitHub's public-email
// lookup) by falling through to the real `fetch`, so only the upstream that
// would otherwise need a human clicking "Authorize" in a real browser is
// faked.
export function makeFakeIdpFetch({ googleClientId }) {
  let ghPolls = 0;

  function jsonRes(status, body) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  }

  // A well-formed but unsigned id token: google-auth.mjs's readIdToken only
  // ever decodes claims from a token THIS PROCESS fetched directly over TLS
  // (see its own header comment on why that is safe) — this fake stands in
  // for that TLS fetch, not for the signature, so an unsigned payload is
  // exactly as trusted as the real thing would be at this call site.
  // A code of `claims:<base64url JSON>` overrides claims, so a test can be any Google account it likes.
  function fakeIdToken(code = "") {
    const extra = code.startsWith("claims:") ? JSON.parse(Buffer.from(code.slice(7), "base64url").toString()) : {};
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "accounts.google.com",
        aud: googleClientId,
        sub: "900002",
        email: "zevet-e2e-google@example.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...extra,
      }),
    ).toString("base64url");
    return `${header}.${payload}.fake-signature`;
  }

  return async function fakeIdpFetch(url, init) {
    const u = String(url);

    if (u === "https://github.com/login/device/code") {
      return jsonRes(200, {
        device_code: "fake-device-code",
        user_code: "FAKE-CODE",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=FAKE-CODE",
        interval: 1,
        expires_in: 900,
      });
    }
    if (u === "https://github.com/login/oauth/access_token") {
      // One pending answer before approving, so the poll loop itself
      // (desktop/github-signin.js's wait()) is actually exercised rather
      // than succeeding on the very first call.
      ghPolls += 1;
      if (ghPolls < 2) return jsonRes(200, { error: "authorization_pending" });
      return jsonRes(200, { access_token: "fake-gh-access-token" });
    }
    if (u === "https://api.github.com/user") {
      return jsonRes(200, { login: "zevet-e2e-github", id: 900001, email: null });
    }
    if (u === "https://api.github.com/user/emails") {
      // What the fake GitHub account's verified addresses are — a JSON array
      // of strings in ZEVET_TEST_GH_EMAILS, empty by default. Read here (only
      // ever under ZEVET_TEST_HOOKS) so the link tests can decide whether the
      // hub has evidence that this login and the fake Google account are one.
      const list = JSON.parse(process.env.ZEVET_TEST_GH_EMAILS || "[]");
      return jsonRes(200, list.map((email, i) => ({ email, primary: i === 0, verified: true, visibility: null })));
    }
    if (u === "https://oauth2.googleapis.com/token") {
      return jsonRes(200, { id_token: fakeIdToken(new URLSearchParams(String(init.body)).get("code") || "") });
    }

    return fetch(url, init);
  };
}
