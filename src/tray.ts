import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLogger } from './utils/logger';
import { statusFilePath } from './utils/status-file';

export interface TrayOptions {
  iconPath?: string;
  /** Command string written to HKCU Run when the user enables "Start with Windows". */
  startupCommand: string;
  onQuit: () => void;
}

const RUN_REGISTRY_NAME = 'CodexRichPresence';

interface TrayHandle {
  stop: () => void;
}

/**
 * Spawns a hidden PowerShell that owns a Win32 NotifyIcon (tray icon).
 * The tray process polls the status file (written by the daemon) to refresh
 * its tooltip + menu label. Emits line-based commands on stdout we parse here:
 *   CMD:QUIT    — user clicked Quit
 */
export function startTray(options: TrayOptions): TrayHandle {
  const log = getLogger();
  const scriptPath = writeTrayScript(options.iconPath, options.startupCommand);

  const child: ChildProcess = spawn(
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      if (line === 'CMD:QUIT') {
        log.info('tray: quit requested');
        options.onQuit();
      } else {
        log.debug({ line }, 'tray: unexpected message');
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) log.warn({ text: text.slice(0, 500) }, 'tray: stderr');
  });

  child.on('exit', (code) => {
    log.warn({ code }, 'tray: powershell exited');
  });

  return {
    stop: (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    },
  };
}

function psEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function writeTrayScript(
  iconPath: string | undefined,
  startupCommand: string,
): string {
  const dir = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'codex-rich-presence',
  );
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'tray.ps1');
  const statusFile = statusFilePath();

  const iconPs = psEscape(iconPath ?? '');
  const statusPs = psEscape(statusFile);
  const startupCommandPs = psEscape(startupCommand);
  const runKeyName = RUN_REGISTRY_NAME;

  const body = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'SilentlyContinue'
$statusFile = '${statusPs}'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

# Build a tray-sized icon (16x16) from the source ICO with high-quality
# bicubic resampling. Using the raw Icon would let Windows downscale with
# nearest-neighbour, which looks blocky in the system tray.
function New-TrayIcon {
  param([string] $Path, [int] $Size = 16)
  $src = New-Object System.Drawing.Icon($Path)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src.ToBitmap(), 0, 0, $Size, $Size)
  $g.Dispose()
  $src.Dispose()
  $handle = $bmp.GetHicon()
  return [System.Drawing.Icon]::FromHandle($handle)
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = 'Codex Rich Presence'
$iconPath = '${iconPs}'
if ($iconPath -and (Test-Path $iconPath)) {
  try { $notifyIcon.Icon = New-TrayIcon -Path $iconPath -Size 16 }
  catch { $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application }
} else {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$titleItem = $menu.Items.Add('Codex Rich Presence')
$titleItem.Enabled = $false
$titleItem.Font = New-Object System.Drawing.Font($titleItem.Font, [System.Drawing.FontStyle]::Bold)

$stateItem = $menu.Items.Add('Starting...')
$stateItem.Enabled = $false

$modelItem = $menu.Items.Add('')
$modelItem.Enabled = $false
$modelItem.Visible = $false

$discordItem = $menu.Items.Add('')
$discordItem.Enabled = $false
$discordItem.Visible = $false

[void] $menu.Items.Add('-')

$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
$runValueName = '${runKeyName}'
$startupCommand = '${startupCommandPs}'

$startupItem = New-Object System.Windows.Forms.ToolStripMenuItem('Start with Windows')
$startupItem.CheckOnClick = $true
try {
  $existing = Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
  if ($existing) { $startupItem.Checked = $true }
} catch { }
[void] $menu.Items.Add($startupItem)

$startupItem.Add_Click({
  try {
    if (-not (Test-Path $runKey)) {
      New-Item -Path $runKey -Force | Out-Null
    }
    if ($startupItem.Checked) {
      Set-ItemProperty -Path $runKey -Name $runValueName -Value $startupCommand -Type String
    } else {
      Remove-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "Failed to update startup setting:\`n\$(\$_.Exception.Message)",
      'Codex Rich Presence', 'OK', 'Warning') | Out-Null
    $startupItem.Checked = -not $startupItem.Checked
  }
})

[void] $menu.Items.Add('-')

$quitItem = $menu.Items.Add('Quit')

$notifyIcon.ContextMenuStrip = $menu

$quitItem.Add_Click({
  [Console]::Out.WriteLine('CMD:QUIT')
  [Console]::Out.Flush()
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.Add_MouseDoubleClick({
  # Surface the tooltip as a balloon on double-click — tiny UX touch.
  $notifyIcon.ShowBalloonTip(2000, 'Codex Rich Presence', $stateItem.Text, [System.Windows.Forms.ToolTipIcon]::Info)
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  try {
    if (Test-Path $statusFile) {
      $line = [System.IO.File]::ReadAllText($statusFile, [System.Text.UTF8Encoding]::new()).Trim()
      if ($line) {
        $parts = $line -split '\\|', 3
        $stateItem.Text = $parts[0]
        if ($parts.Length -gt 1 -and $parts[1]) {
          $modelItem.Text = $parts[1]
          $modelItem.Visible = $true
        } else {
          $modelItem.Visible = $false
        }
        if ($parts.Length -gt 2 -and $parts[2]) {
          $discordItem.Text = $parts[2]
          $discordItem.Visible = $true
        } else {
          $discordItem.Visible = $false
        }
        $tooltipSource = ($parts -join ' | ')
        $tooltipLen = [Math]::Min(63, $tooltipSource.Length)
        $notifyIcon.Text = 'Codex RP | ' + $tooltipSource.Substring(0, $tooltipLen)
      }
    }
  } catch { }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
`;

  fs.writeFileSync(scriptPath, body, 'utf8');
  return scriptPath;
}
