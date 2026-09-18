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
HUB="${1:-${ZEVET_HUB:-}}"
TOKEN="${2:-${ZEVET_TOKEN:-}}"
NAME="${3:-${ZEVET_ACTOR:-}}"
REPO="${4:-}"

[ -n "$HUB" ]   || { printf 'Hub URL (ask Andrew): '; read -r HUB; }
[ -n "$TOKEN" ] || { printf 'Shared token (ask Andrew): '; read -r TOKEN; }
[ -n "$NAME" ]  || { printf 'Your name on the board (e.g. kai): '; read -r NAME; }
HUB="${HUB%/}"
[ -n "$HUB" ] && [ -n "$TOKEN" ] && [ -n "$NAME" ] || fail "hub, token and name are all required."

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
# The token ends up in here. Do not leave it group/world readable.
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
node -e '
const fs = require("fs");
const [home, hub, token, actor, manifest] = process.argv.slice(1);
fs.writeFileSync(home + "/config.json", JSON.stringify({ hub, token, actor }, null, 2) + "\n", { mode: 0o600 });
fs.copyFileSync(manifest, home + "/manifest.json");
fs.writeFileSync(home + "/last-check", String(Date.now()));
' "$HOME_DIR" "$HUB" "$TOKEN" "$NAME" "$MANIFEST"
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

# Deliberately not echoing the token back: this line gets pasted into chat.
printf 'The board: %s/?token=<the token you were given>\n' "$HUB"
printf "Updates install themselves from the hub; there's nothing to re-download.\n"
