#!/usr/bin/env bash
# zevet setup (macOS / Linux)
#
#   bash setup.sh
#
# Asks for the three things it cannot guess, pulls the current client from the
# hub, verifies every file before it goes anywhere near its final location, and
# wires the hooks into a repo. Re-running it repairs an install.
set -euo pipefail

fail() { printf 'zevet: %s\n' "$1" >&2; exit 1; }

# --- Node ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is not on your PATH. Install Node 20 or newer from https://nodejs.org and run this again."
major="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "$major" -ge 20 ] || fail "Node $major is too old. zevet needs Node 20 or newer."

# --- What we need from the person ---------------------------------------
# The second thing this asks for is the MASTER SECRET, not the hub's token.
# They are different values now: the secret is what the team shares, and it
# never leaves this machine. Everything that talks to the hub presents
# SHA-256("zevet-auth\0" || secret) instead. client/secret.mjs is the
# specification; the derivation is repeated below rather than imported, because
# it is needed to fetch the client and the client is not on disk yet.
HUB="${1:-${ZEVET_HUB:-}}"
SECRET="${2:-${ZEVET_SECRET:-}}"
NAME="${3:-${ZEVET_ACTOR:-}}"
REPO="${4:-}"

[ -n "$HUB" ]    || { printf 'Hub URL (ask Andrew): '; read -r HUB; }
[ -n "$SECRET" ] || { printf 'Master secret (ask Andrew): '; read -r SECRET; }
[ -n "$NAME" ]   || { printf 'Your name on the board (e.g. kai): '; read -r NAME; }
HUB="${HUB%/}"
[ -n "$HUB" ] && [ -n "$SECRET" ] && [ -n "$NAME" ] || fail "hub, master secret and name are all required."

# --- Derive the token this machine will present --------------------------
# INLINED, NOT IMPORTED, and the drift that invites is covered by a test rather
# than by hoping: test/client.test.mjs extracts the program between the markers
# below out of BOTH setup scripts, runs it, and asserts the answer equals
# deriveAuthToken() from client/secret.mjs for a fixed secret. Importing the
# real module was the other option and it is worse here — at this point in the
# script there is either no ~/.zevet/client at all (a first install) or a stale
# one from before the cutover, and deriving with an old copy of the rule is
# exactly the silent-wrong-credential failure this whole scheme is trying to
# avoid. `node` is already a hard requirement above.
#
# Validation lives in the snippet too: a truncated paste that derived a
# different token would show up as "the board is empty and nobody knows why".
# It prints BAD rather than exiting non-zero, because `set -e` would otherwise
# kill the script with no message of its own.
#
# ⚠️ IT READS THE LAST ARGUMENT, NOT argv[1]. This exact text also runs on
# Windows, and there it is delivered as a FILE rather than through `node -e`
# (setup.ps1 explains why it has to be). `node -e PROG SECRET` puts the secret
# at argv[1]; `node prog.cjs SECRET` puts the SCRIPT PATH there and the secret
# at argv[2]. MEASURED: reading argv[1] derived a token from the temp file's own
# path on Windows, which is not hex, so it printed BAD and told the person their
# secret was malformed when it was fine. The last argument is the secret under
# both delivery mechanisms, and test/client.test.mjs runs the program BOTH ways.
# zevet:derive:start
TOKEN="$(node -e 'const c=require("node:crypto");const s=String(process.argv[process.argv.length-1]||"").trim().replace(/\s+/g,"").toLowerCase();if(!/^[0-9a-f]+$/.test(s)||s.length<48||s.length%2!==0){console.log("BAD");}else{console.log(c.createHash("sha256").update(Buffer.from("zevet-auth\0","utf8")).update(Buffer.from(s,"hex")).digest("hex"));}' "$SECRET")"
# zevet:derive:end
# Empty is checked as carefully as BAD. An empty token is what a derivation that
# FAILED looks like, and carrying on with one produces a 401 the person reads as
# "the hub rejected my secret" when nothing was ever derived from it. (This is
# not hypothetical: the PowerShell half of this pair did exactly that until it
# stopped passing the program on the command line — see setup.ps1.)
[ -n "$TOKEN" ] && [ "$TOKEN" != "BAD" ] || fail "that does not look like a zevet master secret. It is 48 or more hex characters (0-9, a-f) — check you pasted the whole thing."

case "$HUB" in
  https://*|http://127.0.0.1*|http://localhost*) ;;
  *)
    printf '\n  Note: %s is plain HTTP.\n' "$HUB" >&2
    printf '  The token and everything zevet reports travel unencrypted, and anyone\n' >&2
    printf '  who can alter traffic on the way can replace the client code this\n' >&2
    printf '  installs. Fine on a trusted LAN; not fine on cafe wifi.\n\n' >&2
    ;;
esac

HOME_DIR="${ZEVET_HOME:-$HOME/.zevet}"
CLIENT_DIR="$HOME_DIR/client"
STAGING="$HOME_DIR/incoming"
mkdir -p "$CLIENT_DIR" "$STAGING"
# The MASTER SECRET ends up in here, which is a bigger deal than the token was:
# it is also the document key. Do not leave it group/world readable.
chmod 700 "$HOME_DIR" 2>/dev/null || true

cleanup_staging() { rm -rf "$STAGING"; }
trap cleanup_staging EXIT

