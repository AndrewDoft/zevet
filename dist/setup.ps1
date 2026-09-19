# zevet setup (Windows)
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Asks for the three things it cannot guess, pulls the current client from the
# hub, verifies every file before it goes anywhere near its final location, and
# wires the hooks into a repo. Re-running it repairs an install.

param(
  [string]$Hub,
  # The MASTER SECRET, not the hub's token. They are different values now: the
  # secret is what the team shares and it never leaves this machine, while
  # everything that talks to the hub presents SHA-256("zevet-auth\0" || secret).
  # client/secret.mjs is the specification.
  [string]$Secret,
  [string]$Name,
  [string]$Repo
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "zevet: $msg" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 — the shell the README tells people to use — writes a
# UTF-8 BOM with `Set-Content -Encoding UTF8`. Node's JSON.parse rejects a
# leading U+FEFF, and every reader of config.json swallows that error and falls
# back to defaults. MEASURED: the Windows teammate silently never appeared on
# the board, and updates never installed, while setup printed "Done."
# UTF8Encoding($false) is BOM-less on both 5.1 and 7.
function Write-Utf8NoBom($path, $text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

# A build-file name we are willing to write. The hub is trusted to ship client
# code; it is NOT trusted to choose where on the machine that code lands.
# Join-Path does not normalise "..", so `{"name":"..\..\Desktop\evil.lnk"}`
# resolved outside the client directory and -OutFile wrote there. Over plain
# HTTP that is anyone on the network, aimed at a new teammate who has not yet
# got any reason to trust anything.
function Test-SafeName($name) {
  if ([string]::IsNullOrEmpty($name)) { return $false }
  if ($name.Length -gt 64) { return $false }
  if ($name.Contains("..")) { return $false }
  return $name -match '^[A-Za-z0-9][A-Za-z0-9._-]*$'
}

# --- Node ---------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js is not on your PATH. Install Node 20 or newer from https://nodejs.org and run this again."
}
$major = [int](((& node --version) -replace '^v','') -split '\.')[0]
if ($major -lt 20) { Fail "Node $major is too old. zevet needs Node 20 or newer." }

# --- What we need from the person ---------------------------------------
if (-not $Hub)    { $Hub    = Read-Host "Hub URL (ask Andrew)" }
if (-not $Secret) { $Secret = Read-Host "Master secret (ask Andrew)" }
if (-not $Name)   { $Name   = Read-Host "Your name on the board (e.g. michael)" }
$Hub = $Hub.TrimEnd('/')
if (-not $Hub -or -not $Secret -or -not $Name) { Fail "hub, master secret and name are all required." }

# --- Derive the token this machine will present --------------------------
# INLINED, NOT IMPORTED, for the same reason setup.sh inlines it: at this point
# there is either no ~/.zevet/client at all or a stale pre-cutover one, and
# deriving with an old copy of the rule is the silent-wrong-credential failure
# the whole scheme exists to avoid. The drift that inlining invites is covered
# by a test rather than by hoping — test/client.test.mjs extracts the program
# between the markers below out of BOTH setup scripts, asserts the two are
# byte-identical, runs one, and compares the answer with deriveAuthToken() from
# client/secret.mjs.
#
# Single-quoted so PowerShell expands nothing inside it: the program contains
# `$` nowhere, but a double-quoted string here would be one careless edit away
# from silently interpolating a variable into a cryptographic constant. The
# backslash in "zevet-auth\0" is literal to PowerShell (its escape character is
# the backtick) and a NUL to Node, which is what is wanted.
# zevet:derive:start
$deriveJs = 'const c=require("node:crypto");const s=String(process.argv[process.argv.length-1]||"").trim().replace(/\s+/g,"").toLowerCase();if(!/^[0-9a-f]+$/.test(s)||s.length<48||s.length%2!==0){console.log("BAD");}else{console.log(c.createHash("sha256").update(Buffer.from("zevet-auth\0","utf8")).update(Buffer.from(s,"hex")).digest("hex"));}'
# zevet:derive:end

# ⚠️ THE PROGRAM GOES THROUGH A FILE, NOT THROUGH `node -e`. MEASURED on
# PowerShell 7 against a real hub: `& node -e '<program>' $Secret` runs, and
# PowerShell's native-argument parser STRIPS every double quote out of the
# program on the way to node. What node received was
#   const c=require(node:crypto);const s=String(process.argv[1]||).trim()...
# which is a SyntaxError. node exited non-zero having written nothing to stdout,
# so $Token was empty, `$Token -eq "BAD"` was false, and setup carried on and
# asked the hub for the manifest with an empty credential -- reported to the
# person as "could not reach the hub, or the token was rejected", which names
# the wrong problem entirely. Escaping the quotes as \" would fix the call and
# make this program's text differ from setup.sh's, which is the drift the test
# exists to prevent. A file is the only route that keeps both true.
$deriveFile = Join-Path ([System.IO.Path]::GetTempPath()) ("zevet-derive-" + [guid]::NewGuid().ToString("N") + ".cjs")
Write-Utf8NoBom $deriveFile $deriveJs
try {
  $Token = (& node $deriveFile $Secret) | Select-Object -First 1
} finally {
  Remove-Item $deriveFile -Force -ErrorAction SilentlyContinue
}
# Empty is checked as carefully as "BAD": an empty token is what a derivation
# that FAILED looks like, and carrying on with one produces a 401 that blames
# the hub.
if (-not $Token -or $Token -eq "BAD") {
  Fail "that does not look like a zevet master secret. It is 48 or more hex characters (0-9, a-f) - check you pasted the whole thing."
}

if ($Hub -notmatch '^https://' -and $Hub -notmatch '^http://(127\.0\.0\.1|localhost)') {
  Write-Host ""
  Write-Host "  Note: $Hub is plain HTTP." -ForegroundColor Yellow
  Write-Host "  The token and everything zevet reports travel unencrypted, and anyone" -ForegroundColor Yellow
  Write-Host "  who can alter traffic on the way can replace the client code this" -ForegroundColor Yellow
  Write-Host "  installs. Fine on a trusted LAN; not fine on cafe wifi." -ForegroundColor Yellow
  Write-Host ""
}

# ZEVET_HOME is honoured here too — setup.sh already respected it, and the two
# disagreeing meant the installer could not find what setup had written.
$home_ = if ($env:ZEVET_HOME) { $env:ZEVET_HOME } else { Join-Path $env:USERPROFILE ".zevet" }
$clientDir = Join-Path $home_ "client"
$staging = Join-Path $home_ "incoming"
New-Item -ItemType Directory -Force -Path $clientDir | Out-Null
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# --- Pull the current client --------------------------------------------
Write-Host "Fetching the current client from $Hub ..."
$headers = @{ "x-zevet-token" = $Token }
try {
  $manifest = Invoke-RestMethod -Uri "$Hub/dist/manifest.json" -Headers $headers -TimeoutSec 20 -MaximumRedirection 0
} catch {
  Fail "could not reach the hub, or the token was rejected. Check both with Andrew.`n       ($($_.Exception.Message))"
}
if (-not $manifest.files) { Fail "the hub did not return a usable manifest." }

# Validate the WHOLE manifest before fetching any of it.
foreach ($f in $manifest.files) {
  if (-not (Test-SafeName $f.name)) { Fail "the hub offered a file name this installer will not write: '$($f.name)'. Nothing was installed." }
  if ($f.sha256 -notmatch '^[0-9a-f]{64}$') { Fail "'$($f.name)' has no usable checksum. Nothing was installed." }
}

# Download and verify into staging; only then move into place.
$moves = @()
foreach ($f in $manifest.files) {
  $tmp = Join-Path $staging $f.name
  try {
    Invoke-WebRequest -Uri "$Hub/dist/$($f.name)" -Headers $headers -OutFile $tmp -TimeoutSec 30 -MaximumRedirection 0
  } catch {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    Fail "could not download $($f.name). Nothing was installed."
  }
  $got = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $f.sha256.ToLower()) {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    Fail "$($f.name) did not match the hub's checksum. Nothing was installed."
  }
  $moves += @{ From = $tmp; To = (Join-Path $clientDir $f.name) }
  Write-Host "  ok  $($f.name)"
}
foreach ($m in $moves) { Move-Item -Path $m.From -Destination $m.To -Force }
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

