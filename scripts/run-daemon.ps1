# Codex Rich Presence — launcher with Windows Job Object cleanup.
#
# Key guarantees:
#   1. Only one daemon at a time. If another is alive, this script attaches
#      to stop it instead of spawning a second.
#   2. Closing the console (any path: keypress, Ctrl+C, X button, taskkill)
#      tears the Job Object down → OS kills the daemon. No orphans.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$distIndex = Join-Path $root 'dist\index.js'
$lockFile = Join-Path $env:LOCALAPPDATA 'codex-rich-presence\instance.lock'

Write-Host 'Codex Rich Presence' -ForegroundColor Cyan

if (-not (Test-Path $distIndex)) {
    Write-Host 'Build missing. Run: npm install && npm run build' -ForegroundColor Yellow
    [Console]::ReadKey($true) | Out-Null
    exit 1
}

function Get-Daemons {
    $pattern = ('*' + ($distIndex -replace '\\', '\') + '*')
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $_.CommandLine -like $pattern -and $_.CommandLine -notlike '*--status*'
    }
}

function Stop-Daemons {
    param([array]$Daemons)
    foreach ($d in $Daemons) {
        Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}

# ---- Single-instance: attach-and-stop mode -----------------------------------
$existing = Get-Daemons
if ($existing) {
    Write-Host 'Rich Presence is already running.'
    & node $distIndex --status
    Write-Host ''
    Write-Host 'Press any key to stop Rich Presence.' -ForegroundColor Gray
    [Console]::ReadKey($true) | Out-Null
    Stop-Daemons -Daemons $existing
    Write-Host 'Stopped.'
    Start-Sleep -Milliseconds 500
    exit 0
}

# ---- Create a Job Object that kills children when this PS exits --------------
Add-Type -Namespace Win32 -Name JobApi -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetInformationJobObject(
    IntPtr hJob, int JobObjectInformationClass,
    IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);

[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr hObject);
'@

$JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
$JobObjectExtendedLimitInformation = 9

$job = [Win32.JobApi]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }

# JOBOBJECT_EXTENDED_LIMIT_INFORMATION size: 144 on x64, 112 on x86.
# LimitFlags sits at offset 16 in both layouts.
$size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {
    for ($i = 0; $i -lt $size; $i += 4) {
        [System.Runtime.InteropServices.Marshal]::WriteInt32($ptr, $i, 0)
    }
    [System.Runtime.InteropServices.Marshal]::WriteInt32(
        $ptr, 16, $JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    if (-not [Win32.JobApi]::SetInformationJobObject(
            $job, $JobObjectExtendedLimitInformation, $ptr, $size)) {
        throw 'SetInformationJobObject failed'
    }
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
}

# ---- Spawn the daemon and assign it to the job ------------------------------
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = "`"$distIndex`""
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

if (-not [Win32.JobApi]::AssignProcessToJobObject($job, $proc.Handle)) {
    $proc.Kill()
    [Win32.JobApi]::CloseHandle($job) | Out-Null
    throw 'AssignProcessToJobObject failed'
}

Start-Sleep -Milliseconds 1500
& node $distIndex --status
Write-Host ''
Write-Host 'Press any key to stop Rich Presence.' -ForegroundColor Gray
Write-Host 'Closing this window also stops it.' -ForegroundColor DarkGray

try {
    [Console]::ReadKey($true) | Out-Null
} catch {
    # ReadKey can throw if the console is being torn down (e.g. window closed).
}

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
[Win32.JobApi]::CloseHandle($job) | Out-Null
Write-Host 'Stopped.'
Start-Sleep -Milliseconds 500