# --- Pull the current client --------------------------------------------
printf 'Fetching the current client from %s ...\n' "$HUB"
MANIFEST="$STAGING/manifest.json"
# --proto -all,https,http and no -L: a redirect would carry the x-zevet-token
# header to wherever it points (only Authorization and Cookie are stripped on
# a cross-origin redirect), handing the team secret to a third party.
if ! curl -fsS --max-time 20 -H "x-zevet-token: $TOKEN" "$HUB/dist/manifest.json" -o "$MANIFEST"; then
  fail "could not reach the hub, or the token was rejected. Check both with Andrew."
fi

# Validate the WHOLE manifest before fetching any of it. A name is a plain
# filename with no separator in it; anything else chooses where on this machine
# the hub's code lands, and `$CLIENT_DIR/$name` obeys "../" without complaint.
# Real targets for that are ~/.zshrc and ~/.claude/settings.json, which is
# persistent code execution rather than a stray file.
if ! names="$(node -e '
const m = require(process.argv[1]);
if (!m || !Array.isArray(m.files)) { console.error("not shaped like a manifest"); process.exit(1); }
const ok = (n) => typeof n === "string" && n.length > 0 && n.length <= 64 && !n.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n);
for (const f of m.files) {
  if (!ok(f && f.name)) { console.error("refusing the file name " + JSON.stringify(f && f.name)); process.exit(1); }
  if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) { console.error((f.name) + " has no usable checksum"); process.exit(1); }
}
console.log(m.files.map((f) => f.name).join("\n"));
' "$MANIFEST")"; then
  fail "the hub offered a manifest this installer will not act on. Nothing was installed."
fi

# Download and verify into staging; only then move into place.
while IFS= read -r name; do
  [ -n "$name" ] || continue
  want="$(node -e 'const m=require(process.argv[1]);const f=m.files.find(x=>x.name===process.argv[2]);console.log(f?f.sha256:"")' "$MANIFEST" "$name")"
  tmp="$STAGING/$name"
  curl -fsS --max-time 30 -H "x-zevet-token: $TOKEN" "$HUB/dist/$name" -o "$tmp" \
    || fail "could not download $name. Nothing was installed."
  got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    fail "$name did not match the hub's checksum. Nothing was installed."
  fi
  printf '  ok  %s\n' "$name"
done <<< "$names"

while IFS= read -r name; do
  [ -n "$name" ] || continue
  mv -f "$STAGING/$name" "$CLIENT_DIR/$name"
done <<< "$names"

# --- Remember the settings ----------------------------------------------
# The SECRET is what is stored, and the derived token is not stored at all —
# every client re-derives it on each run. Writing both would mean two places
# that can disagree, and the one that is easy to edit by hand is the wrong one.
node -e '
const fs = require("fs");
const [home, hub, secret, actor, manifest] = process.argv.slice(1);
fs.writeFileSync(home + "/config.json", JSON.stringify({ hub, secret, actor }, null, 2) + "\n", { mode: 0o600 });
fs.copyFileSync(manifest, home + "/manifest.json");
fs.writeFileSync(home + "/last-check", String(Date.now()));
' "$HOME_DIR" "$HUB" "$SECRET" "$NAME" "$MANIFEST"
chmod 600 "$HOME_DIR/config.json" 2>/dev/null || true

# Verify what we wrote is readable by the thing that reads it.
# JSON.parse(readFileSync(...)) — NOT require(). require() strips a BOM, so a
# check written that way cannot detect the failure this check exists for.
check="$(node -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(c.actor||"")}catch(e){process.stdout.write("PARSE_FAILED:"+e.message)}' "$HOME_DIR/config.json")"
case "$check" in PARSE_FAILED*) fail "wrote config.json but Node cannot read it back: $check";; esac

version="$(node -e 'console.log(require(process.argv[1]).version)' "$HOME_DIR/manifest.json")"
printf '\nzevet %s installed to %s\n' "$version" "$HOME_DIR"

# --- Wire up a repo ------------------------------------------------------
[ -n "$REPO" ] || { printf "Path to the repo you'll be working in (blank to skip): "; read -r REPO; }
if [ -n "$REPO" ]; then
  [ -d "$REPO" ] || fail "no such directory: $REPO"
  node "$CLIENT_DIR/install.mjs" "$REPO"
  printf '\nDone. Start Claude Code in %s and you will show up on the board.\n' "$REPO"
else
  printf '\nSkipped the repo. When you are ready, run:\n'
  printf '  node "%s/install.mjs" <path-to-repo>\n' "$CLIENT_DIR"
fi

# Deliberately not echoing the MASTER SECRET back: this line gets pasted into
# chat, and the secret is also the document key.
printf 'The board: %s/?token=<the derived token printed below>\n' "$HUB"
printf "Updates install themselves from the hub; there's nothing to re-download.\n"

# --- The line the hub operator needs -------------------------------------
# The derived token IS printed, and that is a considered trade rather than an
# oversight. Without it there is no way to complete the cutover: the hub
# compares what clients send against its own ZEVET_TOKEN, so somebody has to be
# able to read the derived value off a machine that has the secret. It is
# strictly less dangerous than the secret — it opens the hub and nothing else,
# and in particular it does not decrypt a single document — but it is still a
# credential, so it is fenced off below rather than mixed into the chatty
# output above.
printf '\n--- hub operator only ------------------------------------------\n'
printf 'ZEVET_TOKEN=%s\n' "$TOKEN"
printf 'That is the derived token. Set it on the hub, restart the hub, and\n'
printf 'every machine that has re-run this script will be let in. Anyone still\n'
printf 'on a pre-cutover install gets a 401 from that moment; there is no\n'
printf 'dual-accept window, on purpose (see client/secret.mjs).\n'
printf 'Do NOT paste the master secret anywhere the hub can read it.\n'
printf -- '----------------------------------------------------------------\n'
