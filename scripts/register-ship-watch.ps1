# Registers the auto-ship watcher as a Scheduled Task: every 10 minutes, hidden, no window.
#
#   pwsh -NoProfile -File scripts/register-ship-watch.ps1 [-Checkout C:\dev\GitHub\zevet-ship-runner] [-Remove]
#
# -Checkout is a clone of AndrewDoft/zevet on branch main that nothing else edits: the watcher fast-forwards
# it before every run, and ship keeps its own worktree next to it (../zevet-ship).
# The window is hidden the way the other tasks here do it: wscript //B run-hidden.vbs launches node with
# window style 0, so nothing flashes (a console app started by Task Scheduler in a session would).
# Power conditions are set on purpose: the Task Scheduler defaults do not run on battery and drop a missed
# trigger, and the task would report Ready the whole time it never ran. Check LastTaskResult, not State.
param(
  [string]$Checkout = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$TaskName = 'ZevetShipWatch',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($Remove) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; return }

$node = (Get-Command node).Source
$vbs = Join-Path $HOME '.claude\bin\run-hidden.vbs'
$watch = Join-Path $Checkout 'scripts\ship-watch.mjs'
foreach ($p in $vbs, $watch) { if (-not (Test-Path $p)) { throw "missing $p" } }

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B `"$vbs`" `"$node`" `"$watch`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Ships zevet when origin/main has releasable commits and ci is green (scripts/ship-watch.mjs)' -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
"log: $env:LOCALAPPDATA\Zevet\ship-watch.log"
