// Settings/Connections defects found in the free-model settings.md audit,
// verified against real code and fixed. board.ts and settings.tsx import
// zustand/React and touch `window`/`document` at module scope, so they
// cannot be required outside a DOM — same situation test/ask-tool.test.mjs
// documents for desktop/main.js outside Electron. Source assertions on the
// same precedent.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const src = (rel) => readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

describe("Account section settles out of \"loading…\" on failure (P1)", () => {
  const board = src("board/src/lib/board.ts");
  // refreshWhoami's .then/.catch used to leave `who.state` at null on a 401
  // or a network error, with a comment claiming the section reports that —
  // it did not: AccountSection only ever left "loading…" on a null state.
  const fetchStart = board.indexOf('fetch("/auth/whoami"');
  const fn = board.slice(fetchStart, board.indexOf("setWhoBusy:", fetchStart));

  test("a non-ok or failed fetch still sets a non-null who.state", () => {
    assert.match(fn, /state:\s*r\s*&&\s*r\.ok\s*\?\s*r\s*:\s*\{\s*ok:\s*false\s*\}/);
    assert.match(fn, /\.catch\(\(\)\s*=>\s*set\(\{\s*who:\s*\{\s*state:\s*\{\s*ok:\s*false\s*\}/);
  });

  test("AccountSection renders that failure explicitly, with a Retry", () => {
    const settings = src("board/src/components/settings.tsx");
    assert.match(settings, /whoState\.ok === false/);
    assert.match(settings, /onClick=\{\(\) => refreshWhoami\(\)\}/);
  });
});

describe("Google connect no longer strands a person on \"waiting…\" (P1)", () => {
  const settings = src("board/src/components/settings.tsx");
  const box = settings.slice(settings.indexOf("function GoogleConnectBox"), settings.indexOf("function AccountSection"));

  test("the browser URL main returned is kept in state", () => {
    assert.match(box, /phase:\s*"waiting";\s*url\?:\s*string/);
    assert.match(box, /setState\(\{\s*phase:\s*"waiting",\s*url:\s*r\.url\s*\}\)/);
  });

  test("it is rendered as an openable link, not silently dropped", () => {
    assert.match(box, /window\.open\(state\.url,\s*"_blank",\s*"noopener,noreferrer"\)/);
  });
});

describe("Disconnect GitHub/Google appears for an actually signed-in person (P1)", () => {
  const settings = src("board/src/components/settings.tsx");
  const account = settings.slice(settings.indexOf("function AccountSection"));

  test("the disconnect branch is gated on login/localSession, not on shared", () => {
    // hub's whoami sets shared:!sess, so a real personal session is ALWAYS
    // shared:false — gating the whole block on `shared` meant a signed-in
    // person could never reach the disconnect branch at all.
    assert.match(account, /if \(login \|\| localSession\) \{/);
  });
});

// Andrew, verbatim: "the copy invite is different from what is actually
// emailed, since the copy invite doesnt contain the key." Replaced the old
// per-provider mailto fallback (Copy invite/Email, google-only, no key) with
// PendingRow: every pending row — any provider — gets Resend, which is the
// SAME /auth/allow call the mailer runs on, so Copy can only ever hand back
// exactly what would be (or was) emailed.
describe("email invitations: Resend/Copy are the mailer's own call, for every provider", () => {
  const settings = src("board/src/components/settings.tsx");
  const row = settings.slice(settings.indexOf("function PendingRow"), settings.indexOf("function AccountSection"));

  test("no per-provider gate: Resend is offered on any pending row, not just a google identity", () => {
    assert.doesNotMatch(row, /provider === "google"/);
    assert.match(row, /canManage && pending/);
  });

  test("Resend and Copy both come from /auth/allow's own response — no client-built invite string", () => {
    assert.match(row, /fetch\("\/auth\/allow"/);
    assert.match(row, /copyText\(state\.text\)/);
    // The old client-side composer (a bare "Join <team> on Zevet" line with
    // no key) is gone outright, not just unused.
    assert.doesNotMatch(settings, /function inviteLine/);
    assert.doesNotMatch(settings, /function mailtoInvite/);
  });

  test("a failed send is shown as failed, never silently folded into Sent", () => {
    assert.match(row, /phase === "failed"/);
    assert.match(row, /var\(--bad\)/);
  });

  test("the download link, team name and key are generated in ONE place (hub/mailer.mjs), not duplicated client-side", () => {
    const mailer = src("hub/mailer.mjs");
    assert.match(mailer, /https:\/\/usemasora\.com\/zevet/);
    assert.match(mailer, /Key: \$\{key\}/);
    assert.doesNotMatch(mailer, /sha256|\bsize\b/i);
  });
});

describe("creating a team via Google Workspace: the owner's domain toggle", () => {
  const settings = src("board/src/components/settings.tsx");
  const account = settings.slice(settings.indexOf("function AccountSection"));

  test("the toggle only ever appears for the owner, and only once Google has offered a domain", () => {
    assert.match(account, /if \(owner && availableDomain\) \{/);
  });

  test("checked reflects the ACTIVE rule (googleDomain), not merely that one is available", () => {
    assert.match(account, /checked=\{googleDomain === availableDomain\}/);
  });

  test("toggling posts to /auth/domain with the owner's own domain, or \"\" to clear it — never a typed value", () => {
    assert.match(account, /onChange=\{\(ev\) => changeDomain\(ev\.target\.checked \? availableDomain : ""\)\}/);
    assert.match(account, /fetch\("\/auth\/domain"/);
  });
});

describe("the update download's Cancel button is not a decoration (P1)", () => {
  const jobProgress = src("board/src/components/assistant-ui/elements/job-progress.tsx");

  test("the X only renders when the caller actually wired a cancel", () => {
    assert.match(jobProgress, /\{!finished && onCancel && \(/);
  });
});
