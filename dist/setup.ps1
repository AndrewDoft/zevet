# zevet setup (Windows)
#
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Asks for the three things it cannot guess, pulls the current client from the
# hub, verifies every file against the hub's manifest, and wires the hooks into
# a repo. Re-running it is how you repair an install; it overwrites cleanly.

param(
  [string]$Hub,
  [string]$Token,
  [string]$Name,
  [string]$Repo
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "zevet: $msg" -ForegroundColor Red; exit 1 }

# --- Node ---------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Fail "Node.js is not on your PATH. Install Node 20 or newer from https://nodejs.org and run this again." }
$major = [int](((& node --version) -replace '^v','') -split '\.')[0]
if ($major -lt 20) { Fail "Node $major is too old. zevet needs Node 20 or newer." }

# --- What we need from the person ---------------------------------------
if (-not $Hub)   { $Hub   = Read-Host "Hub URL (ask Andrew)" }
if (-not $Token) { $Token = Read-Host "Shared token (ask Andrew)" }
if (-not $Name)  { $Name  = Read-Host "Your name on the board (e.g. michael)" }
$Hub = $Hub.TrimEnd('/')
if (-not $Hub -or -not $Token -or -not $Name) { Fail "hub, token and name are all required." }

$home_ = Join-Path $env:USERPROFILE ".zevet"
$clientDir = Join-Path $home_ "client"
New-Item -ItemType Directory -Force -Path $clientDir | Out-Null

# --- Pull the current client --------------------------------------------
Write-Host "Fetching the current client from $Hub ..."
$headers = @{ "x-zevet-token" = $Token }
try {
  $manifest = Invoke-RestMethod -Uri "$Hub/dist/manifest.json" -Headers $headers -TimeoutSec 20
} catch {
  Fail "could not reach the hub, or the token was rejected. Check both with Andrew.`n       ($($_.Exception.Message))"
}

foreach ($f in $manifest.files) {
  $dest = Join-Path $clientDir $f.name
  Invoke-WebRequest -Uri "$Hub/dist/$($f.name)" -Headers $headers -OutFile $dest -TimeoutSec 30
  $got = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $f.sha256.ToLower()) {
    Remove-Item $dest -Force -ErrorAction SilentlyContinue
    Fail "$($f.name) did not match the hub's checksum. Nothing was installed."
  }
  Write-Host "  ok  $($f.name)"
}

# --- Remember the settings ----------------------------------------------
@{ hub = $Hub; token = $Token; actor = $Name } | ConvertTo-Json | Set-Content -Path (Join-Path $home_ "config.json") -Encoding UTF8
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $home_ "manifest.json") -Encoding UTF8
Set-Content -Path (Join-Path $home_ "last-check") -Value ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Encoding UTF8

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

Write-Host "The board: $Hub/?token=$Token"
Write-Host "Updates install themselves from the hub; there's nothing to re-download."