# --- Remember the settings ----------------------------------------------
# The SECRET is stored; the derived token is not stored at all, because every
# client re-derives it on each run and two stored copies are two things that can
# disagree. Still written through Write-Utf8NoBom — see its comment: PowerShell
# 5.1's `Set-Content -Encoding UTF8` writes a BOM and every reader of this file
# chokes on it. Only the CONTENTS of the object change here, never how it lands.
$cfg = @{ hub = $Hub; secret = $Secret; actor = $Name } | ConvertTo-Json
Write-Utf8NoBom (Join-Path $home_ "config.json") $cfg
Write-Utf8NoBom (Join-Path $home_ "manifest.json") ($manifest | ConvertTo-Json -Depth 5)
Write-Utf8NoBom (Join-Path $home_ "last-check") ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString())

# The master secret is now sitting in a home directory, which is a bigger deal
# than the token was: it is also the document key. Restrict it to this user; on
# a shared or domain machine the default ACL is more generous.
try {
  $acl = Get-Acl (Join-Path $home_ "config.json")
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")
  $acl.SetAccessRule($rule)
  Set-Acl (Join-Path $home_ "config.json") $acl
} catch {
  Write-Host "  (could not restrict config.json permissions: $($_.Exception.Message))" -ForegroundColor DarkGray
}

