# Codex Rich Presence — installer Windows
# Creates a scheduled task that runs at user logon with auto-restart on failure.
#
# Usage:
#   .\install.ps1                                 # installs with default name
#   .\install.ps1 -Exe "D:\bin\codex-rich-presence.exe"
#   .\install.ps1 -Uninstall

[CmdletBinding()]
param(
    [string]$TaskName = "CodexRichPresence",
    [string]$Exe = (Join-Path $PSScriptRoot "bin\codex-rich-presence.exe"),
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName'."
    exit 0
}

if (-not (Test-Path $Exe)) {
    throw "Executable not found at '$Exe'. Build it first with `pnpm pkg`."
}

$action    = New-ScheduledTaskAction -Execute $Exe
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' (-> $Exe). It will run at next logon."
Write-Host "Start now: Start-ScheduledTask -TaskName $TaskName"
