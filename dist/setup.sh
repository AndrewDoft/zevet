#!/usr/bin/env bash
# zevet setup (macOS / Linux)
#
#   bash setup.sh
#
# Asks for the three things it cannot guess, pulls the current client from the
# hub, verifies every file against the hub's manifest, and wires the hooks into
# a repo. Re-running it is how you repair an install; it overwrites cleanly.
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

HOME_DIR="${ZEVET_HOME:-$HOME/.zevet}"
CLIENT_DIR="$HOME_DIR/client"
mkdir -p "$CLIENT_DIR"

# --- Pull the current client --------------------------------------------
printf 'Fetching the current client from %s ...\n' "$HUB"
MANIFEST="$HOME_DIR/manifest.incoming.json"
if ! curl -fsS --max-time 20 -H "x-zevet-token: $TOKEN" "$HUB/dist/manifest.json" -o "$MANIFEST"; then
  fail "could not reach the hub, or the token was rejected. Check both with Andrew."
fi

# node is already required, so use it rather than depending on jq being present.
names="$(node -e 'const m=require(process.argv[1]);console.log(m.files.map(f=>f.name).join("\n"))' "$MANIFEST")"

while IFS= read -r name; do
  [ -n "$name" ] || continue
  want="$(node -e 'const m=require(process.argv[1]);const f=m.files.find(x=>x.name===process.argv[2]);console.log(f?f.sha256:"")' "$MANIFEST" "$name")"
  dest="$CLIENT_DIR/$name"
  curl -fsS --max-time 30 -H "x-zevet-token: $TOKEN" "$HUB/dist/$name" -o "$dest" \
    || fail "could not download $name. Nothing was installed."
  got="$(shasum -a 256 "$dest" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    rm -f "$dest"
    fail "$name did not match the hub's checksum. Nothing was installed."
  fi
  printf '  ok  %s\n' "$name"
done <<< "$names"

# --- Remember the settings ----------------------------------------------
node -e '
const fs = require("fs");
const [home, hub, token, actor, manifest] = process.argv.slice(1);
fs.writeFileSync(home + "/config.json", JSON.stringify({ hub, token, actor }, null, 2) + "\n");
fs.copyFileSync(manifest, home + "/manifest.json");
fs.writeFileSync(home + "/last-check", String(Date.now()));
' "$HOME_DIR" "$HUB" "$TOKEN" "$NAME" "$MANIFEST"
rm -f "$MANIFEST"

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

printf 'The board: %s/?token=%s\n' "$HUB" "$TOKEN"
printf "Updates install themselves from the hub; there's nothing to re-download.\n"