# Verify what we wrote is actually readable by the thing that reads it.
# JSON.parse(readFileSync(...)) — NOT require(). require() strips a BOM, so a
# check written that way cannot detect the exact failure this check exists for.
$check = & node -e "const fs=require('fs');try{const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(c.actor||'')}catch(e){process.stdout.write('PARSE_FAILED:'+e.message)}" (Join-Path $home_ "config.json")
if ($check -like "PARSE_FAILED*") { Fail "wrote config.json but Node cannot read it back: $check" }

Write-Host ""
Write-Host "zevet $($manifest.version) installed to $home_"

# --- Wire up a repo ------------------------------------------------------
if (-not $Repo) { $Repo = Read-Host "Path to the repo you'll be working in (blank to skip)" }
if ($Repo) {
  if (-not (Test-Path $Repo)) { Fail "no such directory: $Repo" }
  & node (Join-Path $clientDir "install.mjs") $Repo
  Write-Host ""
  Write-Host "Done. Start Claude Code in $Repo and you'll show up on the board."
} else {
  Write-Host ""
  Write-Host "Skipped the repo. When you're ready, run:"
  Write-Host "  node `"$clientDir\install.mjs`" <path-to-repo>"
}

# Deliberately not echoing the MASTER SECRET back: this line gets pasted into
# chat, and the secret is also the document key.
Write-Host "The board: $Hub/?token=<the derived token printed below>"
Write-Host "Updates install themselves from the hub; there's nothing to re-download."

# --- The line the hub operator needs -------------------------------------
# The derived token IS printed, and that is a considered trade rather than an
# oversight. Without it there is no way to complete the cutover: the hub
# compares what clients send against its own ZEVET_TOKEN, so somebody has to be
# able to read the derived value off a machine that has the secret. It is
# strictly less dangerous than the secret -- it opens the hub and nothing else,
# and in particular it decrypts no documents -- but it is still a credential, so
# it is fenced off rather than mixed into the chatty output above.
Write-Host ""
Write-Host "--- hub operator only ------------------------------------------"
Write-Host "ZEVET_TOKEN=$Token"
Write-Host "That is the derived token. Set it on the hub, restart the hub, and"
Write-Host "every machine that has re-run this script will be let in. Anyone still"
Write-Host "on a pre-cutover install gets a 401 from that moment; there is no"
Write-Host "dual-accept window, on purpose (see client/secret.mjs)."
Write-Host "Do NOT paste the master secret anywhere the hub can read it."
Write-Host "----------------------------------------------------------------"
