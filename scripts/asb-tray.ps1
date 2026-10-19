# ASB tray for Windows (plan 14.6, Appendix B part 2). The HKCU Run value starts it hidden:
# powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<root>\scripts\asb-tray.ps1" "<node.exe>"
# It starts the engine with no window, starts it again after a crash (at most 5 times in 10 minutes),
# shows the ASB icon, and stops the engine on Quit ASB.
param([string]$Node = '')

$ErrorActionPreference = 'Stop'
$mutex = New-Object System.Threading.Mutex($false, 'Local\ASB-tray')
if (-not $mutex.WaitOne(0)) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$root = Split-Path -Parent $PSScriptRoot
if (-not $Node -or -not (Test-Path -LiteralPath $Node -PathType Leaf)) { $Node = (Get-Command node.exe).Source }
$script:engine = $null
$script:failures = @()
$script:quitting = $false

function Start-Engine {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $Node
  $info.Arguments = '--disable-warning=ExperimentalWarning "' + (Join-Path $root 'scripts\asb.mjs') + '" engine run'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.EnvironmentVariables['ASB_ENGINE_LOG'] = '1'
  $script:engine = [System.Diagnostics.Process]::Start($info)
}

function Read-Runtime {
  $file = Join-Path $env:LOCALAPPDATA 'asb\run\service.json'
  return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
}

function Invoke-Engine([string]$route) {
  $runtime = Read-Runtime
  $base = 'http://127.0.0.1:' + $runtime.port
  $headers = @{ 'X-ASB-Source-Token' = $runtime.sourceToken; 'Origin' = $base }
  return Invoke-RestMethod -Method Post -Uri ($base + $route) -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 10
}

function Stop-Tray {
  $timer.Stop()
  $icon.Visible = $false
  $icon.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
}

$bitmap = [System.Drawing.Bitmap]::FromFile((Join-Path $root 'assets\icons\asb-tray-32.png'))
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$icon.Text = 'ASB'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$pair = $menu.Items.Add('Copy phone pairing link')
$quit = $menu.Items.Add('Quit ASB')
$icon.ContextMenuStrip = $menu

$pair.add_Click({
  try {
    Set-Clipboard -Value (Invoke-Engine '/api/phone/pairing').uri
  } catch {
    $message = 'ASB cannot make a pairing link.'
    try { $detail = ($_.ErrorDetails.Message | ConvertFrom-Json).error; if ($detail) { $message = $detail } } catch {}
    $icon.ShowBalloonTip(5000, 'ASB', $message, [System.Windows.Forms.ToolTipIcon]::Warning)
  }
})

$quit.add_Click({
  $script:quitting = $true
  try { Invoke-Engine '/api/engine/stop' | Out-Null } catch {}
  if ($script:engine -and -not $script:engine.WaitForExit(10000)) { try { $script:engine.Kill() } catch {} }
  Stop-Tray
})

# A stop (exit code 0) ends the tray too; a crash starts the engine again, at most 5 times in 10 minutes.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  if ($script:quitting -or -not $script:engine.HasExited) { return }
  if ($script:engine.ExitCode -eq 0) { Stop-Tray; return }
  $now = Get-Date
  $script:failures = @($script:failures | Where-Object { ($now - $_).TotalMinutes -lt 10 }) + $now
  if ($script:failures.Count -gt 5) {
    $script:quitting = $true
    $icon.ShowBalloonTip(10000, 'ASB', 'ASB stopped after repeated failures.', [System.Windows.Forms.ToolTipIcon]::Error)
    $timer.Stop()
    $end = New-Object System.Windows.Forms.Timer
    $end.Interval = 10000
    $end.add_Tick({ $end.Stop(); Stop-Tray })
    $end.Start()
    return
  }
  Start-Engine
})

Start-Engine
$icon.Visible = $true
$timer.Start()
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
